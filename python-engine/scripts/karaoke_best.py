#!/usr/bin/env python3
"""Karaoke Best — SATU model, stem instrumental dipakai APA ADANYA.

Preset:
  karaoke_aufr33 (default) -> mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt
  standard                 -> bs_roformer_instrumental_resurrection_unwa.ckpt (cadangan)

Riwayat penting: versi sebelumnya memakai `bs_roformer_karaoke_anvuew` dan
menambah tiga tahap post-processing (magnitude_subtract, adaptive_center_suppress,
boost HF +12 dB). Itu menghasilkan "suara air" yang menetap -- burst envelope
12-16 kHz naik dari 0.197 (file sumber) ke 0.348, dan detail backing ikut
turun. JANGAN kembalikan masking itu tanpa bukti baru.

Usage: karaoke_best.py <input> <out_dir> <cuda|cpu> [preset]
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import win_nowindow  # noqa: E402

win_nowindow.hide_child_consoles()

import vx_karaoke_sep as sep  # noqa: E402
from vx_sep_cache import KARAOKE_PRESETS  # noqa: E402

DEFAULT_PRESET = "karaoke_aufr33"


def main():
    if len(sys.argv) < 4:
        sep.eprint("usage: karaoke_best.py <input> <out_dir> <cuda|cpu> [preset]")
        return 2
    inp = pathlib.Path(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    device = sys.argv[3].lower()
    preset = sys.argv[4].lower() if len(sys.argv) >= 5 else DEFAULT_PRESET
    if preset not in KARAOKE_PRESETS:
        sep.eprint(f"preset '{preset}' tidak dikenal, pakai '{DEFAULT_PRESET}'")
        preset = DEFAULT_PRESET
    model = KARAOKE_PRESETS[preset][0]
    weights = ((model, 1.0),)

    sep.emit_progress(2, "start")
    try:
        import torch
        sep.eprint(f"[KaraokeBest] preset={preset} model={model} "
                   f"torch {torch.__version__} cuda={torch.cuda.is_available()}"
                   + (f" ({torch.cuda.get_device_name(0)})" if torch.cuda.is_available() else ""))
        try:
            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info()
                sep.eprint(f"[KaraokeBest] VRAM bebas {free_b/1e9:.1f}/{total_b/1e9:.1f} GB")
        except Exception:
            pass
    except Exception as ex:
        sep.eprint(f"[KaraokeBest] torch probe gagal: {ex}")

    missing = sep.missing_models(weights)
    if missing:
        sep.eprint(f"[KaraokeBest] model belum ada, mengunduh: {', '.join(missing)}")

    try:
        res = sep.build_instrumental_from_models(
            weights, inp, out_dir, device,
            allow_download=True, progress=(6.0, 72.0))
    except Exception as ex:
        sep.eprint(f"[KaraokeBest] {model} gagal: {ex}")
        import traceback
        traceback.print_exc()
        return 4

    sep.free_vram("final")
    sep.emit_progress(73, "separate:done")
    print(json.dumps({
        "vocals": "",
        "instrumental": str(res["instrumental"]),
        "model": ",".join(res["models"]) or model,
        "preset": preset,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())