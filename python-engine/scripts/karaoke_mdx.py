#!/usr/bin/env python3
"""Karaoke fallback — ensemble MDX-Net lama, hanya bila preset Best dan
karaoke_standard.py sama-sama gagal (OOM, download gagal, file korup).
Hasilnya tidak sebersih preset utama, tapi karaoke tidak pernah gagal total.

Bobot mirror MDX_FALLBACK_WEIGHTS di vx_sep_cache.py.

Usage: karaoke_mdx.py <input> <out_dir> <cuda|cpu> [vocal_kill]
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import win_nowindow  # noqa: E402

win_nowindow.hide_child_consoles()

import vx_karaoke_sep as sep  # noqa: E402

WEIGHTS = (
    ("Kim_Inst.onnx", 0.35),          # instrumental-primary
    ("UVR-MDX-NET-Inst_HQ_4.onnx", 0.25),  # instrumental-primary
    ("Kim_Vocal_2.onnx", 0.25),      # vocal-primary
    ("UVR-MDX-NET-Voc_FT.onnx", 0.15),      # vocal-primary
)


def main():
    if len(sys.argv) < 4:
        sep.eprint("usage: karaoke_mdx.py <input> <out_dir> <cuda|cpu> [vocal_kill]")
        return 2
    inp = pathlib.Path(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    device = sys.argv[3].lower()
    try:
        vocal_kill = float(sys.argv[4]) if len(sys.argv) >= 5 else 1.0
    except ValueError:
        vocal_kill = 1.0

    sep.emit_progress(2, "start")
    missing = sep.missing_models(WEIGHTS)
    if missing:
        sep.eprint(f"[KaraokeMDX] model belum ada, akan diunduh: {', '.join(missing)}")

    try:
        res = sep.build_instrumental_from_models(
            WEIGHTS, inp, out_dir, device, vocal_kill=vocal_kill,
            allow_download=True, progress=(6.0, 72.0), algorithm="avg")
    except Exception as ex:
        sep.eprint(f"[KaraokeMDX] gagal: {ex}")
        import traceback
        traceback.print_exc()
        return 4

    sep.free_vram("final")
    sep.emit_progress(73, "separate:done")
    print(json.dumps({
        "vocals": str(res["vocals"]),
        "instrumental": str(res["instrumental"]),
        "model": "mdx-fallback:" + ",".join(res["models"]),
        "vocal_kill": res["vocal_kill"],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
