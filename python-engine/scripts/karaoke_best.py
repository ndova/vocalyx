
"""Karaoke Best — SATU model, stem instrumental dipakai APA ADANYA.

Preset:
  karaoke_aufr33 (default) -> mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt
  standard                 -> bs_roformer_instrumental_resurrection_unwa.ckpt (cadangan)

Riwayat penting: versi sebelumnya memakai `bs_roformer_karaoke_anvuew` dan
menambah tiga tahap post-processing (magnitude_subtract, adaptive_center_suppress,
boost HF +12 dB). Itu menghasilkan "suara air" yang menetap -- burst envelope
12-16 kHz naik dari 0.197 (file sumber) ke 0.348, dan detail backing ikut
turun. JANGAN kembalikan masking itu tanpa bukti baru.

Usage: karaoke_best.py <input> <out_dir> <cuda|cpu> [preset] [--no-dereverb] [--ensemble] [--no-ensemble] [--ens-algo NAME]
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import win_nowindow  

win_nowindow.hide_child_consoles()

import vx_karaoke_sep as sep  
from vx_sep_cache import KARAOKE_ENSEMBLE, KARAOKE_ENSEMBLE_ALGO, KARAOKE_PRESETS  

DEFAULT_PRESET = "karaoke_aufr33"


def main():
    if len(sys.argv) < 4:
        sep.eprint("usage: karaoke_best.py <input> <out_dir> <cuda|cpu> [preset]")
        return 2
    inp = pathlib.Path(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    device = sys.argv[3].lower()
    rest = [a for a in sys.argv[4:]]
    no_dereverb_flag = "--no-dereverb" in rest
    rest = [a for a in rest if not a.startswith("--")]
    preset = rest[0].lower() if rest else DEFAULT_PRESET
    if preset not in KARAOKE_PRESETS:
        sep.eprint(f"preset '{preset}' tidak dikenal, pakai '{DEFAULT_PRESET}'")
        preset = DEFAULT_PRESET
    model = KARAOKE_PRESETS[preset][0]
    
    
    
    
    
    import os as _os
    ens_want = "--ensemble" in sys.argv[4:] or \
        (_os.environ.get("VOCALYX_ENSEMBLE") or "").strip().lower() in ("1", "true", "on", "yes")
    no_ens_flag = "--no-ensemble" in sys.argv[4:]
    no_ens_env = (_os.environ.get("VOCALYX_NO_ENSEMBLE") or "").strip().lower() in ("1", "true", "on", "yes")
    ens_algo = ""
    for _i, _a in enumerate(sys.argv[4:]):
        if _a == "--ens-algo" and _i + 5 < len(sys.argv):
            ens_algo = sys.argv[_i + 5].strip().lower()
    if not ens_algo:
        ens_algo = (_os.environ.get("VOCALYX_ENS_ALGO") or "").strip().lower()
    if ens_algo not in ("avg", "avg_wave", "min_fft", "median_fft", "max_fft",
                        "min_wave", "median_wave", "max_wave",
                        "uvr_min_spec", "uvr_max_spec"):
        ens_algo = KARAOKE_ENSEMBLE_ALGO.get(preset, "min_fft")
    ens_members = tuple(KARAOKE_ENSEMBLE.get(preset, ()))
    if preset == "karaoke_full":
        use_ens = len(ens_members) > 1 and not no_ens_flag and not no_ens_env
    else:
        use_ens = (ens_want and not no_ens_flag and not no_ens_env
                   and len(ens_members) > 1)
    if use_ens:
        weights = ens_members
        ens_algo_eff = ens_algo
        sep.eprint(f"[KaraokeBest] ensemble {len(weights)} model [{ens_algo_eff}]: "
                   + ", ".join(f"{m}({w})" for m, w in weights))
    else:
        weights = ((model, 1.0),)
        ens_algo_eff = "avg"
        sep.eprint("[KaraokeBest] single model")
    
    
    
    use_dereverb = (
        preset == "karaoke_aufr33"
        and device != "cpu"
        and not no_dereverb_flag
        and sep._dereverb_enabled()
    )
    sep.eprint(f"[KaraokeBest] dereverb tahap-2: {'nyala' if use_dereverb else 'mati'}")
    has_ckpt = any(m.lower().endswith(".ckpt") for m, _ in weights)
    sep.eprint(f"[KaraokeBest] overlap inferensi: {sep._wanted_overlap() if has_ckpt else 'n/a (ONNX)'}")

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
            allow_download=True, progress=(6.0, 72.0),
            dereverb=use_dereverb, algorithm=ens_algo_eff)
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