import json
import os
import subprocess
import sys
import time
from pathlib import Path

from vx_core import ffmpeg_bin, log
from vx_sep_cache import _model_dir
from vx_sep_jobs import _JOBS, _JOBS_LOCK, _set_job, _tail_log


def _spawn_env(force_cpu: bool = False) -> dict:
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


_KARAOKE_PY_CACHE: dict | None = None
_KARAOKE_PROBE_CODE = "import audio_separator, torch, onnxruntime"
_KARAOKE_PROBE_TIMEOUT = 45


def _interpreter_candidates() -> list:
    raw = []
    try:
        raw.append(Path(__file__).resolve().parent.parent / "build" / "runtime" / "python.exe")
    except Exception:
        pass
    _appdata = os.environ.get("APPDATA") or ""
    if _appdata:
        raw.append(Path(_appdata) / "VocaLyx" / "runtime" / "python.exe")
    raw.append(Path(sys.executable))
    out, seen = [], set()
    for c in raw:
        try:
            key = c.resolve().as_posix().lower() if c.exists() else str(c).lower()
            if key in seen:
                continue
            seen.add(key)
            if c.is_file():
                out.append(str(c))
        except Exception:
            continue
    return out


def _probe_karaoke_python(exe: str) -> bool:
    try:
        r = subprocess.run(
            [exe, "-c", _KARAOKE_PROBE_CODE],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=_KARAOKE_PROBE_TIMEOUT,
        )
        return r.returncode == 0
    except Exception:
        return False


def _karaoke_python() -> tuple:
    global _KARAOKE_PY_CACHE
    if _KARAOKE_PY_CACHE is not None:
        return _KARAOKE_PY_CACHE
    me = ""
    try:
        me = Path(sys.executable).resolve().as_posix().lower()
    except Exception:
        me = str(sys.executable).lower()
    for exe in _interpreter_candidates():
        if _probe_karaoke_python(exe):
            try:
                is_me = Path(exe).resolve().as_posix().lower() == me
            except Exception:
                is_me = str(exe).lower() == me
            _KARAOKE_PY_CACHE = (exe, True)
            if not is_me:
                log.info("karaoke: pakai interpreter ber-deps %s (bukan sys.executable)", exe)
            return _KARAOKE_PY_CACHE
    _KARAOKE_PY_CACHE = (sys.executable, False)
    log.warning("karaoke: tak ada interpreter dengan audio_separator; pakai %s (job akan gagal dengan panduan)", sys.executable)
    return _KARAOKE_PY_CACHE


def _karaoke_missing_deps_message() -> str:
    py, _ok = _karaoke_python()
    return (
        "Karaoke butuh paket audio_separator, tapi tak ada interpreter lengkap yang ditemukan. "
        "Pasang runtime VocaLyx (banner Runtime di Settings, atau rilis runtime-0.1.0-beta) "
        f"— atau install audio-separator ke {py}. "
        "Model AI sudah ada; hanya dependensi Python yang kurang."
    )


def _run_script(job_id: str, script: Path, args: list, log_path: Path,
               Heartbeat_stage: str = "separate"):
    final = {}
    py_exe, py_ok = _karaoke_python()
    if not py_ok:
        with _JOBS_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["script_error"] = _karaoke_missing_deps_message()
        log.warning("karaoke script %s dilewati: interpreter tanpa audio_separator", script.name)
        return None, {}
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_fh = open(log_path, "w", encoding="utf-8", errors="replace")
    except Exception:
        log_fh = None
    proc = None
    try:
        dev_arg = str(args[2]).lower() if len(args) >= 3 else ""
        proc = subprocess.Popen(
            [py_exe, "-u", str(script), *args],
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
    model_dir = _model_dir()
    model_names = ("Kim_Vocal_2.onnx", "UVR-MDX-NET-Voc_FT.onnx",
                   "UVR-MDX-NET-Inst_HQ_4.onnx", "Kim_Inst.onnx")
    models = {}
    for name in model_names:
        try:
            p = model_dir / name
            cached = p.is_file()
            size_mb = round(p.stat().st_size / 1e6, 1) if cached else 0
        except Exception:
            cached = False
            size_mb = 0
        models[name] = {"cached": cached, "mb": size_mb}
    info["models"] = models
    info["kim_cached"] = models["Kim_Vocal_2.onnx"]["cached"]
    info["kim_mb"] = models["Kim_Vocal_2.onnx"]["mb"]
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
