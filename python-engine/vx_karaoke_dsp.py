"""VocaLyx engine - I/O audio + loudness finishing untuk karaoke.

Pipeline karaoke sekarang SESEDERHANA mungkin, dan itu disengaja.

Stem "Instrumental" dari model dipakai APA ADANYA (tahap dereverb terpisah di
``vx_karaoke_sep`` membersihkan sisa reverb vokal SEBELUM file sampai sini),
lalu hanya ditambah: clarity EQ lembut (default nyala, lihat ``clarity_chain``),
high-pass opsional (default mati), limiter, dan loudness-match ke lagu asli.

Kenapa tidak ada masking. Versi sebelumnya menjalankan tiga tahap:
``magnitude_subtract``, lalu ``adaptive_center_suppress``, dengan mask vokal
dinaikkan +12 dB di 4-9 kHz. Dua mask multiplicatif berturut-turut di channel
mid, jadi error-nya menumpuk: harmonik vokal terpotong sebagian-setengah dan
terdengar sebagai desis/"gemericik air". Terukur pada "Tere - Pencuri Hati":
burst envelope 12-16 kHz di frame hening naik dari 0.197 (file sumber) ke
0.348, dan detail backing ikut turun ~1 dB.

Pipeline polos yang lebih lama menghasilkan korelasi 0.987 dengan file karaoke
yangPENGGUNA sukai, dan 4.3x lebih cepat (7.4 vs 26.2 detik/menit). Modul mask
sudah DIHAPUS. Jangan menambahkannya lagi tanpa bukti pengukuran baru.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import win_nowindow

win_nowindow.hide_child_consoles()

import numpy as np

SAMPLE_RATE = 44100
N_FFT = 2048
HOP = 512
BLOCK_SEC = 30.0

INSTRUMENTAL_STEMS = {"instrumental", "no vocals", "novocals", "other", "accompaniment", "no_vocals"}

VOCAL_BAND_LO = 180.0
VOCAL_BAND_LO_EDGE = 260.0
VOCAL_BAND_HI = 7500.0
VOCAL_BAND_HI_EDGE = 9000.0
CENTRE_GAMMA = 2.0
FLOOR_PCT = 20.0
FLOOR_BINS = 9
SALIENCE_REF = 8.0




TARGET_LUFS = -13.0













CLARITY_HP_HZ = 18.0
CLARITY_DEMUD_DB = -1.0
CLARITY_PRESENCE_DB = 1.0
CLARITY_AIR_DB = 1.5
CLARITY_AIR_F = 11000.0



CLARITY_BITE_DB = 1.0
CLARITY_BITE_F = 3200.0
CLARITY_BITE_Q = 1.0
CLARITY_RESIDUAL_GUARD_DB = 1.0




CLARITY_GUARD_DB = 1.0



DEREVERB_BLEND = 0.65

def log(msg: str) -> None:
    sys.stderr.write(f"[KaraokeDSP] {msg}\n")
    sys.stderr.flush()


def emit_progress(pct: float, stage: str) -> None:
    try:
        sys.stdout.write(json.dumps({"karaoke_progress": round(float(pct), 1), "karaoke_stage": str(stage)}) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def ffmpeg_bin() -> str:
    cand = os.environ.get("FFMPEG_BINARY") or ""
    if cand:
        return cand
    for name in ("ffmpeg.exe", "ffmpeg"):
        local = Path(__file__).resolve().parent.parent / "ffmpeg" / "bin" / name
        if local.is_file():
            return str(local)
    return shutil.which("ffmpeg") or ""






def _decode_via_ffmpeg(path, sr: int) -> np.ndarray:
    """Fallback buat container yang tidak bisa dibuka libsndfile (m4a/aac/wma).

    libsndfile hanya bisa WAV/FLAC/OGG; file m4a dari iPhone/4shared akan gagal
    dan audio_separator memprosesnya lewat librosa yang memanggil ffmpeg — jadi
    di sini harus lewat ffmpeg juga, kalau tidak decode mix untuk math stem mati.

    Returns (N, C) float32, sama seperti ``soundfile.read``.
    """
    import tempfile

    import soundfile as sf

    ff = ffmpeg_bin()
    if not ff:
        raise RuntimeError(f"tidak bisa baca {path} dan ffmpeg tidak tersedia")
    with tempfile.TemporaryDirectory() as td:
        dst = Path(td) / "decoded.wav"
        r = subprocess.run([ff, "-y", "-v", "error", "-i", str(path),
                            "-f", "wav", "-acodec", "pcm_f32le", "-ar", str(sr), "-ac", "2",
                            str(dst)], capture_output=True, timeout=1800)
        if r.returncode != 0 or not dst.is_file():
            raise RuntimeError(f"ffmpeg gagal decode {path}: {(r.stderr or b'')[-300:]!r}")
        data, _ = sf.read(str(dst), dtype="float32", always_2d=True)
    return np.ascontiguousarray(data, dtype=np.float32)


def load_audio(path, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Load sebagai (2, N) float32 pada 44.1 kHz."""
    import soundfile as sf

    try:
        data, native = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception:
        data = _decode_via_ffmpeg(path, sr)
        native = sr
    if int(native) != sr:
        import librosa

        data = librosa.resample(data.T, orig_sr=int(native), target_sr=sr).T
    d = np.ascontiguousarray(np.asarray(data, dtype=np.float32).T)
    if d.ndim != 2 or d.shape[0] not in (1, 2):
        raise RuntimeError(f"shape audio tidak wajar: {d.shape} dari {path}")
    if d.shape[0] == 1:
        d = np.repeat(d, 2, axis=0)
    return d


def write_wav(path, data: np.ndarray, sr: int = SAMPLE_RATE, subtype: str = "FLOAT") -> Path:
    import soundfile as sf

    d = to_stereo(np.asarray(data, dtype=np.float32))
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(dest), np.ascontiguousarray(d.T), sr, subtype=subtype)
    return dest


def to_stereo(data: np.ndarray) -> np.ndarray:
    d = np.asarray(data, dtype=np.float32)
    if d.ndim == 1:
        return np.stack([d, d])
    
    
    if d.ndim == 2 and d.shape[0] not in (1, 2) and d.shape[1] in (1, 2):
        d = d.T
    if d.shape[0] == 1:
        return np.repeat(d, 2, axis=0)
    return d


def fit_length(data: np.ndarray, n: int) -> np.ndarray:
    d = to_stereo(data)
    have = d.shape[-1]
    if have == n:
        return d
    if have > n:
        return d[..., :n]
    pad = np.zeros((d.shape[0], n - have), dtype=np.float32)
    return np.concatenate([d, pad], axis=-1)


def true_peak(data: np.ndarray) -> float:
    if data.size == 0:
        return 0.0
    return float(np.abs(data).max())






def clarity_chain(with_hp: bool = True) -> list:
    """Rantai filter clarity: de-mud, presence, air, (+ HP fase-aman).

    Satu lapis EQ statis kecil — BUKAN mask adaptif, jadi tidak ada error
    multiplicatif yang menumpuk seperti dulu. Guard spektral ada di
    ``_guard_clarity``.
    """
    fx = [
        f"equalizer=f=280:t=q:w=1:g={CLARITY_DEMUD_DB:.1f}",
        f"highshelf=f=4500:g={CLARITY_PRESENCE_DB:.1f}",
        f"equalizer=f={CLARITY_BITE_F:.0f}:t=q:w={CLARITY_BITE_Q:.1f}:g={CLARITY_BITE_DB:.1f}",
        f"highshelf=f={CLARITY_AIR_F:.0f}:g={CLARITY_AIR_DB:.1f}",
    ]
    if with_hp:
        fx.insert(0, f"highpass=f={CLARITY_HP_HZ:.1f}:poles=1")
    return fx


def _band_db(data: np.ndarray, lo_hz: float, hi_hz: float) -> float | None:
    """Energi band (dB, relatif) dari sinyal (2, N) via FFT Hann penuh."""
    try:
        d = to_stereo(np.asarray(data, dtype=np.float32))
        m = ((d[0] + d[1]) * 0.5).astype(np.float64)
        if m.size < 1024:
            return None
        n_fft = 1 << (int(m.size - 1).bit_length() - 1)
        n_fft = max(4096, min(n_fft, 1 << 18))
        seg = m[:n_fft] * np.hanning(n_fft)
        spec = np.abs(np.fft.rfft(seg))
        freqs = np.fft.rfftfreq(n_fft, 1.0 / SAMPLE_RATE)
        e = float((spec[(freqs >= lo_hz) & (freqs <= hi_hz)] ** 2).sum())
        return 10.0 * float(np.log10(max(e, 1e-20)))
    except Exception:
        return None


def _render_fx_tmp(src, fx: list, tag: str):
    """Render ``src`` lewat rantai filter ffmpeg ke wav sementara (atau None)."""
    import tempfile

    ff = ffmpeg_bin()
    if not ff or not fx:
        return None, None
    try:
        td = tempfile.TemporaryDirectory()
        p = Path(td.name) / f"{tag}.wav"
        r = subprocess.run([ff, "-y", "-v", "error", "-i", str(src), "-af", ",".join(fx),
                            "-c:a", "pcm_f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", str(p)],
                           capture_output=True, timeout=1800)
        if r.returncode != 0 or not p.is_file() or p.stat().st_size <= 1024:
            td.cleanup()
            return None, None
        return p, td
    except Exception as ex:
        log(f"render clarity {tag} gagal: {ex}")
        return None, None


def _quiet_residual_db(x: np.ndarray, ref: np.ndarray) -> float | None:
    """Sisa di frame sepi (dB): energi x vs ref saat ref < persentil 10.

    Proksi pecah "radio" (sisa vokal yang muncul di jeda). Positif = hasil
    lebih berisik dari aslinya di bagian sepi.
    """
    try:
        def frames(a: np.ndarray) -> np.ndarray:
            m = ((to_stereo(np.asarray(a, dtype=np.float32))[0]
                  + to_stereo(np.asarray(a, dtype=np.float32))[1]) * 0.5)
            n = 1 + (len(m) - N_FFT) // HOP
            if n < 4:
                return np.array([])
            spec = np.abs(np.fft.rfft(
                np.stack([m[i * HOP:i * HOP + N_FFT] * np.hanning(N_FFT) for i in range(n)]),
                axis=1))
            return (spec ** 2).sum(axis=0)
        ex, er = frames(x), frames(ref)
        if ex.size == 0 or er.size == 0:
            return None
        n = min(ex.size, er.size)
        ex, er = ex[:n], er[:n]
        thr = float(np.percentile(er, 10.0))
        q = er <= max(thr, 1e-20)
        if not bool(q.any()):
            return 0.0
        r = float(np.mean(ex[q]) / max(float(np.mean(er[q])), 1e-20))
        return float(10 * np.log10(max(r, 1e-20)))
    except Exception:
        return None


def _guard_clarity(src, fx: list, reference) -> list:
    """Lucuti filter clarity yang menaikkan HF melebihi lagu asli.

    Aturan: band air (12-16 kHz) dan presence (3-8 kHz) hasil render tidak
    boleh melebihi band yang sama pada ``reference`` + CLARITY_GUARD_DB.
    Tanpa referensi, rantai dipakai apa adanya (nilainya memang kecil).
    Urutan pelucutan: air dulu, lalu presence diturunkan separuh.
    Penjaga residual (v22): quiet_residual vs mix tidak boleh > +1 dB;
    bila melanggar, filter bite dilucuti (bite tinggal serumah sisa vokal).
    """
    if not fx or not reference:
        return list(fx)
    try:
        ref = load_audio(reference)
    except Exception as ex:
        log(f"guard clarity: referensi tidak terbaca ({ex}); pakai rantai penuh")
        return list(fx)
    ref_air = _band_db(ref, 12000.0, 16000.0)
    ref_pres = _band_db(ref, 3000.0, 8000.0)
    if ref_air is None or ref_pres is None:
        return list(fx)

    cur = list(fx)
    for step in ("air", "presence"):
        p, td = _render_fx_tmp(src, cur, f"guard_{step}")
        if p is None:
            break
        try:
            got = load_audio(p)
        finally:
            try:
                td.cleanup()
            except Exception:
                pass
        if step == "air":
            got_air = _band_db(got, 12000.0, 16000.0)
            if got_air is not None and got_air > ref_air + CLARITY_GUARD_DB:
                log(f"guard clarity: air {got_air - ref_air:+.1f}dB vs asli, filter air dilucuti")
                cur = [f for f in cur
                       if not f.startswith(f"highshelf=f={CLARITY_AIR_F:.0f}")]
                continue
            continue
        else:
            got_pres = _band_db(got, 3000.0, 8000.0)
            if got_pres is not None and got_pres > ref_pres + CLARITY_GUARD_DB:
                log(f"guard clarity: presence {got_pres - ref_pres:+.1f}dB vs asli, diturunkan separuh")
                cur = [(f"highshelf=f=4500:g={CLARITY_PRESENCE_DB / 2.0:.1f}"
                        if f.startswith("highshelf=f=4500") else f) for f in cur]
            break
    
    
    
    if any(f.startswith(f"equalizer=f={CLARITY_BITE_F:.0f}") for f in cur):
        p, td = _render_fx_tmp(src, cur, "guard_residual")
        if p is not None:
            try:
                got = load_audio(p)
            finally:
                try:
                    td.cleanup()
                except Exception:
                    pass
            rq = _quiet_residual_db(got, ref)
            if rq is not None and rq > CLARITY_RESIDUAL_GUARD_DB:
                log(f"guard residual: sisa sepi {rq:+.1f}dB vs mix, filter bite dilucuti")
                cur = [f for f in cur if not f.startswith(f"equalizer=f={CLARITY_BITE_F:.0f}")]
            elif rq is not None:
                log(f"guard residual: sisa sepi {rq:+.1f}dB vs mix, bite dipakai")
    return cur


def blend_with_clean(raw: np.ndarray, cleaned: np.ndarray,
                     amount: float = DEREVERB_BLEND) -> np.ndarray:
    """Blend instrumental mentah dengan versi bersih-dereverb.

    ``cleaned`` di-level-match (RMS) ke ``raw`` dulu supaya blend tidak
    mengubah loudness, lalu ``out = amount*cleaned + (1-amount)*raw``.
    Korelasi dicatat: kalau < 0.90, model dereverb kemungkinan merusak musik
    (bukan sekadar mengeringkan reverb) — panggilannya yang memutuskan
    fallback ke mentah.
    """
    amt = float(np.clip(amount, 0.0, 1.0))
    r = to_stereo(raw).astype(np.float64)
    c = to_stereo(fit_length(cleaned, r.shape[-1])).astype(np.float64)
    rr = float(np.sqrt((r ** 2).mean()) + 1e-12)
    cc = float(np.sqrt((c ** 2).mean()) + 1e-12)
    if cc > 1e-9:
        c = c * (rr / cc)
    out = (amt * c + (1.0 - amt) * r).astype(np.float32)
    try:
        a = out.ravel().astype(np.float64)
        b = r.ravel().astype(np.float64)
        a -= a.mean()
        b -= b.mean()
        denom = float(np.sqrt((a ** 2).sum() * (b ** 2).sum()))
        corr = float((a * b).sum() / denom) if denom > 0 else 0.0
    except Exception:
        corr = 0.0
    log(f"dereverb blend {amt:.2f}: corr vs mentah {corr:.4f}")
    return out







def weighted_sum(mix: np.ndarray, parts, total_weight: float) -> np.ndarray:
    """Jumlah tertimbang dari (part, bobot) pada skala yang sama."""
    mix = to_stereo(mix).astype(np.float64)
    n = mix.shape[-1]
    acc = np.zeros((mix.shape[0], n), dtype=np.float64)
    for part, w in parts:
        acc += fit_length(to_stereo(part), n).astype(np.float64) * float(w)
    if abs(total_weight) < 1e-12:
        return np.zeros_like(mix, dtype=np.float32)
    return (acc / float(total_weight)).astype(np.float32)






def measure_loudness(path) -> tuple[float | None, float | None]:
    """(integrated_lufs, true_peak) dari loudnorm print_format=json."""
    ff = ffmpeg_bin()
    if not ff:
        return None, None
    try:
        r = subprocess.run([ff, "-i", str(path), "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
                            "-f", "null", "-"], capture_output=True, text=True, timeout=600)
        t = r.stderr or ""
        s, e = t.find("{"), t.rfind("}")
        if s >= 0 and e > s:
            j = json.loads(t[s:e + 1])
            return float(j.get("input_i", -14.0)), float(j.get("input_tp", -1.0))
    except Exception as ex:
        log(f"measure_loudness gagal: {ex}")
    return None, None


def _measure_after_filter(src, af: str) -> tuple[float | None, float | None]:
    """(LUFS, true peak) sebuah file SETELAH dilewat filter tertentu.

    Kedua angka harus dari sinyal yang sudah lewat filter yang sama dengan
    keluaran, baru hitungan gain dan clamp TP bisa dipercaya.
    """
    import tempfile

    ff = ffmpeg_bin()
    if not ff:
        return None, None
    try:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "m.wav"
            r = subprocess.run([ff, "-y", "-v", "error", "-i", str(src), "-af", af,
                                "-c:a", "pcm_f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", str(p)],
                               capture_output=True, timeout=1800)
            if r.returncode != 0 or not p.is_file() or p.stat().st_size <= 1024:
                return None, None
            return measure_loudness(p)
    except Exception as ex:
        log(f"measure_after_filter gagal: {ex}")
        return None, None


def finish(src, dst, reference=None, true_peak_db: float = -1.0,
           target_lufs: float = TARGET_LUFS, highpass_hz: float = 0.0,
           clarity: bool = True) -> Path:
    """Loudness match + limiter (TP paling akhir). High-pass opsional.

    Urutan filter penting: ``volume`` harus di SEBELUM ``alimiter``, kalau tidak
    gain dapat menarik peak di atas -1 dBTP dan file FLAC yang dikonversi jadi
    clip.

    Loudness: kalau ``reference`` ada, targetnya ITU-R BS.1770 file referensi
    (lagu asli), sehingga karaoke terdengar pada level yang sama dengan lagu
    aslinya. Tanpa referensi dipakai ``target_lufs`` konstan.

    Loudness diukur ulang dengan filter yang sama seperti keluarannya, jadi
    gain akurat; kalau diukur sebelum highpass, energi bass yang ikut terpotong
    bikin hitungan meleset.
    """
    ff = ffmpeg_bin()
    
    
    
    
    
    
    
    
    
    _TP_MARGIN_DB = 0.5
    _TP_CORR_PAD_DB = 0.3
    _TP_MAX_ITER = 2

    def _ceil_to_limit(ceil_db: float) -> float:
        return min(0.999, max(0.0625, 10.0 ** (float(ceil_db) / 20.0)))

    def _render_chain(chain, dest_path) -> bool:
        cmd = [ff, "-y", "-i", str(src), "-af", ",".join(chain),
               "-c:a", "pcm_f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", str(dest_path)]
        r = subprocess.run(cmd, capture_output=True, timeout=1800)
        return r.returncode == 0 and dest_path.is_file() and dest_path.stat().st_size > 1024

    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    
    
    
    
    
    
    
    
    hp = f"highpass=f={float(highpass_hz):.1f}:poles=2" if highpass_hz and float(highpass_hz) > 0 else ""
    if not ff:
        shutil.copy(src, dst)
        return dst

    
    
    
    
    clarity_fx: list = []
    if clarity:
        clarity_fx = _guard_clarity(src, clarity_chain(with_hp=not bool(hp)),
                                    reference)
        if clarity_fx:
            log(f"clarity nyala: {', '.join(clarity_fx)}")
        else:
            log("clarity dilucuti guard sepenuhnya; lanjut tanpa EQ")

    gain = None
    base = list(clarity_fx) + ([hp] if hp else [])
    probe = ",".join(base) if base else "anull"
    cur_i, cur_tp = _measure_after_filter(src, probe)
    
    
    
    
    target = None
    if reference:
        ref_i, ref_tp = measure_loudness(reference)
        if ref_i is not None:
            target = ref_i
    if target is None:
        target = float(target_lufs)
    if cur_i is not None:
        
        
        
        
        
        
        g = float(np.clip(target - cur_i, -12.0, 12.0))
        if abs(g) >= 0.2:
            gain = g
            ref_note = ""
            if reference:
                ref_i2, _ = measure_loudness(reference)
                if ref_i2 is not None:
                    ref_note = f" (match original {ref_i2:.1f} LUFS)"
            tp_note = f", TP {cur_tp:+.2f} dBTP" if cur_tp is not None else ""
            log(f"loudness {cur_i:.1f} -> {target:.1f} LUFS ({g:+.2f}dB){ref_note}{tp_note}")

    
    
    
    
    extra = max(0.0, (gain - 3.0) if gain is not None else 0.0) * 0.75
    margin = _TP_MARGIN_DB + min(2.0, extra)
    ceil_db = float(true_peak_db) - margin
    limiter = f"alimiter=limit={_ceil_to_limit(ceil_db):.4f}:level=false:attack=5:release=50"
    if margin > _TP_MARGIN_DB + 1e-9:
        log(f"margin TP adaptif {margin:.2f}dB (gain {gain:+.2f}dB, master padat)")

    filters = list(base)
    if gain is not None:
        filters.append(f"volume={gain:.2f}dB")
    filters.append(limiter)

    if not _render_chain(filters, dst):
        log("finish gagal; pakai sumber apa adanya")
        shutil.copy(src, dst)
        return dst

    
    
    
    
    try:
        for _try in range(1 + _TP_MAX_ITER):
            out_i, out_tp = measure_loudness(dst)
            note = f"hasil akhir {out_i:.2f} LUFS" if out_i is not None else "hasil akhir"
            if out_tp is not None:
                note += f", TP {out_tp:+.2f} dBTP"
            log(note)
            if out_tp is None or out_tp <= float(true_peak_db):
                break
            over = (out_tp - float(true_peak_db)) + _TP_CORR_PAD_DB
            ceil_db -= over
            log(f"true peak {out_tp:+.2f} > {float(true_peak_db):.1f} dBTP, "
                f"render ulang plafon limiter {ceil_db:.2f}dB")
            limiter = f"alimiter=limit={_ceil_to_limit(ceil_db):.4f}:level=false:attack=5:release=50"
            filters2 = list(base)
            if gain is not None:
                filters2.append(f"volume={gain:.2f}dB")
            filters2.append(limiter)
            tmp = dst.with_name("_tpretry_" + dst.name)
            if not _render_chain(filters2, tmp):
                log("render ulang TP gagal; hasil sebelumnya dipakai")
                try:
                    tmp.unlink()
                except Exception:
                    pass
                break
            tmp.replace(dst)
        fin_i, fin_tp = measure_loudness(dst)
        if fin_i is not None or fin_tp is not None:
            log(f"final {fin_i if fin_i is not None else '?'} LUFS, "
                f"TP {fin_tp if fin_tp is not None else '?'} dBTP")
    except Exception as ex:
        log(f"verifikasi TP dilewati: {ex}")
    return dst






def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Karaoke post-processing")
    ap.add_argument("--inst", required=True, help="wav instrumental mentah dari model")
    ap.add_argument("--vocal", default="", help="diabaikan (masking sudah dihapus)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--vocal-kill", type=float, default=1.0,
                    help="diabaikan; disimpan agar argumen lama tidak error")
    ap.add_argument("--vocal-kill-subtractive", type=float, default=1.0,
                    help="diabaikan; disimpan untuk kompatibilitas CLI")
    ap.add_argument("--centre-gamma", type=float, default=CENTRE_GAMMA,
                    help="diabaikan; disimpan untuk kompatibilitas CLI")
    ap.add_argument("--no-cleanup", action="store_true",
                    help="diabaikan; masking sudah tidak ada")
    ap.add_argument("--match-lufs", default="", help="file referensi untuk samakan loudness")
    ap.add_argument("--true-peak-db", type=float, default=-1.0)
    ap.add_argument("--highpass-hz", type=float, default=0.0,
                     help="0 = matikan (default). Filter high-pass merusak fase bass "
                          "dan menurunkan korelasi ke file karaoke referensi dari 0.986 jadi 0.871")
    ap.add_argument("--clarity", default="",
                     help="on/off: EQ lembut de-mud + presence + air dengan guard "
                          "spektral (default on; VOCALYX_NO_CLARITY=1 memaksa off)")
    args = ap.parse_args(argv)
    no_clarity_env = (os.environ.get("VOCALYX_NO_CLARITY") or "").strip().lower() in ("1", "true", "on", "yes")
    clarity_raw = str(args.clarity or "").strip().lower()
    if no_clarity_env:
        clarity_on = False
    elif clarity_raw in ("off", "0", "false", "no"):
        clarity_on = False
    else:
        clarity_on = True

    inst = load_audio(args.inst)

    
    
    
    
    
    
    
    
    
    emit_progress(88, "dsp:cleanup")
    log("masking dimatikan; instrumental dipakai apa adanya")

    out = finish(args.inst, args.out, reference=(args.match_lufs or None),
                 true_peak_db=args.true_peak_db, highpass_hz=args.highpass_hz,
                 clarity=clarity_on)
    emit_progress(93, "dsp:done")
    print(json.dumps({"vocals": "", "instrumental": str(out), "model": "karaoke-dsp"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
