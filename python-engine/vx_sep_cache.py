import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from vx_core import APP_DIR, SUPPORTED, _probe_audio, device_pick, ffmpeg_bin, ffprobe_bin, log


# Tier Best: dua preset, keduanya memakai stem instrumental model APA ADANYA
# (tanpa masking) lalu di-loudness-match. Lihat KARAOKE_PRESETS.
#
# Riwayat penting — jangan dikembalikan ke model RoFormer + masking tanpa
# bukti. Versi sebelumnya memakai `bs_roformer_karaoke_anvuew` dan menambah
# tiga tahap post-processing (magnitude_subtract, adaptive_center_suppress,
# boost HF). Hasilnya suara "gemericik air" dan desis rusak._quantitasnya
# terukur: burst envelope 12-16 kHz di frame hening naik dari 0.197 (file
# sumber) jadi 0.348, dan mask ganda memotong harmonik vokal separuh-setengah.
# Pipeline sederhana yang lebih lama justru menghasilkan korelasi 0.987 dengan
# file yangPENGGUNA sukai. Kecepatan juga turun 4.3x (26.2 -> 6.1 detik/menit).
BEST_MODEL = ("Kim_Vocal_2.onnx", 1.0)

# Preset Best alternatif: RoFormer. Lebih lambat (~26 detik/menit) dan butuh
# VRAM ~1 GB, jadi bukan default, tapi tetap disediakan sebagai pilihan.
BEST_MODEL_ROFORMER = ("bs_roformer_instrumental_resurrection_unwa.ckpt", 1.0)

# Tier standard: satu model RoFormer instrumental ringan (204 MB).
STANDARD_MODEL = ("bs_roformer_instrumental_resurrection_unwa.ckpt", 1.0)

# Fallback bila RoFormer gagal total (OOM/download gagal): set MDX lama.
# Disimpan, bukan dihapus — itu jalur fallback yang disetujui user.
MDX_FALLBACK_WEIGHTS = (
    ("Kim_Inst.onnx", 0.35),
    ("UVR-MDX-NET-Inst_HQ_4.onnx", 0.25),
    ("Kim_Vocal_2.onnx", 0.25),
    ("UVR-MDX-NET-Voc_FT.onnx", 0.15),
)
MDX_FALLBACK_STANDARD = ("Kim_Vocal_2.onnx", 1.0)

# Kompatibilitas: nama lama dipakai _available/_missing_ensemble_models.
# Ensemble sudah dibuang (mask ganda + max-per-bin justru lebih buruk), jadi
# affidavit ini sekarang menunjuk ke preset RoFormer tunggal.
ENSEMBLE_MODEL_WEIGHTS = (BEST_MODEL_ROFORMER,)

# Preset karaoke yang bisa dipilih user. Key = nilai di <select id="karaokeQuality">.
# karaoke_full (v23): ensemble dua model vocal-vs-instrumental -> menghapus
# SEMUA vokal (lead + backing). Alternatif untuk lagu yang backing-nya
# mengganggu; default tetap karaoke_aufr33 (lead-out, backing dipertahankan).
KARAOKE_PRESETS = {
    "karaoke_aufr33": ("mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt", 1.0),
    "karaoke_full": ("Kim_Vocal_2.onnx", 1.0),
    # jalur CPU: MDX-Net Inst_HQ_4 adalah yang tercepat dari benchmark CPU
    # (34 dtk untuk klip 60 dtk; Resurrection ~371 dtk).
    "cpu_inst_hq": ("UVR-MDX-NET-Inst_HQ_4.onnx", 1.0),
}

# Model dereverb tahap-2 (v14): ikut sidik jari supaya cache lama (tanpa
# dereverb/clarity) otomatis dianggap stale begitu file modelnya hadir.
DEREVERB_MODELS = (
    "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt",
    "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
)

# Ensemble karaoke (v16, preset karaoke_aufr33): dua model karaoke MelBand
# (aufr33/viperx + gabox_v2; versi resmi 3-model dengan becruily, tapi
# becruily terlalu berat di RTX 3050 4 GB). Algoritma default min_fft (v17):
# tutup bin sisa vokal yang hanya bersih di satu model (pola vocal_clean
# komunitas); avg mengawetkan spektrum tapi juga sisa vokalnya.
# Dijalankan sekuensial (VRAM aman); satu gagal -> satunya dipakai.
AUFR33_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
GABOX_V2_MODEL = "mel_band_roformer_karaoke_gabox_v2.ckpt"
KIM_VOCAL_2_MODEL = "Kim_Vocal_2.onnx"
INST_HQ_4_MODEL = "UVR-MDX-NET-Inst_HQ_4.onnx"
KARAOKE_ENSEMBLE = {
    "karaoke_aufr33": ((AUFR33_MODEL, 0.5), (GABOX_V2_MODEL, 0.5)),
    "karaoke_full": ((KIM_VOCAL_2_MODEL, 0.5), (INST_HQ_4_MODEL, 0.5)),
}
# Algoritma gabung default per preset (v23): karaoke_full selalu ensemble
# avg_wave (kedua model ONNX cepat, saling menutupi residu); karaoke_aufr33
# default single (ensemble opt-in, terbukti ensemble-min menumpulkan lagu
# padat). Bisa dioverride via --ens-algo / VOCALYX_ENS_ALGO.
KARAOKE_ENSEMBLE_ALGO = {
    "karaoke_full": "avg_wave",
}

ALL_MODELS = tuple(dict.fromkeys(
    [BEST_MODEL[0], BEST_MODEL_ROFORMER[0], STANDARD_MODEL[0]]
    + [name for name, _ in MDX_FALLBACK_WEIGHTS]
    + list(DEREVERB_MODELS)
    + [GABOX_V2_MODEL]
))

# Naikkan setiap kali math stem atau rantai post-processing berubah supaya
# cache lama (yang vocalnya masih bocor) otomatis regarded stale.
# v5: keluaran dikurung ke 16-bit (ukuran turun ~40%) dan loudness dipatok
#     ke TARGET_LUFS -13, jadi hasil lama tidak cocok lagi.
# v6: separator ganti MDX-Net -> RoFormer (preset instrumental_clean);
#     hasil MDX tidak sebanding dan harus diregenerasi.
# v7: mask residual vokal dari stem sekunder model (center-suppress yang
#     sebelumnya no-op kini bekerja) + vocal_kill diteruskan ke DSP.
# v8: pengurangan vokal eksplisit (inst - vocal_kill*sekunder), bukan hanya
#     mask. Cache v7 masih mengandung vokal yang tidak dikurangi.
# v9: quality=high pindah dari ensemble 2-model ke SATU model karaoke.
#     Cache v8 untuk tier high berisi hasil ensemble yang vokalnya bocor,
#     jadi wajib regarded stale walau fingerprint model tidak berubah.
# v10: instrumental-primary tidak lagi dibagi peak(mix). Stem audio-separator
#      0.47 sudah berskala mix, jadi /=peak memperbesar 2.4x (+7.7 dB): cymbal
#      ter-boost dan stem sekunder (vokal) tidak sinkron -> pengurangan
#      eksplisit mengembalikan vokal (korelasi 0.985). Sekarang skala stem
#      dikalibrasi least-squares ke mix dan stem sekunder hanya jadi mask.
# v11: jalur vocal-primary ganti `mix - gain*est` (subtract time-domain) jadi
#      mask rasio magnitudo. Subtract time-domain butuh est sejajar fase;
#      karena tidak pernah sempurna, residunya ber-comb-filter = "suara air".
#      Mask vokal juga dinaikkan +12 dB di 4-9 kHz supaya ikut menutup sibilan
#      (model RoFormer paling lemah di band itu). Cache v10 tidak dipakai lagi.
# v12: REVERT ke jalur sederhana. Preset Best kembali ke Kim_Vocal_2 dan stem
#      instrumental dipakai APA ADANYA: magnitude_subtract, adaptive_center_suppress
#      dan boost HF dikeluarkan dari pipeline. Ketiga tahap itu yang menghasilkan
#      "suara air" (burst 12-16 kHz 0.197 -> 0.348). Rantai loudness sekarang
#      match ke LUFS input, bukan konstan -13. Semua cache v11 wajib regarded
#      stale karena karakter bunyinya beda total.
# v13: Preset "high" (Kim_Vocal_2), "roformer", dan "standard" (resmi) dihapus
#      dari KARAOKE_PRESETS; default pindah ke karaoke_aufr33. Preset
#      karaoke_becruily dihapus karena terlalu berat (~1 jam/lagu di RTX 3050 4 GB).
# v14: preset karaoke_aufr33 (CUDA) + tahap-2 dereverb MelBand anvuew
#      (less-aggressive dulu, blend 65/35, fallback mentah) + clarity EQ
#      lembut ber-guard di finish(). Cache v13 wajib dianggap stale karena
#      karakter bunyi berubah (reverb berkurang, mid/treble lebih terbuka).
# v15: overlap inferensi MDXC/RoFormer 4 (yaml) -> 8 via mdxc_params, khusus
#      model .ckpt (praktik standar UVR/MVSEP; mask lebih halus di batas
#      chunk). Dereverb default MATI (bukan masalahnya + menumpulkan mid/high;
#      opt-in via env). Cache v14 wajib stale (stem beda di sumbernya).
# v16: preset karaoke_aufr33 jadi ENSEMBLE 2 model karaoke MelBand
#      (aufr33/viperx + gabox_v2, avg waveform — preset karaoke resmi
#      komunitas versi 2-model; becruily dikecualikan karena terlalu berat).
#      Cache v15 wajib stale (instrumental = rata-rata 2 model).
# v17: ensemble default min_fft (tutup sisa vokal per-bin ala vocal_clean;
#      avg mengawetkan spektrum tapi juga sisa vokalnya) + clarity dijinakkan
#      (presence +1.0, air +0.5 — EQ lama ikut mengangkat pecahan sisa vokal
#      +0.6 dB di atas mix). Cache v16 wajib stale.
# v18: default kembali SINGLE (ensemble-min terbukti menumpulkan air
#      -3.82 vs -1.98 dan residual sepi -0.03 vs -0.87 di lagu padat;
#      ensemble jadi opt-in --ensemble/VOCALYX_ENSEMBLE=1). Cache v17 stale.
# v19: koreksi TP iteratif via plafon limiter (bukan potong rata) + margin
#      adaptif untuk master padat. Kasus The Call: final -10.63 LUFS (3.1 LU
#      di bawah target -7.5) karena koreksi lama memotong rata -1.51 dB.
#      Cache v18 wajib stale (level akhir berubah).
# v20: bass guard — low-shelf -1 dB @150 Hz + tilt-guard relatif. Lead hilang
#      -> gain match mengangkat bass (+0.5 dB relatif terukur) + unmasking
#      bikin bass telanjang terdengar nendang. Cache v19 wajib stale.
# v21: CABUT total shelf + tilt-guard v20 — premis terbalik, bass hasil justru
#      KURANG nendang (soal transient limiter, bukan level). Rantai EQ kembali
#      ke clarity v19 (de-mud + presence + air + guard). Cache v20 stale.
# v22: boost bertingkat untuk detail/renyah (tekstur utuh, level -2 dB):
#      bite bell +1 dB @3.2 kHz Q1 + air shelf +1.5 dB @11 kHz (dari +0.5),
#      presence tetap (zona sisa vokal) + penjaga quiet_residual (bite gugur
#      bila sisa sepi naik >+1 dB vs mix). Cache v21 wajib stale.
# v23: preset baru karaoke_full = ensemble Kim_Vocal_2 + Inst_HQ_4 (avg_wave,
#      default ensemble) untuk menghapus SEMUA vokal incl. backing. aufr33
#      tetap default single. Cache v22 wajib stale (preset/algo baru).
# v24: overlap OTOMATIS berdasar total VRAM (< 6 GB -> 4, di atasnya 8;
#      sinkron nasihat tier precheck Rust). GPU 4 GB kembali ke overlap 4
#      (hemat memori; terukur setara di klip uji). Cache v23 wajib stale.
KARAOKE_DSP_VERSION = 24

PERSIST_META = "karaoke_meta.json"


_CONTENT_TYPE_FALLBACK = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/x-m4a": ".m4a",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/opus": ".ogg",
}

_MEDIA_TYPE = {
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
}

_CACHE_MAX_AGE_DAYS = 7
_LAST_SWEEP = 0.0


def _model_dir() -> Path:
    override = (os.environ.get("VOCALYX_MODELS_DIR") or "").strip()
    if override:
        return Path(override)
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "audio-separator-models"


def _available_ensemble_models() -> list[tuple[str, float]]:
    model_dir = _model_dir()
    return [(name, weight) for name, weight in ENSEMBLE_MODEL_WEIGHTS if (model_dir / name).is_file()]


def _missing_ensemble_models() -> list[str]:
    model_dir = _model_dir()
    return [name for name, _ in ENSEMBLE_MODEL_WEIGHTS if not (model_dir / name).is_file()]


def _missing_best_models(preset: str = "karaoke_aufr33") -> list[str]:
    """Model yang belum ada untuk preset Best tertentu (termasuk ensemble)."""
    model_dir = _model_dir()
    ens = KARAOKE_ENSEMBLE.get(preset)
    if ens:
        return [name for name, _ in ens if not (model_dir / name).is_file()]
    weights = KARAOKE_PRESETS.get(preset) or BEST_MODEL
    name = weights[0]
    return [] if (model_dir / name).is_file() else [name]


def _renormalized_ensemble_weights() -> list[tuple[str, float]]:
    available = _available_ensemble_models()
    total = sum(weight for _, weight in available)
    if total <= 0:
        return []
    return [(name, weight / total) for name, weight in available]


def _model_fingerprint() -> str:
    ver = KARAOKE_DSP_VERSION
    try:
        model_dir = _model_dir()
        parts = [f"dsp:{ver}"]
        for name in ALL_MODELS:
            p = model_dir / name
            if p.is_file():
                st = p.stat()
                parts.append(f"{name}:{st.st_size}:{int(st.st_mtime)}")
        if len(parts) <= 1:
            return f"dsp:{ver}|no-models"
        return hashlib.md5("|".join(parts).encode()).hexdigest()
    except Exception:
        return f"dsp:{ver}|model-probe-failed"


# --------------------------------------------------------------------------
# cache persisten di folder musik (mdx_extra/<stem>/)
# --------------------------------------------------------------------------

def _persist_dir(persist_base, stem: str) -> Path:
    return Path(persist_base) / "mdx_extra" / stem


def _persist_meta_path(persist_base, stem: str) -> Path:
    return _persist_dir(persist_base, stem) / PERSIST_META


def _persist_file(persist_base, stem: str, target_format: str) -> Path | None:
    """File karaoke persisten yang ada, kalau ada."""
    d = _persist_dir(persist_base, stem)
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    for e in (target_format, "flac", "wav", "ogg", "mp3", "m4a"):
        c = d / f"no_vocals.{e}"
        try:
            if c.is_file() and c.stat().st_size > 1024:
                return c
        except Exception:
            pass
    return None


def _persist_meta(persist_base, stem: str) -> dict | None:
    p = _persist_meta_path(persist_base, stem)
    try:
        if p.is_file():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _persist_signature(mode: str, quality: str, vocal_kill: float, centre_kill: float,
                       match_level: bool, models: dict, clarity: bool = True) -> dict:
    return {
        "version": KARAOKE_DSP_VERSION,
        "mode": mode,
        "quality": quality,
        "vocal_kill": round(float(vocal_kill), 3),
        "centre_kill": round(float(centre_kill), 3),
        "match_level": bool(match_level),
        "clarity": bool(clarity),
        "models": models or {},
    }


def _persist_matches(meta: dict | None, sig: dict) -> bool:
    """Cache lama tanpa meta, atau meta versi lama, dianggap stale."""
    if not isinstance(meta, dict):
        return False
    try:
        if int(meta.get("version", -1)) != int(sig["version"]):
            return False
        if str(meta.get("mode", "")) != sig["mode"]:
            return False
        if str(meta.get("quality", "")) != sig["quality"]:
            return False
        if abs(float(meta.get("vocal_kill", -1)) - sig["vocal_kill"]) > 1e-6:
            return False
        if abs(float(meta.get("centre_kill", -1)) - sig["centre_kill"]) > 1e-6:
            return False
        if bool(meta.get("match_level")) != sig["match_level"]:
            return False
        # Meta lama (v13) tidak punya kunci clarity -> get default True; tapi
        # meta v13 sudah gugur di cek version di atas, jadi ini hanya untuk
        # bedakan on/off di versi yang sama.
        if bool(meta.get("clarity", True)) != bool(sig.get("clarity", True)):
            return False
        return True
    except Exception:
        return False


def _write_persist_meta(persist_base, stem: str, sig: dict) -> None:
    try:
        p = _persist_meta_path(persist_base, stem)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(sig, indent=1), encoding="utf-8")
    except Exception:
        pass


def _drop_stale_persist(persist_base, stem: str) -> None:
    """Buang hasil lama supaya tidak pernah dipakai sebagai cache hit."""
    d = _persist_dir(persist_base, stem)
    try:
        for f in list(d.glob("no_vocals.*")):
            if f.is_file():
                f.unlink()
    except Exception:
        pass
    try:
        _persist_meta_path(persist_base, stem).unlink()
    except Exception:
        pass



def _sweep_stale_cache():
    global _LAST_SWEEP
    now = time.time()
    if now - _LAST_SWEEP < 86400:
        return 0
    _LAST_SWEEP = now
    cutoff = now - _CACHE_MAX_AGE_DAYS * 86400
    freed = 0
    try:
        for p in APP_DIR.glob("*_karaoke.*"):
            try:
                if p.is_file() and p.stat().st_mtime < cutoff:
                    freed += p.stat().st_size
                    p.unlink()
            except Exception:
                pass
        for p in APP_DIR.glob("kar-*.log"):
            try:
                if p.is_file() and p.stat().st_mtime < cutoff:
                    p.unlink()
            except Exception:
                pass
    except Exception:
        pass
    return freed


def _mdx_prune_wav(stem_dir):
    try:
        d = Path(stem_dir)
        wav = d / "no_vocals.wav"
        if not wav.is_file():
            return False
        others = [p for p in d.glob("no_vocals.*")
                  if p.is_file() and p.suffix.lower() not in (".wav",)
                  and not p.name.startswith(".") and p.stat().st_size > 1024]
        if not others:
            return False
        wav.unlink()
        log.info("karaoke mdx_extra prune wav: %s", wav)
        return True
    except Exception:
        return False


def _resolve_persist(track_path: str | None):
    try:
        if track_path:
            tp = Path(track_path)
            if tp.is_file() and tp.parent.exists():
                return tp.parent, tp.stem
    except Exception:
        pass
    return None, None


def _mdx_has_persist(persist_base, stem, target_format) -> bool:
    return _persist_file(persist_base, stem, target_format) is not None


def _inside_app_dir(p: str | None) -> Path | None:
    try:
        if not p:
            return None
        rp = Path(p).resolve()
        if rp == APP_DIR.resolve() or APP_DIR.resolve() not in rp.parents:
            return None
        return rp
    except Exception:
        return None


def _resolve_suffix(filename: str | None, content_type: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix in SUPPORTED:
        return suffix
    if not suffix and content_type:
        ct = (content_type or "").split(";")[0].strip().lower()
        mapped = _CONTENT_TYPE_FALLBACK.get(ct)
        if mapped and mapped in SUPPORTED:
            return mapped
    if not suffix:
        log.warning("separate: filename tanpa ekstensi (%r, ct=%r) -> default .mp3", filename, content_type)
        return ".mp3"
    return suffix


def _resolve_device(requested: str | None) -> str:
    r = (requested or "auto").lower()
    if r in ("cuda", "gpu"):
        return "cuda"
    if r == "cpu":
        return "cpu"
    return device_pick()


def _get_duration(path: Path) -> float | None:
    try:
        fp = ffprobe_bin()
        if fp:
            proc = subprocess.run(
                [fp, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                capture_output=True, text=True, timeout=20,
            )
            return float((proc.stdout or "").strip().split()[0])
    except Exception:
        pass
    try:
        info = _probe_audio(path)
        if info.get("duration"):
            return float(info["duration"])
    except Exception:
        pass
    return None


def _trim_to_duration(path: Path, orig_dur: float | None) -> Path:
    if not orig_dur or orig_dur <= 0:
        return path
    inst_dur = _get_duration(path)
    if not inst_dur or abs(inst_dur - orig_dur) <= 0.12:
        return path
    ff = ffmpeg_bin()
    if not ff:
        return path
    try:
        tmp = path.parent / f"_trim_{path.name}"
        subprocess.run([ff, "-y", "-i", str(path), "-t", f"{orig_dur:.3f}",
                        "-c:a", "pcm_s16le", str(tmp)],
                       check=True, capture_output=True, timeout=300)
        shutil.move(str(tmp), str(path))
        log.info("karaoke trim %.2fs -> %.2fs", inst_dur, orig_dur)
    except Exception as e:
        log.warning("karaoke trim gagal: %s", e)
    return path


def _convert_wav_to_target(wav_path: Path, target_format: str, out_path: Path) -> Path:
    """wav intermediate -> format tujuan, selalu di 16-bit.

    Intermediate hasil ``finish()`` adalah float 32-bit; kalau bit depth tidak
    dipaksa, ffmpeg memilih 24-bit untuk FLAC sehingga ukuran melonjak ~70%
    (28.5 MB -> 48.9 MB) tanpa keuntungan dengar apa pun - 16-bit sudah SNR
    ~96 dB dan tersisa ~76 dB setelah re-encode. Script lama juga menghasilkan
    16-bit, tapi hanya karena ia tidak pernah menyebut ``-c-a`` sama sekali
    (default wav = pcm_s16le), bukan karena memilihnya.
    """
    fmt = (target_format or "flac").lower().lstrip(".")
    if fmt not in ("flac", "ogg", "wav"):
        fmt = "flac"
    ff = ffmpeg_bin()
    if not ff:
        shutil.copy(wav_path, out_path.with_suffix(".wav"))
        return out_path.with_suffix(".wav")
    dest = out_path.with_suffix(f".{fmt}")
    if fmt == "flac":
        cmd = [ff, "-y", "-i", str(wav_path), "-sample_fmt", "s16",
               "-codec:a", "flac", "-compression_level", "5", str(dest)]
    elif fmt == "wav":
        cmd = [ff, "-y", "-i", str(wav_path), "-sample_fmt", "s16",
               "-codec:a", "pcm_s16le", str(dest)]
    else:
        cmd = [ff, "-y", "-i", str(wav_path), "-codec:a", "libvorbis",
               "-qscale:a", "3", str(dest)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=600)
    try:
        if dest.exists() and dest.stat().st_size > 1024:
            wav_path.unlink(missing_ok=True)
    except Exception:
        pass
    return dest
