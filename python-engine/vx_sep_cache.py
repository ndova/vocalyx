import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from vx_core import APP_DIR, SUPPORTED, _probe_audio, device_pick, ffmpeg_bin, ffprobe_bin, log













BEST_MODEL = ("Kim_Vocal_2.onnx", 1.0)



BEST_MODEL_ROFORMER = ("bs_roformer_instrumental_resurrection_unwa.ckpt", 1.0)


STANDARD_MODEL = ("bs_roformer_instrumental_resurrection_unwa.ckpt", 1.0)



MDX_FALLBACK_WEIGHTS = (
    ("Kim_Inst.onnx", 0.35),
    ("UVR-MDX-NET-Inst_HQ_4.onnx", 0.25),
    ("Kim_Vocal_2.onnx", 0.25),
    ("UVR-MDX-NET-Voc_FT.onnx", 0.15),
)
MDX_FALLBACK_STANDARD = ("Kim_Vocal_2.onnx", 1.0)




ENSEMBLE_MODEL_WEIGHTS = (BEST_MODEL_ROFORMER,)





KARAOKE_PRESETS = {
    "karaoke_aufr33": ("mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt", 1.0),
    "karaoke_full": ("Kim_Vocal_2.onnx", 1.0),
    
    
    "cpu_inst_hq": ("UVR-MDX-NET-Inst_HQ_4.onnx", 1.0),
}



DEREVERB_MODELS = (
    "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt",
    "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
)







AUFR33_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
GABOX_V2_MODEL = "mel_band_roformer_karaoke_gabox_v2.ckpt"
KIM_VOCAL_2_MODEL = "Kim_Vocal_2.onnx"
INST_HQ_4_MODEL = "UVR-MDX-NET-Inst_HQ_4.onnx"
KARAOKE_ENSEMBLE = {
    "karaoke_aufr33": ((AUFR33_MODEL, 0.5), (GABOX_V2_MODEL, 0.5)),
    "karaoke_full": ((KIM_VOCAL_2_MODEL, 0.5), (INST_HQ_4_MODEL, 0.5)),
}




KARAOKE_ENSEMBLE_ALGO = {
    "karaoke_full": "avg_wave",
}

ALL_MODELS = tuple(dict.fromkeys(
    [BEST_MODEL[0], BEST_MODEL_ROFORMER[0], STANDARD_MODEL[0]]
    + [name for name, _ in MDX_FALLBACK_WEIGHTS]
    + list(DEREVERB_MODELS)
    + [GABOX_V2_MODEL]
))








































































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
