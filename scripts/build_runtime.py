#!/usr/bin/env python3
"""Perakit runtime portable VocaLyx (Fase 2 bundler).

Menghasilkan satu folder `runtime/` yang berisi Python embeddable + dependensi
CPU + ffmpeg portable + source engine, supaya installer (Fase 3a) bisa jalan di
PC yang tidak punya Python, dan installer Lite (Fase 3b) bisa mengunduhnya.

Mengapa tidak pakai Python sistem: `find_python()` di src-tauri/src/engine.rs
mencari interpreter yang sudah punya torch. Untuk userPC bersih itu tidak ada,
jadi runtime harus ikut dipaketkan.

Torch dipasang dari indeks CPU resmi (--index-url https://download.pytorch.org/whl/cpu);
wheel CUDA ~4 GB tidak muat di installer dan tidak selalu ada GPU.

Pemakaian:
  python scripts/build_runtime.py                 # rakitan penuh (unduh ~1 GB)
  python scripts/build_runtime.py --staging-only # hanya staging source engine
  python scripts/build_runtime.py --dry-run      # rencana saja, tanpa unduh

Keluaran:
  build/engine/            source engine bersih (dipakai juga untuk Tauri resources)
  build/runtime/           runtime portable (Python + deps + ffmpeg + model)
  dist-runtime/runtime-cpu-<versi>.zip  +  .sha256
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENGINE_SRC = ROOT / "python-engine"
BUILD = ROOT / "build"
STAGE_ENGINE = BUILD / "engine"
RUNTIME_DIR = BUILD / "runtime"
DIST = ROOT / "dist-runtime"
CACHE = BUILD / "cache"

PY_VERSION = "3.11.9"
PY_EMBED_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
TORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"
TORCH_PIN = "torch==2.5.1"
FFMPEG_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
UVR_REPO = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models"
CPU_MODEL = "UVR-MDX-NET-Inst_HQ_4.onnx"

ENGINE_ENTRY = "server.py"
ENGINE_EXTRA_SCRIPTS = ("scripts/karaoke_best.py",)
EXCLUDE_NAMES = {
    "__pycache__", ".pytest_cache", ".mypy_cache", "tests", "tmp",
    ".gain-cache.json", "import_attr.json", "cig.dll", "cig.obj", "cig_wrapper.obj",
    "-", "Thumbs.db", ".DS_Store",
}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".obj", ".log")


def log(msg: str) -> None:
    print(f"[build-runtime] {msg}", flush=True)


def app_version() -> str:
    try:
        data = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        return str(data.get("version") or "0.0.0")
    except Exception:
        return "0.0.0"


def download(url: str, dest: Path, dry: bool = False) -> bool:
    if dest.is_file() and dest.stat().st_size > 0:
        log(f"pakai cache: {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")
        return True
    if dry:
        log(f"[dry-run] unduh {url} -> {dest}")
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"unduh {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "VocaLyx/0.1 bundler"})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, length=1 << 20)
    tmp.replace(dest)
    log(f"selesai: {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")
    return True


def write_pth(py_dir: Path) -> None:
    """Tulis ulang `python311._pth` agar runtime embeddable bisa pakai paket.

    Penting: begitu file `._pth` ada, Python **mengabaikan `PYTHONPATH`** dan
    hanya memakai path yang tertulis di sini. Makanya folder engine ikut
    didaftarkan sebagai `engine` - kalau tidak, `server.py` tidak akan pernah
    menemukan modul `vx_*` di sebelahnya.
    """
    pth = next(py_dir.glob("python*._pth"), None)
    if not pth:
        return
    lines = pth.read_text(encoding="utf-8").splitlines()
    seen: set[str] = set()
    kept: list[str] = []
    for ln in lines:
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        if s in ("Lib", "Lib\\site-packages", "engine", "import site") or "site-packages" in s:
            continue
        if s in seen:
            continue
        seen.add(s)
        kept.append(s)
    for s in ("Lib", "Lib\\site-packages", "engine", "import site"):
        if s not in seen:
            kept.append(s)
            seen.add(s)
    pth.write_text("\n".join(kept) + "\n", encoding="utf-8")
    log(f"{pth.name}: {kept}")


def install_engine_into_runtime() -> int:
    """Salin engine bersih ke dalam runtime supaya ikut saat runtime dipaket."""
    dst = RUNTIME_DIR / "engine"
    if dst.exists():
        shutil.rmtree(dst, ignore_errors=True)
    dst.mkdir(parents=True, exist_ok=True)
    copied = 0
    for p in sorted(STAGE_ENGINE.rglob("*")):
        rel = p.relative_to(STAGE_ENGINE)
        target = dst / rel
        if p.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
        copied += 1
    write_pth(RUNTIME_DIR)
    log(f"engine -> {dst} ({copied} file)")
    return copied


def clean_engine_stage(dry: bool = False) -> int:
    """Salin hanya file engine yang benar-benar dibutuh runtime."""
    if not dry and STAGE_ENGINE.exists():
        shutil.rmtree(STAGE_ENGINE, ignore_errors=True)
    STAGE_ENGINE.mkdir(parents=True, exist_ok=True)
    copied = 0
    for p in sorted(ENGINE_SRC.iterdir()):
        if p.name in EXCLUDE_NAMES or p.suffix in EXCLUDE_SUFFIX:
            continue
        if p.is_dir():
            continue
        dst = STAGE_ENGINE / p.name
        if dry:
            log(f"[dry-run] stage {p.name}")
        else:
            shutil.copy2(p, dst)
        copied += 1
    for rel in ENGINE_EXTRA_SCRIPTS:
        src = ENGINE_SRC / rel
        if not src.is_file():
            continue
        dst = STAGE_ENGINE / Path(rel).name
        if dry:
            log(f"[dry-run] stage {rel}")
        else:
            shutil.copy2(src, dst)
        copied += 1
    if not dry:
        scripts_dir = STAGE_ENGINE / "scripts"
        scripts_dir.mkdir(exist_ok=True)
        moved = STAGE_ENGINE / "karaoke_best.py"
        if moved.exists():
            shutil.move(str(moved), str(scripts_dir / "karaoke_best.py"))
    log(f"stage engine: {copied} file -> {STAGE_ENGINE}")
    return copied


def stage_ffmpeg(dry: bool = False) -> bool:
    dest_bin = RUNTIME_DIR / "ffmpeg" / "bin"
    if (dest_bin / "ffmpeg.exe").is_file() and (dest_bin / "ffprobe.exe").is_file():
        log("ffmpeg sudah ada di runtime")
        return True
    zpath = CACHE / "ffmpeg.zip"
    if not download(FFMPEG_URL, zpath, dry):
        return False
    tmp = BUILD / "_ffmpeg_tmp"
    if not dry and tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)
    if dry:
        return True
    with zipfile.ZipFile(zpath) as z:
        z.extractall(tmp)
    src_bin = next((p / "bin" for p in tmp.iterdir() if (p / "bin" / "ffmpeg.exe").is_file()), None)
    if not src_bin:
        log("GAGAL: struktur ffmpeg tidak dikenali")
        return False
    dest_bin.mkdir(parents=True, exist_ok=True)
    for exe in ("ffmpeg.exe", "ffprobe.exe"):
        s = src_bin / exe
        if s.is_file():
            shutil.copy2(s, dest_bin / exe)
    shutil.rmtree(tmp, ignore_errors=True)
    log(f"ffmpeg -> {dest_bin}")
    return True


def stage_model(dry: bool = False) -> bool:
    dest = RUNTIME_DIR / "models" / CPU_MODEL
    if dest.is_file():
        log("model CPU sudah ada")
        return True
    if dry:
        log(f"[dry-run] unduh model CPU {CPU_MODEL}")
        return True
    ok = download(f"{UVR_REPO}/{CPU_MODEL}", dest)
    if ok:
        log(f"model CPU -> {dest}")
    return ok


def run(cmd: list[str], cwd: Path | None = None) -> int:
    log("$ " + " ".join(cmd[:6]) + (" ..." if len(cmd) > 6 else ""))
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None)
    return proc.returncode


def install_python_deps(py: Path, dry: bool = False) -> bool:
    req = ENGINE_SRC / "requirements-cpu.txt"
    if dry:
        log("[dry-run] pip install torch (cpu) + requirements-cpu.txt")
        return True
    if run([str(py), "-m", "pip", "install", "--no-warn-script-location", "--upgrade",
            TORCH_PIN, "--index-url", TORCH_CPU_INDEX]) != 0:
        log("GAGAL: install torch CPU")
        return False
    if run([str(py), "-m", "pip", "install", "--no-warn-script-location", "-r", str(req)]) != 0:
        log("GAGAL: install requirements-cpu.txt")
        return False
    return True


def prepare_python(dry: bool = False) -> Path | None:
    py = RUNTIME_DIR / "python.exe"
    if py.is_file() and (RUNTIME_DIR / "Lib" / "site-packages").is_dir():
        log("python embeddable sudah ada")
        return py
    zpath = CACHE / f"python-{PY_VERSION}-embed.zip"
    if not download(PY_EMBED_URL, zpath, dry):
        return None
    if dry:
        return py
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(RUNTIME_DIR)
    getpip = CACHE / "get-pip.py"
    if not download(GET_PIP_URL, getpip, dry):
        return None
    if run([str(py), str(getpip), "--no-warn-script-location"]) != 0:
        log("GAGAL: bootstrap pip")
        return None
    (RUNTIME_DIR / "Lib" / "site-packages").mkdir(parents=True, exist_ok=True)
    return py


def zip_runtime(version: str, dry: bool = False) -> Path | None:
    if dry:
        log(f"[dry-run] zip runtime -> dist-runtime/runtime-cpu-{version}.zip")
        return None
    DIST.mkdir(parents=True, exist_ok=True)
    out = DIST / f"runtime-cpu-{version}.zip"
    log(f"zip runtime ({sum(f.stat().st_size for f in RUNTIME_DIR.rglob('*') if f.is_file()) / 1e6:.0f} MB) -> {out.name}")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(RUNTIME_DIR.rglob("*")):
            if p.is_file():
                z.write(p, Path("runtime") / p.relative_to(RUNTIME_DIR))
    h = hashlib.sha256()
    with open(out, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    sha = out.with_suffix(".sha256")
    sha.write_text(f"{h.hexdigest()}  {out.name}\n", encoding="ascii")
    bundle = BUILD / "runtime-bundle.zip"
    shutil.copy2(out, bundle)
    log(f"sha256: {h.hexdigest()[:16]}...")
    log(f"bundel installer (nama stabil): {bundle.name} ({bundle.stat().st_size / 1e6:.0f} MB)")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Rakit runtime portable VocaLyx")
    ap.add_argument("--staging-only", action="store_true", help="hanya staging source engine")
    ap.add_argument("--repack", action="store_true", help="stage ulang engine + zip, tanpa unduh ulang")
    ap.add_argument("--dry-run", action="store_true", help="tampilkan rencana tanpa mengunduh")
    args = ap.parse_args()

    version = app_version()
    log(f"runtime versi {version} {'[dry-run]' if args.dry_run else ''}")

    clean_engine_stage(args.dry_run)
    if args.staging_only:
        return 0

    if args.repack:
        install_engine_into_runtime()
        zip_runtime(version, args.dry_run)
        log("repack selesai")
        return 0

    py = prepare_python(args.dry_run)
    if args.dry_run:
        stage_ffmpeg(args.dry_run)
        stage_model(args.dry_run)
        install_python_deps(py or Path("python"), args.dry_run)
        zip_runtime(version, args.dry_run)
        log("dry-run selesai")
        return 0
    if not py:
        return 1
    if not install_python_deps(py):
        return 1
    stage_ffmpeg()
    stage_model()
    zip_runtime(version)
    log("runtime siap")
    return 0


if __name__ == "__main__":
    sys.exit(main())