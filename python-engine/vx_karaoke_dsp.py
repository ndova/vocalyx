"""VocaLyx engine - I/O audio + loudness finishing untuk karaoke.

Pipeline karaoke sekarang SESEDERHANA mungkin, dan itu disengaja.

Stem "Instrumental" dari model dipakai APA ADANYA, lalu hanya ditambah:
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
# Karaoke diratakan ke -13 LUFS, sekitar level lagu-lagu master modern dan
# sama dengan file karaoke lama yang sudah terbukti enak didengar. Tidak
# mengikuti loudness lagu aslinya karena itu membuat hasil antar lagu tidak
# konsisten (ada yang terasa jauh lebih pelan dari yang lain).
TARGET_LUFS = -13.0

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


# --------------------------------------------------------------------------
# audio io
# --------------------------------------------------------------------------

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
    # soundfile/stem sering keluar (N, C); kalau axis 0 bukan channel, balikkan
    # dulu — kalau tidak, penjumlah mid bisa salah mengambil 2 sampel.
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


# --------------------------------------------------------------------------
# stem math
# --------------------------------------------------------------------------


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


# --------------------------------------------------------------------------
# measurement + finishing
# --------------------------------------------------------------------------

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
           target_lufs: float = TARGET_LUFS, highpass_hz: float = 0.0) -> Path:
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
    # alimiter membatasi *sample* peak, padahal true peak (inter-sample) bisa
    # sampai ~0.9 dB lebih tinggi pada transien tajam (terbukti: margin 0.5 dB
    # memberi TP -1.15 di satu lagu tapi -0.61 di lagu lain). Margin tetap
    # tidak bisa menjamin semua materi, jadi kontrak true_peak_db ditegakkan
    # dengan verifikasi-dan-koreksi di bawah: ukur TP hasil akhir, dan bila
    # melanggar, turunkan tepat sebesar kelebihan + 0.3 dB lalu limit ulang.
    # Koreksi hanya terjadi bila perlu dan hanya sebesar yang perlu.
    _TP_MARGIN_DB = 0.5
    _TP_CORR_PAD_DB = 0.3
    limit = min(0.999, max(0.0625, 10.0 ** ((float(true_peak_db) - _TP_MARGIN_DB) / 20.0)))
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    # TIDAK ADA high-pass. Versi sebelumnya memakai
    # `highpass=f=30:poles=2` dan itu menggeser fase di bass: korelasi output
    # terhadap file karaoke yang bagus anjlok dari 0.986 jadi 0.871. Biquad
    # 2-pole di 30 Hz punya phase shift yang masih significant di bass, dan
    # lagu-lagu Indonesia umumnya bass-nya jadi band terkuat (diperksa pada
    # "Tere - Pencuri Hati": 60-250 Hz = 32.9 dB, tertinggi dari semua band).
    # Pipeline yang menghasilkan file bagus tidak memakai high-pass sama
    # sekali, jadi dijalankan ulang lewat --highpass-hz kalau memang perlu.
    hp = f"highpass=f={float(highpass_hz):.1f}:poles=2" if highpass_hz and float(highpass_hz) > 0 else ""
    limiter = f"alimiter=limit={limit:.4f}:level=false:attack=5:release=50"
    if not ff:
        shutil.copy(src, dst)
        return dst

    gain = None
    probe = hp or "anull"
    cur_i, cur_tp = _measure_after_filter(src, probe)
    # Kalau ada file referensi (lagu asli), samakan loudness ke ITU-R BS.1770
    # file itu -- inilah yang dilakukan pipeline yang menghasilkan file karaoke
    # yang bagus, dan hasilnya korelasi 0.987 dengan file tersebut. Tanpa
    # referensi, jatuh ke konstan TARGET_LUFS.
    target = None
    if reference:
        ref_i, ref_tp = measure_loudness(reference)
        if ref_i is not None:
            target = ref_i
    if target is None:
        target = float(target_lufs)
    if cur_i is not None:
        # Tidak di-clamp ke headroom TP. Percobaan menunjukkan strategi itu
        # justru merugikan: pada materi yang butuh gain besar, clamp keras
        # menahan gain di ~0 dB sehingga target meleset belasan LU, padahal
        # alimiter di akhir rantai sudah menjamin true peak tetap di plafon
        # dan LUFS hasil akhir selalu lebih tinggi tanpa clamp. Yang dibatasi
        # hanya magnitudo gain supaya tidak ada lonjakan tidak masuk akal.
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

    filters = [hp] if hp else []
    if gain is not None:
        filters.append(f"volume={gain:.2f}dB")
    filters.append(limiter)

    cmd = [ff, "-y", "-i", str(src), "-af", ",".join(filters),
           "-c:a", "pcm_f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", str(dst)]
    r = subprocess.run(cmd, capture_output=True, timeout=1800)
    if r.returncode != 0 or not dst.is_file() or dst.stat().st_size <= 1024:
        log(f"finish gagal ({(r.stderr or b'')[-300:]!r}); pakai sumber apa adanya")
        shutil.copy(src, dst)
        return dst

    # Tegakkan kontrak true peak: ukur hasil akhir, koreksi bila melanggar.
    # Satu iterasi cukup secara matematis — atenuasi menggeser TP turun tepat
    # sebesar koreksi, dan sampel sudah corr dB di bawah plafon limiter.
    try:
        out_i, out_tp = measure_loudness(dst)
        note = f"hasil akhir {out_i:.2f} LUFS" if out_i is not None else "hasil akhir"
        if out_tp is not None:
            note += f", TP {out_tp:+.2f} dBTP"
        log(note)
        if out_tp is not None and out_tp > float(true_peak_db):
            corr = (out_tp - float(true_peak_db)) + _TP_CORR_PAD_DB
            log(f"true peak {out_tp:+.2f} > {float(true_peak_db):.1f} dBTP, koreksi {-corr:.2f}dB")
            tmp = dst.with_name("_tpcorr_" + dst.name)
            r2 = subprocess.run(
                [ff, "-y", "-i", str(dst), "-af", f"volume={-corr:.2f}dB,{limiter}",
                 "-c:a", "pcm_f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", str(tmp)],
                capture_output=True, timeout=1800)
            if r2.returncode == 0 and tmp.is_file() and tmp.stat().st_size > 1024:
                tmp.replace(dst)
                fin_i, fin_tp = measure_loudness(dst)
                if fin_i is not None or fin_tp is not None:
                    log(f"setelah koreksi {fin_i if fin_i is not None else '?'} LUFS, "
                        f"TP {fin_tp if fin_tp is not None else '?'} dBTP")
            else:
                log(f"koreksi TP gagal ({(r2.stderr or b'')[-200:]!r}); hasil Pass-1 dipakai")
                try:
                    tmp.unlink()
                except Exception:
                    pass
    except Exception as ex:
        log(f"verifikasi TP dilewati: {ex}")
    return dst


# --------------------------------------------------------------------------
# CLI (dipakai vx_separate.py lewat protokol JSON yang sama dengan script lain)
# --------------------------------------------------------------------------

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
    args = ap.parse_args(argv)

    inst = load_audio(args.inst)

    # TIDAK ADA MASKING. Stem instrumental dari model dipakai apa adanya.
    #
    # Versi sebelumnya menjalankan dua mask multiplicatif berturut-turut di
    # channel mid (magnitude_subtract lalu adaptive_center_suppress) dengan mask
    # vokal dinaikkan +12 dB di 4-9 kHz. Hasilnya "suara air": harmonik vokal
    # terpotong sebagian sehingga terdengar seperti desis, dan burst envelope
    # 12-16 kHz naik dari 0.197 (sumber) ke 0.348. Detail backing ikut turun.
    # Pipeline polos yang lebih lama menghasilkan korelasi 0.987 dengan file
    # yangPENGGUNA sukai. Jangan tambahkan masking tanpa bukti baru.
    emit_progress(88, "dsp:cleanup")
    log("masking dimatikan; instrumental dipakai apa adanya")

    out = finish(args.inst, args.out, reference=(args.match_lufs or None),
                 true_peak_db=args.true_peak_db, highpass_hz=args.highpass_hz)
    emit_progress(93, "dsp:done")
    print(json.dumps({"vocals": "", "instrumental": str(out), "model": "karaoke-dsp"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
