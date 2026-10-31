
"""Karaoke Standard — satu model RoFormer instrumental (Resurrection Inst).

Instrumental dipakai langsung dari stem primer model (primary=other/
instrumental), lalu ditulis sebagai `no_vocals.wav` + `_vocals.wav`.
Post-processing (adaptive center suppression, high-pass, limiter, loudness
match) dijalankan terpisah oleh vx_karaoke_dsp.py sebagai tahap berikutnya.

Usage: karaoke_standard.py <input> <out_dir> <cuda|cpu> [vocal_kill]
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import win_nowindow  

win_nowindow.hide_child_consoles()

import vx_karaoke_sep as sep  

MODEL = "bs_roformer_instrumental_resurrection_unwa.ckpt"
WEIGHTS = ((MODEL, 1.0),)


def main():
    if len(sys.argv) < 4:
        sep.eprint("usage: karaoke_standard.py <input> <out_dir> <cuda|cpu> [vocal_kill]")
        return 2
    inp = pathlib.Path(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    device = sys.argv[3].lower()
    try:
        vocal_kill = float(sys.argv[4]) if len(sys.argv) >= 5 else 1.0
    except ValueError:
        vocal_kill = 1.0

    sep.emit_progress(2, "start")
    try:
        import torch
        sep.eprint(f"[KaraokeStd] torch {torch.__version__} cuda={torch.cuda.is_available()}"
                   + (f" ({torch.cuda.get_device_name(0)})" if torch.cuda.is_available() else ""))
        try:
            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info()
                sep.eprint(f"[KaraokeStd] VRAM bebas {free_b/1e9:.1f}/{total_b/1e9:.1f} GB")
        except Exception:
            pass
    except Exception as ex:
        sep.eprint(f"[KaraokeStd] torch probe gagal: {ex}")

    try:
        res = sep.build_instrumental_from_models(
            WEIGHTS, inp, out_dir, device, vocal_kill=vocal_kill,
            allow_download=False, progress=(6.0, 72.0))
    except Exception as ex:
        sep.eprint(f"[KaraokeStd] {MODEL} gagal: {ex}")
        import traceback
        traceback.print_exc()
        return 4

    sep.free_vram("final")
    sep.emit_progress(73, "separate:done")
    print(json.dumps({
        "vocals": str(res["vocals"]),
        "instrumental": str(res["instrumental"]),
        "model": ",".join(res["models"]) or MODEL,
        "vocal_kill": res["vocal_kill"],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
