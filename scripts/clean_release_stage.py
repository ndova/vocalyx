
"""Bersihkan resource engine basi sebelum Tauri menyalin staging.

Tauri menyalin `bundle.resources` dengan cara MERGE, bukan replace: folder tujuan
tidak dikosongkan dulu. Akibatnya kalau sebuah build pernah menyalin source
`python-engine/*.py`, file-file itu TETAP ADA berdampingan dengan `.pyc` hasil
build berikutnya - dan installerDiam-diam akan tetap membocorkan source Python
plaintext, persis kebocoran yang ditutup oleh `compile_engine_stage`.

Jadi folder resource dibersihkan dulu, baru Tauri menyalin staging bytecode.
Jalankan lewat `beforeBuildCommand` Tauri (lihat `tauri.conf.json`).

Pemakaian:
  python scripts/clean_release_stage.py            # bersihkan
  python scripts/clean_release_stage.py --check    # hanya verifikasi, exit 1 bila bocor
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI_TARGET = ROOT / "src-tauri" / "target" / "release"
STAGE = ROOT / "build" / "engine"



RESOURCE_DIRS = [TAURI_TARGET / "python-engine", TAURI_TARGET / "_up_" / "python-engine"]
LEAK_SUFFIX = ".py"


def log(msg: str) -> None:
    print(f"[clean-stage] {msg}", flush=True)


def clean(dry: bool = False) -> int:
    removed = 0
    for d in RESOURCE_DIRS:
        if not d.exists():
            continue
        
        if STAGE.resolve() == d.resolve():
            log(f"LEWATI: {d} menunjuk staging, jangan dihapus")
            continue
        n = sum(1 for _ in d.rglob("*") if _.is_file())
        if dry:
            log(f"[dry-run] hapus {d} ({n} file)")
        else:
            shutil.rmtree(d, ignore_errors=True)
            log(f"hapus resource basi {d} ({n} file)")
        removed += 1
    if not removed:
        log("tidak ada resource basi untuk dibersihkan")
    return removed


def check() -> int:
    """Gagal kalau masih ada `.py` plaintext di folder resource hasil build."""
    leaked: list[str] = []
    for d in RESOURCE_DIRS:
        if not d.exists():
            continue
        leaked += [
            f"{d.relative_to(ROOT).as_posix()}/{p.relative_to(d).as_posix()}"
            for p in sorted(d.rglob(f"*{LEAK_SUFFIX}"))
            if p.is_file()
        ]
    if leaked:
        log(f"GAGAL: {len(leaked)} source .py plaintext masih ikut terkbundel:")
        for p in leaked:
            log(f"  - {p}")
        log("jalankan build ulang; kalau tetap ada, folder resource tidak kebersihkan")
        return 1
    for d in RESOURCE_DIRS:
        if d.exists():
            n = sum(1 for _ in d.rglob("*.pyc") if _.is_file())
            log(f"OK {d.relative_to(ROOT).as_posix()}: {n} bytecode .pyc, 0 source .py")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Bersihkan/verifikasi resource engine hasil build")
    ap.add_argument("--check", action="store_true", help="hanya verifikasi, jangan hapus")
    ap.add_argument("--dry-run", action="store_true", help="tampilkan rencana tanpa menghapus")
    args = ap.parse_args()
    if args.check:
        return check()
    clean(args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
