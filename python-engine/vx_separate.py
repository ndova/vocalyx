"""VocaLyx engine - karaoke vocal separation endpoints.

Tahap: pisah (stem primer, math benar) -> adaptive center suppression + HPF +
limiter + loudness match -> encode. Cache persisten di folder musik diberi
stempel versi/param jadi hasil lama (yang vokalnya masih bocor) tidak pernah
dipakai lagi.
"""

import hashlib
import shutil
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from vx_core import APP_DIR, SUPPORTED, log
from vx_sep_cache import (
    KARAOKE_DSP_VERSION,
    KARAOKE_PRESETS,
    _MEDIA_TYPE,
    _convert_wav_to_target,
    _drop_stale_persist,
    _get_duration,
    _inside_app_dir,
    _mdx_has_persist,
    _mdx_prune_wav,
    _missing_best_models,
    _model_fingerprint,
    _persist_file,
    _persist_matches,
    _persist_meta,
    _persist_signature,
    _resolve_device,
    _resolve_persist,
    _resolve_suffix,
    _sweep_stale_cache,
    _trim_to_duration,
    _write_persist_meta,
)
from vx_sep_jobs import _JOBS, _JOBS_LOCK, _set_job, _tail_log
from vx_sep_run import _device_info, _free_engine_vram, _run_script

router = APIRouter()

SCRIPTS_DIR = Path(__file__).parent / "scripts"
ENGINE_DIR = Path(__file__).parent
BEST_SCRIPT = SCRIPTS_DIR / "karaoke_best.py"
DSP_SCRIPT = ENGINE_DIR / "vx_karaoke_dsp.py"

DEFAULT_VOCAL_KILL = 1.0
DEFAULT_CENTRE_KILL = 1.0

# VRAM minimum bebas sebelum job CUDA diterima. Di bawah ini model akan OOM
# atau diam-diam jatuh ke CPU ( jauh lebih lambat ) tanpa error yang terlihat,
# jadi job ditolak lebih awal dengan pesan yang bisa ditindaklanjuti.
#
# Diukur di RTX 3050 4 GB: Kim_Vocal_2 (preset Best) hanya 0.12 GB, sedangkan
# RoFormer Resurrection butuh ~1.3 GB. Ambang 0.5 GB hanya menerima job ringan
# yang jelas muat; preset RoFormer butuh lebih tinggi dan akan ditolak dengan
# pesan yang bisa ditindaklanjuti.
MIN_FREE_VRAM_GB = 0.5


def _vram_low_message(free_gb) -> str:
    return (
        f"VRAM bebas hanya {free_gb} GB (butuh >= {MIN_FREE_VRAM_GB} GB). "
        "Tutup game/editor/browser yang pakai GPU, atau pilih device=CPU di "
        "Settings, lalu coba lagi. Job dibatalkan agar tidak diam-diam jatuh "
        "ke CPU dan jauh lebih lambat."
    )


def _clamp_float(raw, default: float, lo: float, hi: float) -> float:
    try:
        v = float(raw)
    except Exception:
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _clamp_bool(raw, default: bool) -> bool:
    s = str(raw or "").strip().lower()
    if s in ("1", "true", "on", "yes"):
        return True
    if s in ("0", "false", "off", "no"):
        return False
    return default


def _run_dsp(job_id: str, inst: Path, vocal: Path | None, out: Path, log_path: Path,
             source: Path, centre_kill: float, match_level: bool,
             vocal_kill: float = 1.0) -> Path | None:
    """Tahap post: high-pass + limiter + loudness match. Tanpa masking.

    Instrumental dari model dipakai apa adanya; yang ditambahkan hanya
    rumble-cut, limiter, dan penyamaan loudness ke lagu asli. Argumen
    ``--vocal-kill``/``--vocal-kill-subtractive`` masih diteruskan supaya
    signature cache tidak berubah, tapi DSP sudah mengabaikannya.
    """
    if not DSP_SCRIPT.exists():
        log.warning("karaoke DSP script hilang: %s (post dilewati)", DSP_SCRIPT)
        return inst if inst.exists() else None
    args = ["--inst", str(inst), "--out", str(out),
            "--vocal-kill", f"{centre_kill:.3f}",
            "--vocal-kill-subtractive", f"{vocal_kill:.3f}"]
    if match_level:
        args += ["--match-lufs", str(source)]
    produced, _ = _run_script(job_id, DSP_SCRIPT, args, log_path)
    if produced and produced.exists():
        return produced
    log.warning("karaoke DSP gagal, pakai stem sebelum post-processing")
    return inst if inst.exists() else None


def _worker(job_id: str, raw: bytes, suffix: str, mode: str, quality: str,
            device: str, target_format: str, cache_path: Path,
            track_path: str | None,
            vocal_kill: float = DEFAULT_VOCAL_KILL,
            centre_kill: float = DEFAULT_CENTRE_KILL,
            match_level: bool = True):
    job = _JOBS.get(job_id)
    if not job:
        return
    try:
        dinfo = _device_info(probe_cuda=(device != "cpu"))
        with _JOBS_LOCK:
            _JOBS[job_id]["device_info"] = dinfo
        if device == "cuda" and not dinfo.get("cuda"):
            # CUDA dipilih tapi PC ini tidak punya PyTorch CUDA. Dulu job langsung
            # failed, jadi appikan blocked total di PC tanpa GPU. Sekarang turunkan
            # ke CPU dan catat polyethylene peringatan supaya user tahu.
            with _JOBS_LOCK:
                _JOBS[job_id]["warning"] = (
                    "CUDA tidak tersedia (torch.cuda.is_available()=False). "
                    "Karaoke dijalankan dengan CPU."
                )
            log.warning(_JOBS[job_id]["warning"])
            device = "cpu"
        # Fail-fast VRAM rendah. Dulu hanya log.warning, sehingga job tetap jalan
        # lalu:OOM / fallback CPU diam-diam (user cuma lihat "process very lama").
        if dinfo.get("cuda"):
            free_gb = dinfo.get("vram_free_gb")
            if free_gb is not None and free_gb < MIN_FREE_VRAM_GB:
                msg = _vram_low_message(round(float(free_gb), 2))
                log.warning("karaoke ditolak: %s", msg)
                with _JOBS_LOCK:
                    _JOBS[job_id].update(status="failed", at=time.time(), error=msg)
                return
        # Di CPU, preset default (karaoke_aufr33) terlalu berat (benchmark:
        # Resurrection ~6x realtime, aufr33 MelBand-Roformer juga berat).
        # Alihkan ke modul CPU terbaik dari benchmark: MDX Inst_HQ_4.
        # Syaratnya perangkat nyata, bukan nilai device: device="cuda" yang
        # fellback ke CPU di atas juga harus dapat preset yang ringan.
        if not dinfo.get("cuda") and quality == "karaoke_aufr33":
            quality = "cpu_inst_hq"
            log.info("perangkat tanpa CUDA: karaoke_aufr33 dialihkan ke cpu_inst_hq (UVR-MDX-NET-Inst_HQ_4, benchmark CPU tercepat)")
        persist_base, stem = _resolve_persist(track_path)
        sig = _persist_signature(mode, quality, vocal_kill, centre_kill, match_level, {})

        with tempfile.TemporaryDirectory() as td:
            td_p = Path(td)
            src = td_p / f"in{suffix}"
            src.write_bytes(raw)
            _set_job(job_id, pct=3.0, stage="probe", status="processing")
            orig_dur = _get_duration(src)
            # Pisah selalu di direktori job ini, bukan langsung di folder musik:
            # dulu semua job menimpa <music>/mdx_extra/in/ dan bisa saling tabrak.
            out_dir = td_p / "sep"
            out_dir.mkdir(parents=True, exist_ok=True)
            log_path = td_p / "karaoke_stderr.log"
            job_log = APP_DIR / f"{job_id}.log"
            with _JOBS_LOCK:
                if job_id in _JOBS:
                    _JOBS[job_id]["log"] = str(job_log)

            if persist_base is not None and stem:
                with _JOBS_LOCK:
                    if job_id in _JOBS:
                        _JOBS[job_id]["stem_dir"] = str(persist_base / "mdx_extra" / stem)
                cand = _persist_file(persist_base, stem, target_format)
                if cand is not None and _persist_matches(_persist_meta(persist_base, stem), sig):
                    log.info("karaoke cache persisten hit: %s", cand)
                    if cand.suffix.lower().lstrip(".") != target_format:
                        _set_job(job_id, pct=96.0, stage="convert-target")
                        final = _convert_wav_to_target(cand, target_format, td_p / "final")
                        try:
                            persist_dir = persist_base / "mdx_extra" / stem
                            persist_dir.mkdir(parents=True, exist_ok=True)
                            shutil.copy(final, persist_dir / f"no_vocals.{target_format}")
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
                if cand is not None:
                    log.info("karaoke cache lama regarded stale (dsp v%s vs v%s): %s",
                             (_persist_meta(persist_base, stem) or {}).get("version"),
                             KARAOKE_DSP_VERSION, cand)
                    _drop_stale_persist(persist_base, stem)

            wav_inst: Path | None = None
            wav_voc: Path | None = None
            # Preset karaoke (lihat vx_sep_cache.KARAOKE_PRESETS):
            #   karaoke_aufr33  -> MelBand RoFormer Karaoke Aufr33/Viperx (GPU/default)
            #   cpu_inst_hq     -> UVR-MDX-NET-Inst_HQ_4 (CPU cepat)
            # Tidak ada fallback otomatis (mode 'vocal'/Demucs sudah dihapus):
            # bila preset terpilih (karaoke_aufr33 / cpu_inst_hq) gagal, job
            # langsung ditandai failed.
            #
            # Jalur post-processing TIDAK memakai masking: stem instrumental
            # dari model dipakai apa adanya lalu di-loudness-match. Versi
            # sebelumnya menambah magnitude_subtract + adaptive_center_suppress
            # + boost HF, dan itu yang menghasilkan "suara air".
            attempts = []
            if quality in KARAOKE_PRESETS:
                missing = _missing_best_models(quality)
                if missing:
                    log.info("karaoke Best: model belum ada (diunduh saat proses): %s",
                             ", ".join(missing))
                if BEST_SCRIPT.exists():
                    attempts.append((BEST_SCRIPT, [str(src), str(out_dir), device,
                                                   quality]))
            for script, args in attempts:
                _set_job(job_id, pct=5.0, stage="separate")
                candidate, info = _run_script(job_id, script, args, log_path)
                with _JOBS_LOCK:
                    if _JOBS.get(job_id, {}).get("cancel_requested"):
                        _JOBS[job_id].update(status="cancelled", stage="cancelled")
                        return
                if candidate and candidate.exists():
                    wav_inst = candidate
                    voc = info.get("vocals") or ""
                    wav_voc = Path(voc) if voc and Path(voc).exists() else None
                    sig["models"] = info.get("model", "") or ""
                    break
                if script is BEST_SCRIPT:
                    log.warning("karaoke Best (%s) gagal", quality)

            if wav_inst is not None:
                _set_job(job_id, pct=74.0, stage="dsp")
                post = _run_dsp(job_id, wav_inst, wav_voc, out_dir / "post.wav", log_path,
                                 src, centre_kill, match_level, vocal_kill)
                if post is not None:
                    wav_inst = post
                with _JOBS_LOCK:
                    if _JOBS.get(job_id, {}).get("cancel_requested"):
                        _JOBS[job_id].update(status="cancelled", stage="cancelled")
                        return

            if wav_inst is None or not wav_inst.exists():
                try:
                    shutil.copy(log_path, job_log)
                except Exception:
                    pass
                with _JOBS_LOCK:
                    det = (_JOBS.get(job_id, {}) or {}).get("script_error", "")
                    msg = ("Pemisahan karaoke gagal untuk "
                           f"quality='{quality}' (device={device}). "
                           "Tidak ada fallback otomatis — cek log job. "
                           + (det[-800:] if det else ""))
                    _JOBS[job_id].update(status="failed", error=msg, at=time.time())
                return

            _set_job(job_id, pct=96.0, stage="trim")
            _trim_to_duration(wav_inst, orig_dur)
            _set_job(job_id, pct=98.0, stage="convert-target")
            final = _convert_wav_to_target(wav_inst, target_format, td_p / "final")
            shutil.copy(final, cache_path)

            if persist_base is not None and stem:
                try:
                    persist_dir = persist_base / "mdx_extra" / stem
                    persist_dir.mkdir(parents=True, exist_ok=True)
                    shutil.copy(final, persist_dir / f"no_vocals.{target_format}")
                    _write_persist_meta(persist_base, stem, sig)
                    _mdx_prune_wav(persist_dir)
                except Exception as ex:
                    log.warning("karaoke simpan persist gagal: %s", ex)

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
    track_path: str = Form(""),
    vocal_kill: str = Form(""),
    centre_kill: str = Form(""),
    match_level: str = Form(""),
):
    mode = (mode or "karaoke").lower()
    if mode != "karaoke":
        mode = "karaoke"
    quality = (quality or "karaoke_aufr33").lower()
    if quality not in KARAOKE_PRESETS:
        quality = "karaoke_aufr33"
    target_format = (format or "flac").lower().lstrip(".")
    if target_format not in ("flac", "ogg", "wav"):
        target_format = "flac"
    dev = _resolve_device(device)
    vk = _clamp_float(vocal_kill, DEFAULT_VOCAL_KILL, 0.70, 1.30)
    ck = _clamp_float(centre_kill, DEFAULT_CENTRE_KILL, 0.0, 1.25)
    ml = _clamp_bool(match_level, True)

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
    fingerprint = _model_fingerprint()
    params = f"{vk:.3f}|{ck:.3f}|{int(ml)}"
    key = hashlib.md5(raw + f"|{model_lc}|{mode}|{quality}|{target_format}|{params}|{fingerprint}".encode()).hexdigest()
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
                                out_path, tp_clean or None, vk, ck, ml),
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
    missing = _missing_best_models()
    quality_note = ("karaoke_aufr33=MelBand RoFormer Karaoke Aufr33/Viperx (GPU, default); "
                    "cpu_inst_hq=UVR-MDX-NET-Inst_HQ_4 (CPU, cepat). "
                    "Setiap preset memakai SATU model dan stem instrumentalnya "
                    f"dipakai apa adanya (dsp v{KARAOKE_DSP_VERSION}) — tanpa "
                    "masking, karena masking ganda yang dulu jadi sumber 'suara air'. "
                    "Post: limiter -1dBTP + loudness match ke lagu asli "
                    "(high-pass mati secara bawaan).")
    if missing:
        quality_note += " Model Best belum ada (diunduh saat proses): " + ", ".join(missing)
    model_names = [name for name, detail in (info.get("models") or {}).items() if detail.get("cached")]
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
        "models": model_names or ["mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956", "UVR-MDX-NET-Inst_HQ_4"],
        "quality": list(KARAOKE_PRESETS),
        "quality_note": quality_note,
        "formats": ["flac", "ogg", "wav"],
        "dsp_version": KARAOKE_DSP_VERSION,
        # Slider vocal_kill / centre_kill DIHAPUS dari UI karena masking sudah
        # tidak ada (lihat vx_karaoke_sep.py). Field lama tidak diiklankan lagi
        # supaya tidak menyesatkan; endpoint tetap menerima keduanya kalau ada
        # build UI lama yang masih mengirim, dan mengabaikannya.
        "defaults": {
            "match_level": True,
        },
        "models_cached": info.get("models"),
        "missing_ensemble_models": missing,
        "min_free_vram_gb": MIN_FREE_VRAM_GB,
        "kim_cached": info.get("kim_cached", False),
        "kim_mb": info.get("kim_mb", 0),
        "torch": info["torch"],
    }
