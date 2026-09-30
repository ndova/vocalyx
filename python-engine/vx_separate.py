"""VocaLyx engine - karaoke vocal separation (port music-dl BS-RoFormer).

Port dari music-dl:
- scripts/bs_roformer_ensemble.py (high: 3-model parallel ensemble Kim 0.5 +
  UVR-MDX-NET-Vocal-FT 0.3 + Inst_HQ_4 0.2, amix weighted, loudnorm ke LUFS input)
- scripts/bs_roformer_separate.py (standard: single Kim_Vocal_2 + fallback,
  loudness-match gain + limiter)
- runDemucsSeparation: device auto-detect, spawn + progress parse,
  trimToDuration (toleransi 0.12s), hapus vocals.*, cache mdx_extra/no_vocals.*
- convertKaraokeWavToTarget: wav -> flac (-compression_level 5) /
  ogg (libvorbis -qscale:a 3) / wav, hapus wav bila hasil >1024b
- action progress/checkKaraoke/karaoke/cancelKaraoke -> job API di bawah

API (job-based, non-blocking agar UI bisa polling + cancel):
- POST /separate (multipart file, mode, quality, device, format, model)
  -> {"ok": True, "job_id": ...} (atau cache-hit langsung done)
- GET /separate/progress?job_id=... -> {status, pct, stage, error?}
- GET /separate/result?job_id=... -> FileResponse audio bila done
- POST /separate/cancel {"job_id": ...} -> batalkan proses
- GET /karaoke -> kapabilitas torch/cuda + model
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from vx_core import APP_DIR, SUPPORTED, _probe_audio, device_pick, ffmpeg_bin, ffprobe_bin, log, to_wav

router = APIRouter()

SCRIPTS_DIR = Path(__file__).parent / "scripts"
ENSEMBLE_SCRIPT = SCRIPTS_DIR / "bs_roformer_ensemble.py"
SEPARATE_SCRIPT = SCRIPTS_DIR / "bs_roformer_separate.py"

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

_JOBS: dict = {}
_JOBS_LOCK = threading.Lock()

_CACHE_MAX_AGE_DAYS = 7
_LAST_SWEEP = 0.0


def _sweep_stale_cache():
    """Hapus file cache karaoke + log job yg lebih tua dari batas (throttle 24 jam)."""
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
    """Hapus no_vocals.wav intermediate bila varian target sudah tersimpan.

    Aman: tidak menghapus bila wav adalah satu-satunya file (fallback),
    dan tidak menghapus bila target_format memang wav (ditandai via keep).
    Return True bila benar menghapus."""
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
    """(persist_base, stem) untuk lagu lokal valid, else (None, None)."""
    try:
        if track_path:
            tp = Path(track_path)
            if tp.is_file() and tp.parent.exists():
                return tp.parent, tp.stem
    except Exception:
        pass
    return None, None


def _mdx_has_persist(persist_base, stem, target_format) -> bool:
    """True bila mdx_extra/<stem>/ punya no_vocals.* valid (sumber kebenaran)."""
    try:
        d = Path(persist_base) / "mdx_extra" / stem
        for e in (target_format, "flac", "wav", "ogg", "mp3", "m4a"):
            c = d / f"no_vocals.{e}"
            try:
                if c.is_file() and c.stat().st_size > 1024:
                    return True
            except Exception:
                pass
    except Exception:
        pass
    return False


def _inside_app_dir(p: str | None) -> Path | None:
    """Validasi path hasil/log benar di dalam APP_DIR (cegah path traversal)."""
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
    """Tentukan ekstensi upload. Fix bug 'Format tidak didukung' saat
    frontend mengirim filename tanpa ekstensi (t.name = file_stem)."""
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
    """Samakan durasi instrumental dengan original (toleransi 0.12s, ala music-dl)."""
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
    """Port convertKaraokeWavToTarget dari music-dl route.ts."""
    fmt = (target_format or "flac").lower().lstrip(".")
    if fmt not in ("flac", "ogg", "wav"):
        fmt = "flac"
    if fmt == "wav":
        shutil.copy(wav_path, out_path.with_suffix(".wav"))
        return out_path.with_suffix(".wav")
    ff = ffmpeg_bin()
    if not ff:
        shutil.copy(wav_path, out_path.with_suffix(".wav"))
        return out_path.with_suffix(".wav")
    dest = out_path.with_suffix(f".{fmt}")
    if fmt == "flac":
        cmd = [ff, "-y", "-i", str(wav_path), "-codec:a", "flac",
               "-compression_level", "5", str(dest)]
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


def _spawn_env(force_cpu: bool = False) -> dict:
    """Env untuk subprocess karaoke (script BS-RoFormer / demucs).

    PATH hanya boleh diberi direktori yang benar-benar memuat `ffmpeg` bernama
    polos: audio_separator memanggil `check_output(["ffmpeg", "-version"])` dan
    akan kena WinError 2 kalau tidak ketemu. Binary imageio-ffmpeg tidak
    memenuhi syarat itu, jadi jangan asal prepend.
    """
    env = os.environ.copy()
    if force_cpu:
        env["CUDA_VISIBLE_DEVICES"] = ""
    try:
        ff = ffmpeg_bin()
    except Exception:
        ff = None
    if ff and ff != "ffmpeg":
        d = Path(ff).parent
        if (d / "ffmpeg.exe").is_file() or (d / "ffmpeg").is_file():
            parts = env.get("PATH", "").lower().split(os.pathsep)
            if str(d).lower() not in parts:
                env["PATH"] = str(d) + os.pathsep + env.get("PATH", "")
        env["FFMPEG_BINARY"] = ff
    return env


def _run_script(job_id: str, script: Path, args: list, log_path: Path,
               Heartbeat_stage: str = "separate"):
    """Jalankan script music-dl via Popen, parse stdout karaoke_progress.
    - `python -u` (unbuffered) agar emit progres real-time.
    - stderr dialirkan ke FILE (bukan PIPE) agar tidak deadlock saat log
      ONNX/traceback memenuhi pipe buffer — pola music-dl (drain kedua stream).
    Return (instrumental_wav | None, final_json)."""
    final = {}
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_fh = open(log_path, "w", encoding="utf-8", errors="replace")
    except Exception:
        log_fh = None
    proc = None
    try:
        dev_arg = str(args[2]).lower() if len(args) >= 3 else ""
        proc = subprocess.Popen(
            [sys.executable, "-u", str(script), *args],
            stdout=subprocess.PIPE, stderr=log_fh,
            text=True, bufsize=1, env=_spawn_env(force_cpu=(dev_arg == "cpu")),
        )
        with _JOBS_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["proc"] = proc
        assert proc.stdout is not None
        for line in proc.stdout:
            with _JOBS_LOCK:
                cancelled = _JOBS.get(job_id, {}).get("cancel_requested")
            if cancelled:
                try:
                    proc.kill()
                except Exception:
                    pass
                return None, {}
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if "karaoke_progress" in obj:
                try:
                    pct = float(obj["karaoke_progress"])
                except Exception:
                    continue
                stage = str(obj.get("karaoke_stage", Heartbeat_stage))
                with _JOBS_LOCK:
                    if job_id in _JOBS:
                        _JOBS[job_id].update(pct=pct, stage=stage, status="processing",
                                             at=time.time())
            elif "instrumental" in obj:
                final = obj
        try:
            proc.wait(timeout=60)
        except Exception:
            pass
        if proc.returncode not in (0, None) and not final:
            tail = _tail_log(log_path, 15)
            log.warning("karaoke script %s exit=%s err=%s", script.name, proc.returncode, tail[-1500:])
            with _JOBS_LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id]["script_error"] = tail[-1500:]
        return (Path(final["instrumental"]) if final.get("instrumental") else None), final
    except Exception as e:
        log.warning("karaoke spawn gagal: %s", e)
        return None, {}
    finally:
        try:
            if log_fh:
                log_fh.close()
        except Exception:
            pass
        with _JOBS_LOCK:
            if job_id in _JOBS and _JOBS[job_id].get("proc") is proc:
                _JOBS[job_id]["proc"] = None


def _tail_log(path: Path, n: int = 40) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return "".join(lines[-n:])
    except Exception:
        return ""


def _demucs_fallback(job_id: str, wav: Path, out_dir: Path, mode: str, device: str) -> Path | None:
    """Fallback Demucs htdemucs bila script ONNX gagal/OOM (dipertahankan dari kode lama)."""
    with _JOBS_LOCK:
        if job_id in _JOBS:
            _JOBS[job_id].update(pct=90.0, stage="demucs-fallback", status="processing")
    cmd = [
        sys.executable, "-m", "demucs",
        "--two-stems=vocals", "-n", "htdemucs",
        "--device", device, "--segment", "7",
        "--overlap", "0.25", "--shifts", "1",
        "--mp3", "--mp3-bitrate", "320",
        "--out", str(out_dir), str(wav),
    ]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=_spawn_env())
        with _JOBS_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["proc"] = proc
        assert proc.stdout is not None
        for _ in proc.stdout:
            with _JOBS_LOCK:
                if _JOBS.get(job_id, {}).get("cancel_requested"):
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    return None
        rc = proc.wait(timeout=1800)
        if rc != 0:
            _, stderr = proc.communicate()
            err = (stderr or "")[-1500:]
            if device == "cuda" and ("out of memory" in err.lower() or "oom" in err):
                log.info("demucs OOM, retry cpu")
                return _demucs_fallback(job_id, wav, out_dir, mode, "cpu")
            log.warning("demucs gagal: %s", err)
            return None
    except Exception as e:
        log.warning("demucs exception: %s", e)
        return None
    finally:
        with _JOBS_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["proc"] = None
    cand = list(out_dir.rglob("*.mp3"))
    if not cand:
        cand = list(out_dir.rglob("*.wav")) + list(out_dir.rglob("*.flac"))
    if not cand:
        return None
    want = "no_vocals" if mode == "karaoke" else "vocals"
    return next((c for c in cand if want in c.name.lower()), cand[0])


def _cpu_info() -> dict:
    name = ""
    try:
        import platform as _pf
        try:
            import winreg as _wr
            with _wr.OpenKey(_wr.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as _k:
                name = str(_wr.QueryValueEx(_k, "ProcessorNameString")[0]).strip()
        except Exception:
            pass
        if not name:
            name = (_pf.processor() or "").strip()
        if not name:
            name = (_pf.machine() or "").strip()
    except Exception:
        pass
    try:
        threads = os.cpu_count() or 0
    except Exception:
        threads = 0
    return {"cpu_name": name, "cpu_threads": threads}


def _device_info(probe_cuda: bool = True) -> dict:
    """Snapshot CUDA/ORT/VRAM untuk instrumentasi per-job (bukti CUDA jalan)."""
    cpu = _cpu_info()
    info: dict = {"cuda": False, "device": "cpu", "providers": [],
                  "vram_free_gb": None, "vram_total_gb": None, "torch": "",
                  "cpu_name": cpu["cpu_name"], "cpu_threads": cpu["cpu_threads"]}
    if not probe_cuda:
        return info
    try:
        import torch
        info["torch"] = torch.__version__
        if torch.cuda.is_available():
            info["cuda"] = True
            try:
                info["device"] = torch.cuda.get_device_name(0)
            except Exception:
                info["device"] = "cuda"
            try:
                free_b, total_b = torch.cuda.mem_get_info()
                info["vram_free_gb"] = round(free_b / 1e9, 2)
                info["vram_total_gb"] = round(total_b / 1e9, 2)
            except Exception:
                pass
    except Exception:
        pass
    try:
        import onnxruntime as ort
        info["providers"] = list(ort.get_available_providers())
    except Exception:
        pass
    try:
        md = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "audio-separator-models" / "Kim_Vocal_2.onnx"
        info["kim_cached"] = md.exists()
        info["kim_mb"] = round(md.stat().st_size / 1e6, 1) if md.exists() else 0
    except Exception:
        info["kim_cached"] = False
    return info


def _free_engine_vram():
    try:
        import gc as _gc
        _gc.collect()
    except Exception:
        pass
    try:
        import torch as _t
        if _t.cuda.is_available():
            _t.cuda.empty_cache()
    except Exception:
        pass


def _set_job(job_id: str, **kw):
    with _JOBS_LOCK:
        if job_id in _JOBS:
            kw.setdefault("at", time.time())
            _JOBS[job_id].update(kw)


def _worker(job_id: str, raw: bytes, suffix: str, mode: str, quality: str,
            device: str, target_format: str, cache_path: Path,
            track_path: str | None, allow_demucs: bool):
    job = _JOBS.get(job_id)
    if not job:
        return
    try:
        dinfo = _device_info(probe_cuda=(device != "cpu"))
        with _JOBS_LOCK:
            _JOBS[job_id]["device_info"] = dinfo
        if device == "cuda" and not dinfo.get("cuda"):
            with _JOBS_LOCK:
                _JOBS[job_id].update(status="failed", at=time.time(),
                    error="CUDA diminta tapi tidak terdeteksi (torch.cuda.is_available()=False). "
                          "Pilih device=CPU di Settings, atau perbaiki driver/CUDA PyTorch.")
            return
        if dinfo.get("cuda") and (dinfo.get("vram_free_gb") or 99) < 1.0:
            log.warning("karaoke VRAM bebas rendah (%.2f GB) — risiko OOM/CPU-fallback",
                        dinfo.get("vram_free_gb"))
        persist_base: Path | None = None
        try:
            if track_path:
                tp = Path(track_path)
                if tp.is_file() and tp.parent.exists():
                    persist_base = tp.parent
        except Exception:
            persist_base = None
        with tempfile.TemporaryDirectory() as td:
            td_p = Path(td)
            src = td_p / f"in{suffix}"
            src.write_bytes(raw)
            _set_job(job_id, pct=3.0, stage="probe", status="processing")
            orig_dur = _get_duration(src)
            if persist_base is not None:
                out_dir = persist_base
            else:
                out_dir = td_p / "out"
                out_dir.mkdir(parents=True, exist_ok=True)
            log_path = td_p / "karaoke_stderr.log"
            job_log = APP_DIR / f"{job_id}.log"
            with _JOBS_LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id]["log"] = str(job_log)

            stem = Path(track_path).stem if track_path else None
            if persist_base is not None and stem:
                with _JOBS_LOCK:
                    if job_id in _JOBS:
                        _JOBS[job_id]["stem_dir"] = str(persist_base / "mdx_extra" / stem)
                for ext in (target_format, "flac", "wav", "ogg", "mp3", "m4a"):
                    cand = persist_base / "mdx_extra" / stem / f"no_vocals.{ext}"
                    try:
                        if cand.is_file() and cand.stat().st_size > 1024:
                            log.info("karaoke cache persisten hit: %s", cand)
                            if cand.suffix.lower().lstrip(".") != target_format:
                                _set_job(job_id, pct=96.0, stage="convert-target")
                                final = _convert_wav_to_target(cand, target_format, td_p / "final")
                                try:
                                    shutil.copy(final, persist_base / "mdx_extra" / stem /
                                                f"no_vocals.{target_format}")
                                except Exception:
                                    pass
                                _mdx_prune_wav(persist_base / "mdx_extra" / stem)
                            else:
                                final = cand
                            shutil.copy(final, cache_path)
                            with _JOBS_LOCK:
                                _JOBS[job_id].update(status="done", pct=100.0, stage="cache-persist",
                                                     result=str(cache_path), at=time.time())
                            return
                    except Exception:
                        pass

            wav_inst: Path | None = None
            if mode != "vocal":
                post = "precise" if quality == "high" else "fast"
                if SEPARATE_SCRIPT.exists():
                    script, args = SEPARATE_SCRIPT, [str(src), str(out_dir), device, post]
                elif ENSEMBLE_SCRIPT.exists():
                    script, args = ENSEMBLE_SCRIPT, [str(src), str(out_dir), device, "standard"]
                else:
                    script, args = None, []
                if script is not None:
                    _set_job(job_id, pct=5.0, stage="separate")
                    wav_inst, _ = _run_script(job_id, script, args, log_path)
                    with _JOBS_LOCK:
                        if _JOBS.get(job_id, {}).get("cancel_requested"):
                            _JOBS[job_id].update(status="cancelled", stage="cancelled")
                            return
                    if wav_inst and not wav_inst.exists():
                        alt = out_dir / "mdx_extra" / src.stem / wav_inst.name
                        if alt.exists():
                            wav_inst = alt
                        else:
                            cands = list(out_dir.rglob("no_vocals.wav"))
                            wav_inst = cands[0] if cands else None
            if wav_inst is None or not wav_inst.exists():
                try:
                    shutil.copy(log_path, job_log)
                except Exception:
                    pass
                if not allow_demucs:
                    with _JOBS_LOCK:
                        det = ""
                        try:
                            det = (_JOBS.get(job_id, {}) or {}).get("script_error", "")
                        except Exception:
                            det = ""
                    msg = ("BS-RoFormer gagal memisahkan (tanpa fallback Demucs). "
                           "Coba quality=standard + device=cuda, atau cek GET /separate/log. "
                           + (det[-800:] if det else ""))
                    with _JOBS_LOCK:
                        _JOBS[job_id].update(status="failed", error=msg, at=time.time())
                    return
                log.info("BS-RoFormer ONNX gagal, fallback Demucs htdemucs")
                _set_job(job_id, pct=88.0, stage="to-wav-demucs")
                wav = td_p / "in.wav"
                to_wav(src, wav)
                demucs_out = td_p / "demucs_out"
                demucs_out.mkdir(parents=True, exist_ok=True)
                wav_inst = _demucs_fallback(job_id, wav, demucs_out, mode, device)
                with _JOBS_LOCK:
                    if _JOBS.get(job_id, {}).get("cancel_requested"):
                        _JOBS[job_id].update(status="cancelled", stage="cancelled")
                        return
                if wav_inst is None:
                    with _JOBS_LOCK:
                        _JOBS[job_id].update(status="failed", error="separation gagal (ONNX + Demucs)",
                                             at=time.time())
                    return
                _set_job(job_id, pct=96.0, stage="convert-target")
                if wav_inst.suffix.lower() == ".wav":
                    _set_job(job_id, pct=97.0, stage="trim")
                    _trim_to_duration(wav_inst, orig_dur)
                    _set_job(job_id, pct=98.0, stage="convert-target")
                    final = _convert_wav_to_target(wav_inst, target_format, td_p / "final")
                else:
                    ff = ffmpeg_bin()
                    dest = td_p / f"final.{target_format}"
                    if ff and wav_inst.suffix.lower().lstrip(".") != target_format:
                        extra = (["-codec:a", "flac", "-compression_level", "5"] if target_format == "flac"
                                 else ["-codec:a", "libvorbis", "-qscale:a", "3"] if target_format == "ogg"
                                 else ["-codec:a", "pcm_s16le"])
                        subprocess.run([ff, "-y", "-i", str(wav_inst), *extra, str(dest)],
                                       check=True, capture_output=True, timeout=600)
                        final = dest
                    else:
                        final = wav_inst
                shutil.copy(final, cache_path)
            else:
                _set_job(job_id, pct=95.0, stage="convert-target")
                _set_job(job_id, pct=96.0, stage="trim")
                _trim_to_duration(wav_inst, orig_dur)
                _set_job(job_id, pct=98.0, stage="convert-target")
                final = _convert_wav_to_target(wav_inst, target_format, td_p / "final")
                shutil.copy(final, cache_path)
            try:
                shutil.copy(log_path, job_log)
            except Exception:
                pass
        _free_engine_vram()
        with _JOBS_LOCK:
            _JOBS[job_id].update(status="done", pct=100.0, stage="done",
                                 result=str(cache_path), at=time.time())
    except Exception as e:
        log.warning("karaoke job %s gagal: %s", job_id, e)
        _free_engine_vram()
        with _JOBS_LOCK:
            if job_id in _JOBS and _JOBS[job_id].get("status") == "processing":
                _JOBS[job_id].update(status="failed", error=str(e)[-2000:], at=time.time())


@router.post("/separate")
async def separate(
    file: UploadFile = File(...),
    mode: str = Form("karaoke"),
    model: str = Form("bsroformer"),
    quality: str = Form("standard"),
    device: str = Form("auto"),
    format: str = Form("flac"),
    fallback: str = Form("auto"),
    track_path: str = Form(""),
):
    mode = (mode or "karaoke").lower()
    if mode not in ("karaoke", "vocal"):
        mode = "karaoke"
    quality = (quality or "standard").lower()
    if quality not in ("high", "standard"):
        quality = "standard"
    target_format = (format or "flac").lower().lstrip(".")
    if target_format not in ("flac", "ogg", "wav"):
        target_format = "flac"
    dev = _resolve_device(device)
    fb = (fallback or "auto").lower()
    allow_demucs = (fb == "on") or (fb == "auto" and mode == "vocal")

    suffix = _resolve_suffix(file.filename, file.content_type)
    if suffix not in SUPPORTED:
        log.warning("separate reject filename=%r ct=%r suffix=%r", file.filename, file.content_type, suffix)
        return JSONResponse(
            {"error": f"Format {suffix or '(tanpa ekstensi)'} tidak didukung. Pakai mp3/m4a/aac/wav/flac/ogg."},
            status_code=400,
        )
    raw = await file.read()
    if not raw:
        return JSONResponse({"error": "file kosong"}, status_code=400)
    try:
        _sweep_stale_cache()
    except Exception:
        pass

    model_lc = (model or "bsroformer").lower()
    key = hashlib.md5(raw + f"|{model_lc}|{mode}|{quality}|{target_format}".encode()).hexdigest()
    out_path = APP_DIR / f"{key}_{mode}.{target_format}"
    tp_hint = (track_path or "").strip()
    try:
        _pb, _st = _resolve_persist(tp_hint or None)
        if _pb is not None and _st and not _mdx_has_persist(_pb, _st, target_format) and out_path.exists():
            try:
                out_path.unlink()
                log.info("karaoke cache APP_DIR basi dibuang (mdx_extra hilang): %s", out_path.name)
            except Exception:
                pass
    except Exception:
        pass
    if out_path.exists() and out_path.stat().st_size > 1024:
        job_id = "cache-" + key[:16]
        with _JOBS_LOCK:
            _JOBS[job_id] = {"status": "done", "pct": 100.0, "stage": "cache-hit",
                             "result": str(out_path), "error": "",
                             "mode": mode, "format": target_format, "at": time.time()}
        return {"ok": True, "job_id": job_id, "cached": True}

    job_id = "kar-" + hashlib.md5(f"{key}{time.time()}".encode()).hexdigest()[:16]
    tp_clean = (track_path or "").strip()
    with _JOBS_LOCK:
        for jid, j in _JOBS.items():
            if j.get("status") == "processing" and j.get("cache_key") == key:
                return {"ok": True, "job_id": jid, "cached": False, "dedup": True}
        _JOBS[job_id] = {"status": "processing", "pct": 1.0, "stage": "queued",
                         "error": "", "result": "", "proc": None, "log": "",
                         "cancel_requested": False, "cache_key": key,
                         "script_error": "", "device": dev,
                         "mode": mode, "format": target_format, "at": time.time()}
    th = threading.Thread(target=_worker,
                          args=(job_id, raw, suffix, mode, quality, dev, target_format,
                                out_path, tp_clean or None, allow_demucs),
                          daemon=True)
    th.start()
    return {"ok": True, "job_id": job_id, "cached": False}


@router.get("/separate/progress")
def separate_progress(job_id: str = ""):
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return JSONResponse({"error": "job tidak ditemukan"}, status_code=404)
        return {"job_id": job_id, "status": job.get("status"), "pct": job.get("pct", 0),
                "stage": job.get("stage", ""), "error": job.get("error", ""),
                "mode": job.get("mode", ""), "format": job.get("format", ""),
                "device": job.get("device", ""),
                "at": job.get("at", 0), "device_info": job.get("device_info", {})}


@router.get("/separate/log")
def separate_log(job_id: str = "", tail: int = 40):
    """Tail stderr script BS-RoFormer — untuk bedakan 'kerja vs hang' saat pct diam."""
    try:
        n = max(5, min(200, int(tail)))
    except Exception:
        n = 40
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return JSONResponse({"error": "job tidak ditemukan"}, status_code=404)
        log_p = job.get("log", "")
        status, stage, pct = job.get("status"), job.get("stage", ""), job.get("pct", 0)
    txt = ""
    if log_p and Path(log_p).exists():
        txt = _tail_log(Path(log_p), n)
    return {"job_id": job_id, "status": status, "stage": stage, "pct": pct, "log": txt}


@router.get("/separate/result")
def separate_result(job_id: str = ""):
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return JSONResponse({"error": "job tidak ditemukan"}, status_code=404)
        status = job.get("status")
        result = job.get("result", "")
    if status != "done" or not result or not Path(result).exists():
        return JSONResponse({"error": f"belum siap (status={status})"}, status_code=409)
    p = Path(result)
    return FileResponse(p, media_type=_MEDIA_TYPE.get(p.suffix.lower(), "audio/flac"),
                        filename=f"karaoke_{job_id}{p.suffix}")


@router.post("/separate/cancel")
def separate_cancel(payload: dict):
    job_id = (payload.get("job_id") or "").strip()
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return JSONResponse({"error": "job tidak ditemukan"}, status_code=404)
        if job.get("status") not in ("processing", "queued"):
            return {"ok": True, "job_id": job_id, "status": job.get("status")}
        job["cancel_requested"] = True
        proc = job.get("proc")
    if proc is not None:
        try:
            proc.kill()
        except Exception:
            pass
    with _JOBS_LOCK:
        _JOBS[job_id].update(status="cancelled", stage="cancelled")
    return {"ok": True, "job_id": job_id, "status": "cancelled"}


@router.post("/separate/cleanup")
def separate_cleanup(payload: dict):
    """Hapus salinan cache APP_DIR + log milik job yg sudah selesai disimpan
    frontend (hasil permanen ada di mdx_extra). Dipanggil best-effort setelah
    save_karaoke sukses; replay tetap cache-hit via mdx_extra."""
    job_id = ((payload or {}).get("job_id") or "").strip()
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return JSONResponse({"error": "job tidak ditemukan"}, status_code=404)
        result, log_p, stem_dir = job.get("result", ""), job.get("log", ""), job.get("stem_dir", "")
    freed = 0
    removed: list = []
    for cand in (_inside_app_dir(result), _inside_app_dir(log_p)):
        if cand is None or not cand.is_file():
            continue
        name = cand.name
        if not (name.endswith(("_karaoke.flac", "_karaoke.ogg", "_karaoke.wav",
                                "_vocal.flac", "_vocal.ogg", "_vocal.wav"))
                or (name.startswith("kar-") and name.endswith(".log"))):
            continue
        try:
            freed += cand.stat().st_size
            cand.unlink()
            removed.append(name)
        except Exception:
            pass
    pruned_wav = _mdx_prune_wav(stem_dir) if stem_dir else False
    with _JOBS_LOCK:
        if job_id in _JOBS:
            _JOBS[job_id].update(stage="cleaned", at=time.time())
    return {"ok": True, "job_id": job_id, "removed": removed,
            "freed_bytes": freed, "pruned_wav": pruned_wav}


@router.get("/karaoke")
def karaoke_caps(device: str = "auto"):
    probe = (device or "auto").lower() != "cpu"
    info = _device_info(probe_cuda=probe)
    return {
        "ok": True,
        "cuda": info["cuda"],
        "device": info["device"],
        "providers": info["providers"],
        "vram_free_gb": info["vram_free_gb"],
        "vram_total_gb": info["vram_total_gb"],
        "cpu_name": info["cpu_name"],
        "cpu_threads": info["cpu_threads"],
        "bs_available": True,
        "models": ["Kim_Vocal_2"],
        "quality": ["standard", "high"],
        "quality_note": "keduanya Kim_Vocal_2 single; high=precise loudnorm, standard=fast",
        "formats": ["flac", "ogg", "wav"],
        "kim_cached": info.get("kim_cached", False),
        "kim_mb": info.get("kim_mb", 0),
        "torch": info["torch"],
    }
