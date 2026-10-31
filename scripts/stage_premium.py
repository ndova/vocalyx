
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

Bila venv tak ada (fresh clone / PC builder lain, karena scripts/*-venv
di-gitignore), otomatis ambil bundel prebuilt premium-<versi>.zip + .sha256
dari vocalyx-releases (bisa dioverride --fetch-url, dukung file://), lalu
verifikasi sha + manifest (+ impor bila interpreter 3.11 tersedia).
Pakai --no-fetch untuk memaksa gagal cepat bila venv tak ada.

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





RELEASES = "https://github.com/ndova/vocalyx-releases/releases/download"

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


def _run(code: str, args: list[str], cwd: Path | None = None,
         python: str | None = None) -> tuple[int, str, str]:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONNOUSERSITE"] = "1"
    proc = subprocess.run(
        [python or sys.executable, "-c", code, *args],
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


def verify_imports(dest: Path, roots: list[str], python: str | None = None) -> tuple[bool, str]:
    rc, out, err = _run(VERIFY, [str(dest), *roots], python=python)
    return rc == 0 and "verify-ok" in out, (err or out).strip()[-800:]


def app_version() -> str:
    try:
        data = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        return str(data.get("version") or "0.0.0")
    except Exception:
        return "0.0.0"


def bundle_url(version: str) -> str:
    return f"{RELEASES}/runtime-{version}/premium-{version}.zip"


def runtime_python() -> str | None:
    for cand in (ROOT / "build" / "runtime" / "python.exe",
                 Path(os.environ.get("APPDATA") or "") / "VocaLyx" / "runtime" / "python.exe"):
        if cand.is_file():
            return str(cand)
    return None


def fetch_bundle(out: Path, url: str) -> bool:
    import urllib.request
    out.mkdir(parents=True, exist_ok=True)
    log(f"venv tidak ada, ambil bundel prebuilt: {url}")
    try:
        tmp = out / "premium-bundle.zip.part"
        req = urllib.request.Request(url, headers={"User-Agent": "VocaLyx/0.1 bundler"})
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f, length=1 << 20)
        sha_url = url + ".sha256"
        log(f"verifikasi {sha_url}")
        with urllib.request.urlopen(sha_url, timeout=60) as r:
            expect = r.read().decode("ascii", "replace").split()[0]
        h = hashlib.sha256()
        with open(tmp, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != expect:
            log(f"GAGAL: sha256 tidak cocok (dapat {h.hexdigest()[:16]}...)")
            tmp.unlink(missing_ok=True)
            return False
        import zipfile
        with zipfile.ZipFile(tmp) as z:
            bad = [n for n in z.namelist() if n.startswith("/") or ".." in n.split("/")]
            if bad:
                log(f"GAGAL: entri zip tidak aman: {bad[:3]}")
                tmp.unlink(missing_ok=True)
                return False
            z.extractall(out)
        tmp.unlink(missing_ok=True)
    except Exception as e:
        log(f"GAGAL: unduh bundel premium ({e}); sediakan {SERVICES['spotify']['venv'].relative_to(ROOT)} "
            f"atau unggah premium-<versi>.zip + .sha256 ke vocalyx-releases")
        return False
    man = _load_manifest(out)
    if not man.get("spotify") or not man.get("deezer"):
        log("GAGAL: manifest bundel tak lengkap (spotify/deezer)")
        return False
    py311 = runtime_python()
    if py311:
        for name, spec in SERVICES.items():
            roots = list((man[name] or {}).get("roots") or [])
            ok, detail = verify_imports(out / name, roots, python=py311)
            if not ok:
                log(f"GAGAL: verifikasi impor bundel {name}: {detail}")
                return False
    else:
        log("PERINGATAN: tanpa interpreter 3.11, impor bundel tak diverifikasi (percaya sha256+manifest)")
    log(f"bundel prebuilt OK: {', '.join(sorted(man))}")
    return True


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

    
    
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        from _pyc_hardening import check_tree_hardened, compile_tree_hardened
        from _vault_stage import fresh_share, key_loader_text, vault_stems
        loader_text = (ROOT / "python-engine" / "vx_vault.py").read_text(encoding="utf-8")
        share = fresh_share()
        (dest / "vx_vault.py").write_text(
            key_loader_text(loader_text, share), encoding="utf-8")
        n, left = compile_tree_hardened(dest)
        issues = check_tree_hardened(dest)
    finally:
        try:
            sys.path.remove(str(ROOT / "scripts"))
        except ValueError:
            pass
    if left:
        log(f"GAGAL: kompilasi {name}: {left}")
        shutil.rmtree(dest, ignore_errors=True)
        return False
    if issues:
        log(f"GAGAL: hardening {name} bocor:")
        for i in issues[:10]:
            log(f"  - {i}")
        shutil.rmtree(dest, ignore_errors=True)
        return False
    log(f"{name}: hardening OK ({n} .pyc, tanpa docstring/path absolut)")
    if share.encode("ascii") not in (dest / "vx_vault.pyc").read_bytes():
        log(f"GAGAL: loader {name} tak mengandung shareA (penguncian gagal)")
        shutil.rmtree(dest, ignore_errors=True)
        return False
    if list(dest.rglob("*.py")):
        log(f"GAGAL: masih ada .py di {name} setelah kompilasi")
        shutil.rmtree(dest, ignore_errors=True)
        return False

    
    glue_stems = [g.stem for g in glues]
    done, verr = vault_stems(dest, glue_stems, share)
    if verr:
        log(f"GAGAL: vault {name}: {verr}")
        shutil.rmtree(dest, ignore_errors=True)
        return False
    log(f"{name}: vault OK ({done} .pyv)")

    
    
    loader_pyc = dest / "vx_vault.pyc"
    rt_env = {k: v for k, v in os.environ.items()
              if k not in ("PYTHONPATH", "DEEZER_ARL")}
    rt_env["PYTHONPATH"] = str(dest)
    rt_env["PYTHONNOUSERSITE"] = "1"

    def _rt(vault: Path, args: list[str]) -> tuple[int, str, str]:
        proc = subprocess.run(
            [sys.executable, str(loader_pyc), str(vault), *args],
            capture_output=True, text=True, timeout=300,
            cwd=str(dest), env=rt_env)
        return proc.returncode, proc.stdout, proc.stderr

    probes: list[tuple[str, list[str], int, str]] = []
    if name == "deezer":
        probes = [("deezer_arl_test", [], 0, "ARL_KOSONG"),
                  ("deezer_download", ["--help"], 0, "track")]
    else:
        probes = [("spotify_premium_auth", ["--help"], 0, "out"),
                  ("spotify_premium_download", ["--help"], 0, "track")]
    for stem, pargs, want_rc, want_in in probes:
        rc, out_s, err_s = _rt(dest / f"{stem}.pyv", pargs)
        if rc != want_rc or want_in not in (out_s + err_s):
            log(f"GAGAL: roundtrip {name}/{stem} (rc={rc}): {(out_s + err_s).strip()[-300:]}")
            shutil.rmtree(dest, ignore_errors=True)
            return False
    log(f"{name}: roundtrip loader OK ({len(probes)} probe)")

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
        "glue": sorted(g.name.replace(".py", ".pyv") for g in glues),
        "vault": {"version": 1, "files": sorted(f"{s}.pyv" for s in glue_stems)},
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
            stem = g.replace(".py", "")
            if not (dest / f"{stem}.pyv").is_file():
                log(f"GAGAL: vault {name}/{stem}.pyv tidak ada")
                bad += 1
            if (dest / f"{stem}.pyc").is_file():
                log(f"GAGAL: plaintext {name}/{stem}.pyc masih ada (vault bocor)")
                bad += 1
        loader = dest / "vx_vault.pyc"
        if not loader.is_file():
            log(f"GAGAL: loader {name}/vx_vault.pyc tidak ada")
            bad += 1
        for stem in [g.replace(".py", "") for g in spec["glue"]]:
            v = dest / f"{stem}.pyv"
            if v.is_file() and not v.read_bytes()[:8] == b"VXVAULT1":
                log(f"GAGAL: {name}/{stem}.pyv bukan vault valid")
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
    ap.add_argument("--fetch-url", default="", help="URL premium-<versi>.zip (default rilis resmi; dukung file://)")
    ap.add_argument("--no-fetch", action="store_true", help="jangan unduh bundel; gagal bila venv tak ada")
    args = ap.parse_args()

    if args.check:
        return check(args.out)

    missing_venv = [name for name, spec in SERVICES.items()
                    if not _site_packages(spec["venv"]) ]
    if missing_venv and not args.no_fetch:
        url = args.fetch_url or bundle_url(app_version())
        return 0 if fetch_bundle(args.out, url) else 1

    if sys.version_info[:2] != PY_TAG:
        log(f"GAGAL: stage dari venv butuh Python {PY_TAG[0]}.{PY_TAG[1]} (runtime), sekarang "
            f"{sys.version_info[0]}.{sys.version_info[1]}; tanpa venv pakai mode fetch "
            f"(otomatis bila venv tak ada) atau jalankan via build\\runtime\\python.exe")
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    for name, spec in SERVICES.items():
        if not stage_service(name, spec, args.out, args.force):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
