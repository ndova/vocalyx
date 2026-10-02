#!/usr/bin/env python3
"""Diagnosa kualitas stem karaoke: siapa penyebab suara "bawah air"?

Untuk tiap model kandidat diukur:
  - bleed_corr   : korelasi stem instrumental vs stem vokal model. Makin tinggi
                   makin banyak "hantu vokal" (residual reverb vokal) di
                   instrumental -> itulah bunyi watery saat bagian vokal.
  - hf_floor_db  : selisih floor noise band 12-16 kHz stem vs sumber (dB).
                   Naik berarti desis/"gemericik air" bertambah.
  - vocal_band_ratio: porsi energi 300-3400 Hz di stem vs sumber.
  - lufs         : loudness stem.

Lalu tiap stem mentah dilewatkan `dsp.finish` (tahap DSP normal: limiter +
loudness-match, TANPA masking) dan metrik + korelasi(sebelum, sesudah) dihitung
ulang. Kalau korelasi ~1 dan bleed_corr tidak berubah -> DSP bukan penyebab.

Usage: karaoke_diagnose.py <input> <out_dir> <cuda|cpu>
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import win_nowindow  # noqa: E402

win_nowindow.hide_child_consoles()

import numpy as np  # noqa: E402

import vx_karaoke_dsp as dsp  # noqa: E402
import vx_karaoke_sep as sep  # noqa: E402
from vx_sep_cache import KARAOKE_PRESETS  # noqa: E402

N_FFT = 2048
HOP = 512


def frame_spectrum(x: np.ndarray) -> np.ndarray:
    """|STFT| mono, shape (F, T)."""
    m = (x[0] + x[1]) * 0.5
    n = 1 + (len(m) - N_FFT) // HOP
    out = np.abs(np.fft.rfft(
        np.stack([m[i * HOP:i * HOP + N_FFT] * np.hanning(N_FFT) for i in range(n)]),
        axis=1)).T
    return out


def band_energy_db(spec: np.ndarray, lo_hz: float, hi_hz: float) -> np.ndarray:
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / dsp.SAMPLE_RATE)
    mask = (freqs >= lo_hz) & (freqs <= hi_hz)
    e = (spec[mask] ** 2).sum(axis=0)
    return 10 * np.log10(np.maximum(e, 1e-20))


def metrics(x: np.ndarray, mix: np.ndarray) -> dict:
    sx = frame_spectrum(x)
    sm = frame_spectrum(mix)
    xf = band_energy_db(sx, 12000, 16000)
    mf = band_energy_db(sm, 12000, 16000)
    floor_pct = 10.0
    hf_db = float(np.percentile(xf, floor_pct) - np.percentile(mf, floor_pct))
    xt = (sx ** 2).sum(axis=0)
    mt = (sm ** 2).sum(axis=0)
    xb = (sx[(np.fft.rfftfreq(N_FFT, 1 / dsp.SAMPLE_RATE) >= 300)
              & (np.fft.rfftfreq(N_FFT, 1 / dsp.SAMPLE_RATE) <= 3400)] ** 2).sum(axis=0)
    mb = (sm[(np.fft.rfftfreq(N_FFT, 1 / dsp.SAMPLE_RATE) >= 300)
              & (np.fft.rfftfreq(N_FFT, 1 / dsp.SAMPLE_RATE) <= 3400)] ** 2).sum(axis=0)
    vb_x = float(np.mean(xb / np.maximum(xt, 1e-20)))
    vb_m = float(np.mean(mb / np.maximum(mt, 1e-20)))
    return {"hf_floor_db_vs_mix": round(hf_db, 2),
            "vocal_band_ratio": round(vb_x, 4),
            "vocal_band_ratio_mix": round(vb_m, 4)}


def bleed_corr(inst: np.ndarray, voc: np.ndarray) -> float:
    a = (inst[0] + inst[1]) * 0.5
    b = (voc[0] + voc[1]) * 0.5
    n = min(len(a), len(b))
    a = a[:n] - a[:n].mean()
    b = b[:n] - b[:n].mean()
    denom = float(np.sqrt((a ** 2).sum() * (b ** 2).sum()))
    if denom <= 0:
        return 0.0
    return round(float((a * b).sum() / denom), 4)


def pick_inst(primary_path: pathlib.Path | None, second: pathlib.Path | None,
              found: pathlib.Path) -> pathlib.Path | None:
    for cand in (second, found):
        if cand is None:
            continue
        p = pathlib.Path(cand)
        if not p.is_file():
            continue
        low = p.name.lower()
        if "(instrumental)" in low or "(other)" in low or "_no_vocals" in low or "(no_vocals)" in low:
            return p
    return None


def uniq_models() -> list[tuple[str, str]]:
    seen = set()
    out = []
    for preset, (model, _w) in KARAOKE_PRESETS.items():
        if model in seen:
            continue
        seen.add(model)
        out.append((preset, model))
    return out


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: karaoke_diagnose.py <input> <out_dir> <cuda|cpu>")
        return 2
    inp = pathlib.Path(sys.argv[1])
    out_dir = pathlib.Path(sys.argv[2])
    device = sys.argv[3].lower()
    out_dir.mkdir(parents=True, exist_ok=True)

    mix = dsp.load_audio(inp)
    report = {"input": str(inp), "models": []}

    for preset, model in uniq_models():
        if not sep.ensure_model(model):
            report["models"].append({"preset": preset, "model": model, "error": "model missing"})
            continue
        stem_dir = out_dir / preset
        stem_dir.mkdir(parents=True, exist_ok=True)
        try:
            found, primary, second = sep.separate_one(model, inp, stem_dir, device)
        except Exception as ex:
            report["models"].append({"preset": preset, "model": model, "error": str(ex)})
            continue
        inst_path = pick_inst(found, second, found) or found
        # stem vokal untuk bleed_corr: file yang BUKAN instrumental
        voc_path = None
        for cand in (found, second):
            if cand is None:
                continue
            p = pathlib.Path(cand)
            low = p.name.lower()
            if p.resolve() != inst_path.resolve() and p.is_file() and \
                    ("(vocal" in low or "voc" in low):
                voc_path = p
                break
        inst = dsp.to_stereo(dsp.fit_length(dsp.load_audio(inst_path), mix.shape[-1]))
        voc = None
        if voc_path is not None and voc_path.is_file():
            voc = dsp.to_stereo(dsp.fit_length(dsp.load_audio(voc_path), mix.shape[-1]))
        m_raw = metrics(inst, mix)
        lufs, tp = dsp.measure_loudness(inst_path)
        m_raw["lufs"] = lufs
        m_raw["true_peak_dbtp"] = tp
        m_raw["bleed_corr_vs_vocal_stem"] = bleed_corr(inst, voc) if voc is not None else None

        post_path = stem_dir / "post.wav"
        dsp.finish(inst_path, post_path, reference=str(inp))
        post = dsp.load_audio(post_path)
        m_post = metrics(post, mix)
        lufs2, tp2 = dsp.measure_loudness(post_path)
        m_post["lufs"] = lufs2
        m_post["true_peak_dbtp"] = tp2
        m_post["bleed_corr_vs_vocal_stem"] = bleed_corr(post, voc) if voc is not None else None
        n = min(inst.shape[-1], post.shape[-1])
        a = inst[:, :n].ravel(); b = post[:, :n].ravel()
        m_post["corr_raw_vs_finish"] = round(float(np.corrcoef(a, b)[0, 1]), 5)

        report["models"].append({
            "preset": preset, "model": model, "primary": primary,
            "inst_file": inst_path.name, "vocal_file": voc_path.name if voc_path else None,
            "raw": m_raw, "after_finish": m_post,
        })
        sep.free_vram(model)

    out = out_dir / "diagnose_report.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"\nreport: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
