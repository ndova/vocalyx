#!/usr/bin/env python3
"""Hardening + vault staging engine. Dijalankan via interpreter runtime 3.11.

Pemakaian:
  python scripts/harden_engine_stage.py <stage_dir> [--vault stem,stem]

Langkah: kunci loader (shareA acak) -> hardening .pyc -> cek bocor ->
vault stem terpilih -> trial impor via hook. Gagal keras (exit 1) bila ada
langkah tak beres supaya installer tak pernah berisi vault cacat.

Dipanggil scripts/build_runtime.py::compile_engine_stage dengan
build/runtime/python.exe (bukan Python sistem) agar magic number bytecode
selalu cocok dengan runtime pengguna.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "python-engine"))

from _pyc_hardening import check_tree_hardened, compile_tree_hardened  # noqa: E402
import vx_vault  # noqa: E402  (format+vault; stdlib only)
from _vault_stage import fresh_share, key_loader_text, trial_import  # noqa: E402


def log(msg: str) -> None:
    print(f"[harden-engine] {msg}", flush=True)


CLEAR_STEMS = frozenset({"server", "vx_vault"})


def vault_targets(stage: Path) -> list[str]:
    targets = sorted(
        p.stem for p in stage.glob("*.pyc") if p.stem not in CLEAR_STEMS)
    if (stage / "scripts" / "karaoke_best.pyc").is_file():
        targets.append("scripts/karaoke_best")
    return targets


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", type=Path)
    ap.add_argument("--vault", default="AUTO",
                    help="rel-path modul yang di-vault (koma) atau AUTO=semua kecuali server,vx_vault")
    args = ap.parse_args()
    stage: Path = args.stage

    loader_src = stage / "vx_vault.py"
    if not loader_src.is_file():
        log(f"GAGAL: {loader_src} tidak ada (python-engine/vx_vault.py belum disalin?)")
        return 1
    share = fresh_share()
    try:
        loader_src.write_text(
            key_loader_text(loader_src.read_text(encoding="utf-8"), share),
            encoding="utf-8")
    except Exception as e:
        log(f"GAGAL: penguncian loader ({e})")
        return 1
    log("loader dikunci (shareA acak per build)")

    n, left = compile_tree_hardened(stage)
    if left:
        log(f"GAGAL: kompilasi {left}")
        return 1
    issues = check_tree_hardened(stage)
    if issues:
        for i in issues[:10]:
            log(f"LEAK: {i}")
        return 1
    log(f"hardening OK ({n} .pyc)")

    stems = ([s for s in args.vault.split(",") if s] if args.vault != "AUTO"
             else vault_targets(stage))
    if not stems:
        log("GAGAL: tidak ada target vault")
        return 1
    import_stems = []
    for stem in stems:
        pyc = stage / f"{stem}.pyc"
        if not pyc.is_file():
            log(f"GAGAL: {stem}.pyc tidak ada setelah hardening")
            return 1
        try:
            (stage / f"{stem}.pyv").write_bytes(
                vx_vault.encrypt_pyc(pyc.read_bytes(), f"{stem}.py", share))
            pyc.unlink()
        except Exception as e:
            log(f"GAGAL: vault {stem} ({e})")
            return 1
        if "/" not in stem:
            import_stems.append(stem)
    log(f"vault OK ({len(stems)} file: {', '.join(s + '.pyv' for s in stems)})")

    # Trial impor via hook dalam SUBPROSES interpreter ini (= runtime): tanpa
    # itu, `import vx_vault` memakai salinan repo (placeholder) yang sudah
    # terlanjur di sys.modules proses ini. Skrip (scripts/*) bukan modul impor:
    # ia dijalankan via loader sebagai __main__.
    ok, detail = trial_import(sys.executable, stage, import_stems)
    if not ok:
        log(f"GAGAL: trial impor ({detail})")
        return 1
    log("trial impor OK (%d modul)" % len(import_stems))

    # Roundtrip skrip: karaoke_best dijalankan via loader sebagai __main__.
    kb = stage / "scripts" / "karaoke_best.pyv"
    if kb.is_file():
        import subprocess
        proc = subprocess.run(
            [sys.executable, str(stage / "vx_vault.pyc"), str(kb), "--help"],
            capture_output=True, text=True, timeout=300, cwd=str(stage))
        blob = (proc.stdout + proc.stderr).lower()
        if "usage:" not in blob:
            log(f"GAGAL: roundtrip karaoke_best (rc={proc.returncode}): "
                f"{(proc.stdout + proc.stderr).strip()[-300:]}")
            return 1
        log("roundtrip karaoke_best OK (usage via loader)")
    print(f"hardened={n} vaulted={stems}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
