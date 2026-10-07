#!/usr/bin/env python3
"""Stage paket premium (librespot Spotify / deemix Deezer) untuk bundel.

Latar masalah: venv lokal (`scripts/*-venv`) di-gitignore dan tak pernah ikut
terbundel, padahal backend Test Login Spotify, Connect (Zeroconf), download
Premium, dan ARL Deezer semua menjalankan glue script lewat venv itu. Di mesin
pengguna akhirnya "connect failed" karena python/venv-nya memang tidak ada.

Script ini:
  1. menutup impor (import closure) glue script dari venv tsb - dgn
     site-packages sistem DIBUANG, jadi apa pun yang terimpor wajib berasal
     dari venv dan ikut tersalin;
  2. menyalin paket top-level tsb ke `build/premium/<service>/`;
  3. mengompilasi SEMUA source jadi `.pyc` legacy (`compileall -b`) lalu
     menghapus `.py` - konsisten kebijakan proteksi (tanpa source plaintext);
  4. memverifikasi paket staged bisa diimpor utuh oleh interpreter yang sama
     persis dengan runtime (site-packages sistem tetap dibuang);
  5. menyimpan `manifest.json` (fingerprints) supaya build berikutnya bisa
     skip kalau venv tidak berubah.

Hasilnya dihook sebagai resource Tauri `../build/premium` -> `premium`, dan
resolver `_premium_backend()` di vx_download.py menjalankannya dengan
`sys.executable` (python yang sama dipakai engine) + PYTHONPATH ke paketnya.

Pemakaian:
  python scripts/stage_premium.py            # stage (skip bila masih segar)
  python scripts/stage_premium.py --force    # paksa stage ulang
  python scripts/stage_premium.py --check    # verifikasi hasil, exit 1 bila baku

Dijalankan otomatis lewat `beforeBuildCommand` Tauri (lihat tauri.conf.json).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "build" / "premium"
PY_TAG = (3, 11)

SERVICES: dict[str, dict] = {
    "spotify": {
        "venv": ROOT / "scripts" / "spotify-venv",
        "glue": ["spotify_premium_download.py", "spotify_premium_auth.py"],
    },
    "deezer": {
        "venv": ROOT / "scripts" / "deezer-venv",
        "glue": ["deezer_download.py", "deezer_arl_test.py"],
    },
}

# Tutup impor glue script dgn site-packages sistem dibuang: setiap top-level
# non-stdlib yang terimpor WAJIB berasal dari venv (owned), selain itu = gagal.
DISCOVER = r"""
import ast, importlib, json, os, sys
site, = sys.argv[1:2]
glues = sys.argv[2:]
site = os.path.realpath(site)
def _under(p):
    try:
        return os.path.realpath(str(p)) == site or os.path.realpath(str(p)).startswith(site + os.sep)
    except Exception:
        return False
sys.path[:] = [site] + [p for p in sys.path
                        if p not in ("", None)
                        and "site-packages" not in str(p).lower()
                        and "dist-packages" not in str(p).lower()]
preloaded = set(sys.modules)
roots = []
for g in glues:
    tree = ast.parse(open(g, encoding="utf-8").read(), filename=g)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.append(node.module)
roots = [r for r in dict.fromkeys(roots) if r]
failed = {}
for r in roots:
    try:
        importlib.import_module(r)
    except BaseException as e:
        failed[r] = "%s: %s" % (type(e).__name__, e)
stdlib = set(getattr(sys, "stdlib_module_names", ()))
owned, foreign = set(), {}
for name, mod in list(sys.modules.items()):
    top = name.split(".")[0]
    if top in stdlib or top == "__main__" or name in preloaded:
        continue
    f = getattr(mod, "__file__", None)
    paths = [f] if f else list(getattr(mod, "__path__", ()) or ())
    if not paths:
        continue
    if any(p and _under(p) for p in paths):
        owned.add(top)
    else:
        foreign[name] = f or "<namespace>"
json.dump({"roots": roots, "owned": sorted(owned),
           "failed": failed, "foreign": foreign}, sys.stdout)
"""

# Verifikasi staged: hanya stdlib + paket staged yang boleh terlihat.
VERIFY = r"""
import importlib, sys
dest, = sys.argv[1:2]
roots = sys.argv[2:]
sys.path[:] = [dest] + [p for p in sys.path
                        if p not in ("", None)
                        and "site-packages" not in str(p).lower()
                        and "dist-packages" not in str(p).lower()]
for r in roots:
    importlib.import_module(r)
print("verify-ok")
"""


def log(msg: str) -> None:
    print(f"[stage-premium] {msg}", flush=True)


def _run(code: str, args: list[str], cwd: Path | None = None) -> tuple[int, str, str]:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONNOUSERSITE"] = "1"
    proc = subprocess.run(
        [sys.executable, "-c", code, *args],
        capture_output=True, text=True, timeout=300, cwd=str(cwd or ROOT), env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _site_packages(venv: Path) -> Path | None:
    for cand in (venv / "Lib" / "site-packages", *sorted((venv / "lib").glob("python*/site-packages"))):
        if cand.is_dir():
            return cand
    return None


def fingerprint(venv_sp: Path, glues: list[Path]) -> str:
    h = hashlib.sha256()
    for base in (venv_sp, *glues):
        files = [base] if base.is_file() else sorted(
            p for p in base.rglob("*")
            if p.is_file() and "__pycache__" not in p.parts
        )
        for p in files:
            st = p.stat()
            h.update(f"{p}|{st.st_size}|{st.st_mtime_ns}\n".encode("utf8", "replace"))
    return h.hexdigest()


def _load_manifest(out: Path) -> dict:
    try:
        return json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def verify_imports(dest: Path, roots: list[str]) -> tuple[bool, str]:
    rc, out, err = _run(VERIFY, [str(dest), *roots])
    return rc == 0 and "verify-ok" in out, (err or out).strip()[-800:]


def stage_service(name: str, spec: dict, out: Path, force: bool) -> bool:
    venv: Path = spec["venv"]
    glues = [ROOT / "scripts" / g for g in spec["glue"]]
    dest = out / name

    venv_sp = _site_packages(venv) if venv.is_dir() else None
    if not venv_sp:
        log(f"GAGAL: venv {venv.relative_to(ROOT)} tidak ada - jalankan pip install dulu")
        return False
    missing = [str(g.relative_to(ROOT)) for g in glues if not g.is_file()]
    if missing:
        log(f"GAGAL: glue script hilang: {missing}")
        return False

    fp = fingerprint(venv_sp, glues)
    man = _load_manifest(out).get(name) or {}
    if not force and dest.is_dir() and man.get("fingerprint") == fp and man.get("glue"):
        log(f"{name}: masih segar ({man.get('bytes', 0) // 1048576} MB), skip")
        return True

    rc, stdout, stderr = _run(DISCOVER, [str(venv_sp), *map(str, glues)])
    if rc != 0:
        log(f"GAGAL: penutup impor {name} error: {stderr.strip()[-800:]}")
        return False
    try:
        info = json.loads(stdout)
    except Exception as e:
        log(f"GAGAL: keluaran penutup impor {name} bukan JSON ({e}): {stdout[:400]}")
        return False
    if info["failed"]:
        log(f"GAGAL: venv {name} tak mandiri (impor gagal):")
        for k, v in info["failed"].items():
            log(f"  - {k}: {v}")
        return False
    if info["foreign"]:
        log(f"GAGAL: impor {name} bocor ke luar venv (tak bisa dibundel):")
        for k, v in list(info["foreign"].items())[:10]:
            log(f"  - {k}: {v}")
        return False
    if not info["owned"]:
        log(f"GAGAL: tidak ada paket non-stdlib dari venv {name}")
        return False

    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    for top in info["owned"]:
        src: Path | None = None
        for cand in (venv_sp / top, venv_sp / f"{top}.py",
                     venv_sp / f"{top}.pyd", venv_sp / f"{top}.so"):
            if cand.exists():
                src = cand
                break
        if src is None:
            log(f"GAGAL: {top} tidak ditemukan di {venv_sp.name}")
            shutil.rmtree(dest, ignore_errors=True)
            return False
        dst = dest / src.name
        if src.is_dir():
            shutil.copytree(src, dst,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(src, dst)
        copied += 1
    for g in glues:
        shutil.copy2(g, dest / g.name)

    rc, _, err = _run(
        "import compileall, sys; sys.exit(0 if compileall.compile_dir("
        "sys.argv[1], quiet=1, force=True, legacy=True) else 1)",
        [str(dest)],
    )
    if rc != 0:
        log(f"GAGAL: compileall {name}: {err.strip()[-600:]}")
        shutil.rmtree(dest, ignore_errors=True)
        return False
    leaked = list(dest.rglob("*.py"))
    for p in leaked:
        p.unlink()
    if list(dest.rglob("*.py")):
        log(f"GAGAL: masih ada .py di {name} setelah kompilasi")
        shutil.rmtree(dest, ignore_errors=True)
        return False

    ok, detail = verify_imports(dest, info["roots"])
    if not ok:
        log(f"GAGAL: verifikasi impor staged {name}: {detail}")
        shutil.rmtree(dest, ignore_errors=True)
        return False

    files = [p for p in dest.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    man_all = _load_manifest(out)
    man_all[name] = {
        "fingerprint": fp,
        "python": "%d.%d.%d" % sys.version_info[:3],
        "roots": info["roots"],
        "packages": copied,
        "files": len(files),
        "bytes": total,
        "glue": sorted(g.name.replace(".py", ".pyc") for g in glues),
    }
    (out / "manifest.json").write_text(
        json.dumps(man_all, indent=2, sort_keys=True), encoding="utf-8")
    log(f"{name}: {copied} paket, {len(files)} file, {total // 1048576} MB, verifikasi OK")
    return True


def check(out: Path) -> int:
    bad = 0
    if not (out / "manifest.json").is_file():
        log("GAGAL: manifest.json tidak ada (belum stage)")
        return 1
    for name, spec in SERVICES.items():
        dest = out / name
        if not dest.is_dir():
            log(f"GAGAL: {dest} tidak ada")
            bad += 1
            continue
        leaked = list(dest.rglob("*.py"))
        if leaked:
            log(f"GAGAL: {name} masih punya .py: {[p.name for p in leaked][:5]}")
            bad += 1
        for g in spec["glue"]:
            if not (dest / g.replace(".py", ".pyc")).is_file():
                log(f"GAGAL: glue {name}/{g.replace('.py', '.pyc')} tidak ada")
                bad += 1
        venv_sp = _site_packages(spec["venv"])
        if venv_sp:
            rc, stdout, stderr = _run(DISCOVER, [str(venv_sp), *map(str, (ROOT / 'scripts' / g for g in spec['glue']))])
            roots = json.loads(stdout)["roots"] if rc == 0 else []
            ok, detail = verify_imports(dest, roots) if roots else (False, "roots kosong")
            if not ok:
                log(f"GAGAL: verifikasi impor {name}: {detail}")
                bad += 1
    if bad:
        log(f"{bad} pemeriksaan gagal")
        return 1
    log("OK: semua paket staged lengkap, tanpa .py, impor terverifikasi")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage paket premium utk bundel installer")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="folder tujuan (default build/premium)")
    ap.add_argument("--force", action="store_true", help="abaikan cache freshness")
    ap.add_argument("--check", action="store_true", help="hanya verifikasi hasil stage")
    args = ap.parse_args()

    if sys.version_info[:2] != PY_TAG:
        log(f"GAGAL: jalankan dgn Python {PY_TAG[0]}.{PY_TAG[1]} (runtime), sekarang "
            f"{sys.version_info[0]}.{sys.version_info[1]}")
        return 1
    if args.check:
        return check(args.out)

    args.out.mkdir(parents=True, exist_ok=True)
    for name, spec in SERVICES.items():
        if not stage_service(name, spec, args.out, args.force):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
