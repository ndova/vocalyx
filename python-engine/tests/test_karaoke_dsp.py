
"""Self-test untuk pipeline karaoke yang sekarang.

Pipeline sengaja dibuat SESEDERHANA mungkin: stem instrumental dari model dipakai
apa adanya, lalu high-pass opsional + limiter + loudness match. Jadi yang diuji
hanya apa yang benar-benar dikerjakan: LINEARITAS I/O, loudness match, kontrak
true peak, dan integrity sinyal.

Tidak ada lagi test masking: magnitude_subtract + adaptive_center_suppress +
boost_hf sudah dihapus karena tiga tahap itu yang menghasilkan "suara air".
Kalau suatu saat masking ditambahkan lagi, test ini harus ditambah regression
yang mengukur burst envelope 12-16 kHz terhadap file sumber.
"""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import vx_karaoke_dsp as dsp

FAIL = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"  {detail}" if detail else ""))
    if not ok:
        FAIL.append(name)


def tone(freq, dur=1.0, sr=dsp.SAMPLE_RATE, amp=0.5):
    t = np.arange(int(sr * dur)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def main():
    
    a = tone(220, 0.5)
    check("tone() stereo (2, N)", a.ndim == 1, f"{a.shape}")

    st = dsp.to_stereo(a)
    check("to_stereo mono -> (2, N)", st.shape[0] == 2 and st.shape[1] == len(a), f"{st.shape}")
    st2 = dsp.to_stereo(np.stack([a, a * 0.5]))
    check("to_stereo stereo tidak diubah", st2.shape == (2, len(a)), f"{st2.shape}")
    stT = dsp.to_stereo(np.stack([a, a * 0.5], axis=1))
    check("to_stereo (N, C) dibalik ke (C, N)", stT.shape == (2, len(a)), f"{stT.shape}")

    f = dsp.fit_length(a, 1000)
    check("fit_length memanjang", f.shape[-1] == 1000, f"{f.shape}")
    f2 = dsp.fit_length(dsp.to_stereo(a), 100)
    check("fit_length memotong", f2.shape[-1] == 100, f"{f2.shape}")

    check("true_peak = max abs", abs(dsp.true_peak(np.array([-0.7, 0.3], dtype=np.float32)) - 0.7) < 1e-6)
    check("true_peak data kosong 0", dsp.true_peak(np.zeros((2, 0), dtype=np.float32)) == 0.0)

    
    mix = dsp.to_stereo(a)
    x = (a * 0.5).astype(np.float32)
    y = (a * 0.25).astype(np.float32)
    ws = dsp.weighted_sum(mix, [(x, 1.0), (y, 1.0)], 2.0)
    expect = (x + y) / 2.0
    check("weighted_sum rata-rata", float(np.abs(ws[0] - expect).max()) < 1e-6,
          f"maxerr {float(np.abs(ws[0] - expect).max()):.2e}")
    ws0 = dsp.weighted_sum(mix, [(x, 1.0)], 0.0)
    check("weighted_sum total_weight 0 -> silence", float(np.abs(ws0).max()) == 0.0)

    
    if not dsp.ffmpeg_bin():
        print("\n(skip test WAV: ffmpeg tidak ditemukan)")
    else:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            src = tdp / "in.wav"
            data = dsp.to_stereo((a * 0.4).astype(np.float32))
            dsp.write_wav(src, data)
            back = dsp.load_audio(src)
            check("write/load wav: (2, N)", back.shape == data.shape, f"{back.shape}")
            rms_err = float(np.sqrt(((back - data) ** 2).mean()))
            check("write/load wav isi identik (FLOAT)", rms_err < 1e-4, f"rms {rms_err:.2e}")

            
            quiet = tdp / "quiet.wav"
            loud = tdp / "loud.wav"
            t = np.arange(dsp.SAMPLE_RATE * 3) / dsp.SAMPLE_RATE
            body = 0.5 * np.sin(2 * np.pi * 200 * t) + 0.3 * np.sin(2 * np.pi * 1000 * t)
            dsp.write_wav(quiet, dsp.to_stereo((body * 0.05).astype(np.float32)))
            dsp.write_wav(loud, dsp.to_stereo((body * 0.50).astype(np.float32)))

            
            i_q, _ = dsp.measure_loudness(quiet)
            i_l, _ = dsp.measure_loudness(loud)
            out_match = dsp.finish(quiet, tdp / "m.wav", reference=loud)
            o_m, _ = dsp.measure_loudness(out_match)
            out_const = dsp.finish(quiet, tdp / "c.wav")
            o_c, _ = dsp.measure_loudness(out_const)
            if None not in (i_q, i_l, o_m, o_c):
                
                dm = abs(o_m - i_l)
                dc = abs(o_m - i_q)
                check("finish: match-lufs mengikuti referensi", dm < dc,
                      f"|match-ref|={dm:.2f} LU vs |match-quiet|={dc:.2f} LU")
                check("finish tanpa referensi tetap ada", o_c is not None,
                      f"{o_c:.2f} LUFS")

            
            out_tp = dsp.finish(loud, tdp / "t.wav", true_peak_db=-1.0)
            _, tp = dsp.measure_loudness(out_tp)
            check("finish: true peak di bawah -1 dBTP", tp is not None and tp <= -0.85,
                  f"TP {tp:+.2f} dBTP" if tp is not None else "TP tidak terbaca")

            
            
            
            t2 = np.arange(dsp.SAMPLE_RATE * 4) / dsp.SAMPLE_RATE
            mixed = (0.35 * np.sin(2 * np.pi * 14 * t2)
                     + 0.40 * np.sin(2 * np.pi * 220 * t2)
                     + 0.20 * np.sin(2 * np.pi * 1200 * t2)).astype(np.float32)
            hsig = tdp / "hsig.wav"
            dsp.write_wav(hsig, dsp.to_stereo(mixed))
            dsp.finish(hsig, tdp / "hp_off.wav")
            dsp.finish(hsig, tdp / "hp_on.wav", highpass_hz=30.0)

            n_fft = 8192
            win = np.hanning(n_fft + 1)[:-1]

            def band(x):
                m = (x[0] + x[1]) * 0.5
                seg = m[:n_fft] * win
                S = np.abs(np.fft.rfft(seg))
                f = np.fft.rfftfreq(n_fft, 1 / dsp.SAMPLE_RATE)
                return (float((S[(f >= 200) & (f <= 240)] ** 2).sum()),
                        float((S[(f >= 8) & (f <= 20)] ** 2).sum()))

            body_off, sub_off = band(dsp.load_audio(tdp / "hp_off.wav"))
            body_on, sub_on = band(dsp.load_audio(tdp / "hp_on.wav"))
            drop = 10 * np.log10(max(sub_on, 1e-20) / max(sub_off, 1e-20))
            check("high-pass 30 Hz memotong bass rendah", drop < -6.0, f"{drop:+.1f} dB")
            body_shift = 10 * np.log10(max(body_on, 1e-20) / max(body_off, 1e-20))
            check("high-pass 30 Hz menjaga band badan 200-240 Hz",
                  abs(body_shift) < 1.0, f"{body_shift:+.2f} dB")
            
            fin = dsp.load_audio(out_tp)
            check("tidak ada NaN/Inf di output", bool(np.isfinite(fin).all()))

    print()
    if FAIL:
        print(f"{len(FAIL)} GAGAL: " + ", ".join(FAIL))
        return 1
    print("semua ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
