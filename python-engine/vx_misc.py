"""VocaLyx engine - loudness measure, recycle bin, plus explicit per-file enhance."""
import ctypes
import hashlib
import os
import re
import shutil
import subprocess
import threading
import time
from ctypes import wintypes
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from vx_core import (
    AUDIO_JOB_LOCK, _probe_audio, _set_progress, download_progress, enhance_progress,
    ffmpeg_bin, log,
)
from vx_download import _enhance_audio

router = APIRouter()



_ENHANCE_EXTS = {"mp3", "m4a", "flac", "ogg", "opus"}

@router.post("/embed/enhance")
def embed_enhance(payload: dict):
    path_str = (payload.get("path") or "").strip()
    if not path_str:
        return JSONResponse({"ok": False, "error": "path kosong"}, status_code=400)
    p = Path(path_str)
    if not p.exists() or not p.is_file():
        return JSONResponse({"ok": False, "error": "file tidak ditemukan"}, status_code=400)
    if p.suffix.lower().lstrip(".") not in _ENHANCE_EXTS:
        return JSONResponse({"ok": False, "error": f"ekstensi tidak didukung: {p.suffix}"}, status_code=400)
    audio_enhance = bool(payload.get("audioEnhance", False))
    normalize_volume = bool(payload.get("normalizeVolume", False))
    try:
        target_lufs = float(payload.get("targetLufs", -14))
    except Exception:
        target_lufs = -14
    if not (audio_enhance or normalize_volume):
        return JSONResponse({"ok": False, "error": "nothing to do (enhance+normalize OFF)"}, status_code=400)
    enhance_id = "enh-" + hashlib.md5(f"{path_str}{time.time()}".encode()).hexdigest()[:12]
    job = {"percent": 0, "status": "starting", "path": path_str}
    download_progress[enhance_id] = job
    enhance_progress[enhance_id] = job

    def do_enhance():
        AUDIO_JOB_LOCK.acquire()
        try:
            _set_progress(enhance_id, percent=5, status="enhancing")
            ok = _enhance_audio(p, {"audioEnhance": audio_enhance, "normalizeVolume": normalize_volume,
                                    "targetLufs": target_lufs, "track_source": "explicit"},
                                enhance_id, force=True)
            probed = _probe_audio(p)
            try:
                st = p.stat()
                size, mtime_ms = st.st_size, int(st.st_mtime * 1000)
            except Exception:
                size, mtime_ms = -1, 0
            final = {"percent": 100, "status": "done" if ok else "failed", "path": path_str,
                     "enhanced": bool(ok), "kbps": probed.get("kbps"), "size": size, "mtimeMs": mtime_ms}
            if not ok:
                final["error"] = "enhance gagal/dilewati (lihat log engine)"
            download_progress[enhance_id] = final
            enhance_progress[enhance_id] = final
        except Exception as e:
            err = {"percent": 0, "status": "failed", "path": path_str, "error": str(e)}
            download_progress[enhance_id] = err
            enhance_progress[enhance_id] = err
        finally:
            AUDIO_JOB_LOCK.release()

    threading.Thread(target=do_enhance, daemon=True).start()
    return {"ok": True, "enhanceId": enhance_id, "status": "started"}


@router.get("/embed/enhance/progress")
def embed_enhance_progress(enhanceId: str = ""):
    if enhanceId and enhanceId in enhance_progress:
        return enhance_progress[enhanceId]
    return enhance_progress


_loudness_cache = {}

def _gain_cache_path() -> Path:
    return Path(__file__).resolve().parent / ".gain-cache.json"

def _gain_key(path: str) -> str:
    try:
        abs_p = str(Path(path).resolve())
        return abs_p.lower() if os.name == "nt" else abs_p
    except Exception:
        return str(path)

def _gain_read_all() -> dict:
    try:
        p = _gain_cache_path()
        if not p.exists():
            return {}
        import json as _json
        j = _json.loads(p.read_text(encoding="utf-8"))
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}

def _gain_write_all(all_entries: dict) -> None:
    try:
        import json as _json
        _gain_cache_path().write_text(_json.dumps(all_entries, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        log.warning("gain cache write failed: %s", e)

def get_gain_entry(path: str, target: float | None = None) -> dict | None:
    """Ambil entry gain dari cache sentral. target=None → entry apa pun; selain itu harus match target."""
    e = _gain_read_all().get(_gain_key(path))
    if not e:
        return None
    try:
        gd = float(e.get("gainDb"))
    except Exception:
        return None
    if gd != gd:
        return None
    if target is not None and e.get("target") is not None:
        try:
            if abs(float(e.get("target")) - float(target)) > 0.01:
                return None
        except Exception:
            return None
    return e

def set_gain_entry(path: str, gain_db: float, peak: float, target: float, mode: str = "track") -> None:
    try:
        mt = Path(path).stat().st_mtime
    except Exception:
        mt = None
    all_e = _gain_read_all()
    all_e[_gain_key(path)] = {
        "gainDb": float(gain_db),
        "peak": float(peak),
        "target": float(target),
        "mode": mode,
        "mtime": mt,
        "at": int(time.time()),
    }
    _gain_write_all(all_e)
    try:
        for k in list(_loudness_cache.keys()):
            if k.split("|", 1)[0] == path:
                del _loudness_cache[k]
    except Exception:
        pass

def _measure_loudnorm(path: str, target: float) -> tuple[float, float] | None:
    """Ukur full file via loudnorm JSON → (input_i, input_tp). None bila gagal."""
    ff = ffmpeg_bin()
    if not ff:
        return None
    try:
        proc = subprocess.run(
            [ff, "-hide_banner", "-i", str(path),
             "-af", f"loudnorm=I={target}:TP=-1:LRA=11:print_format=json",
             "-f", "null", "-"],
            capture_output=True, timeout=120
        )
        out = (proc.stderr or b"").decode("utf-8", "replace")
        m = re.search(r"\{[\s\S]*?\"input_i\"[\s\S]*?\}", out)
        if not m:
            return None
        import json as _json
        j = _json.loads(m.group(0))
        input_i = float(j.get("input_i"))
        input_tp = float(j.get("input_tp", "-1"))
        if input_i != input_i:
            return None
        return input_i, input_tp
    except Exception:
        return None

@router.get("/loudness")
def loudness(path: str = "", target: float = -14):
    """Ukur integrated LUFS full file via loudnorm JSON.
    Return { ok, lufs, peak, gainDb, target, fromCache } — gainDb = clamp(target - input_i, ±12).
    Prioritas: mem 10 mnt → .gain-cache.json (target match) → ukur → tulis cache."""
    if not path or not Path(path).exists():
        return JSONResponse({"ok": False, "error": "file tidak ditemukan"}, status_code=400)
    try:
        target = float(target)
    except Exception:
        target = -14.0
    if not (-30 <= target <= -1):
        target = -14.0
    cache_key = f"{path}|{target}"
    now = time.time()
    hit = _loudness_cache.get(cache_key)
    if hit and now - hit[1] < 600:
        return {**hit[0], "fromCache": True}
    ent = get_gain_entry(path, target)
    if ent:
        try:
            mt_now = Path(path).stat().st_mtime
            mt_c = ent.get("mtime")
            if mt_c is None or abs(float(mt_c) - mt_now) < 0.001:
                payload = {"ok": True, "lufs": target - float(ent["gainDb"]), "peak": float(ent.get("peak", 1)),
                           "gainDb": float(ent["gainDb"]), "target": target, "fromCache": True}
                _loudness_cache[cache_key] = (payload, now)
                return payload
        except Exception:
            pass
    ff = ffmpeg_bin()
    if not ff:
        return JSONResponse({"ok": False, "error": "ffmpeg tidak tersedia"}, status_code=500)
    measured = _measure_loudnorm(path, target)
    if not measured:
        return JSONResponse({"ok": False, "error": "tidak dapat mengukur loudness"}, status_code=500)
    input_i, input_tp = measured
    gain_db = max(-12.0, min(12.0, target - input_i))
    peak = 10 ** (input_tp / 20.0)
    payload = {"ok": True, "lufs": input_i, "peak": peak, "gainDb": gain_db, "target": target, "fromCache": False}
    _loudness_cache[cache_key] = (payload, now)
    set_gain_entry(path, gain_db, peak, target, mode="track")
    return payload


_BULK_EXTS = {".mp3", ".m4a", ".mp4", ".m4b", ".aac", ".flac", ".wav", ".ogg", ".opus"}
_BULK_SKIP_DIRS = {"mdx_extra", "karaoke-ogg"}

def _bulk_walk(folder: Path, out: list[str]) -> list[str]:
    try:
        for e in folder.iterdir():
            try:
                if e.is_dir():
                    if e.name.lower() in _BULK_SKIP_DIRS:
                        continue
                    _bulk_walk(e, out)
                elif e.is_file() and e.suffix.lower() in _BULK_EXTS:
                    out.append(str(e.resolve()))
            except Exception:
                continue
    except Exception:
        pass
    return out

@router.post("/gain/bulk")
def gain_bulk(payload: dict):
    """Batch measure volume gain ala music-dl.
    Body: { folder, target, offset?, limit? }
    Return: { ok, measured, skipped, failed, total, done, nextOffset, complete, errors[] }"""
    folder = str(payload.get("folder") or "").strip()
    if not folder:
        return JSONResponse({"ok": False, "error": "folder kosong"}, status_code=400)
    fp = Path(folder)
    if not fp.is_dir():
        return JSONResponse({"ok": False, "error": "folder tidak ditemukan: " + folder}, status_code=404)
    try:
        target = float(payload.get("target", -14))
    except Exception:
        target = -14.0
    if not (-30 <= target <= -1):
        target = -14.0
    offset = max(0, int(payload.get("offset", 0) or 0))
    limit = max(1, min(20, int(payload.get("limit", 6) or 6)))
    files: list[str] = []
    _bulk_walk(fp, files)
    if not files:
        return {"ok": True, "measured": 0, "skipped": 0, "failed": 0, "total": 0, "done": 0,
                "nextOffset": 0, "complete": True, "errors": []}
    def _sz(p: str) -> int:
        try:
            return Path(p).stat().st_size
        except Exception:
            return 0
    files.sort(key=_sz)
    total = len(files)
    offset = min(offset, total)
    batch = files[offset:offset + limit]
    measured = 0
    skipped = 0
    failed = 0
    errors: list[str] = []
    need: list[str] = []
    for f in batch:
        ent = get_gain_entry(f, target)
        if ent:
            try:
                mt_now = Path(f).stat().st_mtime
                mt_c = ent.get("mtime")
                if mt_c is None or abs(float(mt_c) - mt_now) < 0.001:
                    skipped += 1
                    continue
            except Exception:
                pass
        need.append(f)
    from concurrent.futures import ThreadPoolExecutor, as_completed
    def probe(fp_str: str):
        m = _measure_loudnorm(fp_str, target)
        if not m:
            return fp_str, None, "loudnorm gagal"
        input_i, input_tp = m
        gain_db = max(-12.0, min(12.0, target - input_i))
        peak = 10 ** (input_tp / 20.0)
        set_gain_entry(fp_str, gain_db, peak, target, mode="track")
        return fp_str, gain_db, None
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(probe, f) for f in need]
        for fut in as_completed(futs):
            try:
                f, gd, err = fut.result()
                if err:
                    failed += 1
                    errors.append(f"{Path(f).name}: {err}")
                else:
                    measured += 1
            except Exception as e:
                failed += 1
                errors.append(str(e)[:180])
    done = min(offset + len(batch), total)
    return {"ok": True, "measured": measured, "skipped": skipped, "failed": failed,
            "total": total, "done": done, "nextOffset": done, "complete": done >= total,
            "errors": errors[:6], "target": target}


def _send_to_recycle_bin(path: Path) -> bool:
    """Move file/folder to Windows Recycle Bin via SHFileOperationW (no restore prompt).
    Falls back to permanent delete on non-Windows or failure of the API call."""
    if os.name != "nt":
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
        return True
    try:


        FO_DELETE = 3
        FOF_ALLOWUNDO = 0x40
        FOF_NOCONFIRMATION = 0x10
        FOF_SILENT = 0x4
        FOF_NOERRORUI = 0x400

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("wFunc", ctypes.c_uint),
                ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_ushort),
                ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p),
                ("lpszProgressTitle", wintypes.LPCWSTR),
            ]

        op = SHFILEOPSTRUCTW()
        op.hwnd = None
        op.wFunc = FO_DELETE
        op.pFrom = str(path) + "\x00\x00"
        op.pTo = None
        op.fFlags = FOF_ALLOWUNDO | FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI
        result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        return result == 0
    except Exception as e:
        log.warning("recycle bin failed, permanent delete fallback: %s", e)
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
        return True


@router.post("/trash")
def trash(payload: dict):
    path_str = (payload.get("path") or "").strip()
    if not path_str:
        return JSONResponse({"ok": False, "error": "path kosong"}, status_code=400)
    path = Path(path_str)
    if not path.exists():
        return JSONResponse({"ok": False, "error": "file tidak ditemukan"}, status_code=400)
    try:
        _send_to_recycle_bin(path)
        return {"ok": True, "path": str(path)}
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"gagal hapus: {e}"}, status_code=500)
