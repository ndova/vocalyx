"""VocaLyx engine - shared state, logging, and audio probing helpers."""
import logging
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

import torch
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4

import win_nowindow

win_nowindow.hide_child_consoles()

log = logging.getLogger("vocalyx")
if not log.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

AUDIO_JOB_LOCK = threading.Lock()

APP_DIR = Path.home() / "AppData" / "Roaming" / "VocaLyx" / "cache"
APP_DIR.mkdir(parents=True, exist_ok=True)
for _legacy in (
    Path.home() / "AppData" / "Roaming" / "NetKara" / "cache",
    Path.home() / "AppData" / "Roaming" / "TuneBox" / "cache",
):
    try:
        if _legacy.exists():
            for f in _legacy.iterdir():
                if not f.is_file():
                    continue
                dest = APP_DIR / f.name
                try:
                    if dest.exists():
                        f.unlink()
                    else:
                        shutil.move(str(f), str(dest))
                except Exception:
                    pass
            _legacy.rmdir()
    except Exception:
        pass

SUPPORTED = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg"}


def cleanup_orphan_tmp(extra_dirs=None):
    """F3: hapus file tmp yatim (enhance/convert) yang tertinggal setelah kill/crash engine."""
    dirs = [APP_DIR, Path.home() / "Downloads" / "VocaLyx"]
    if extra_dirs:
        dirs.extend(Path(d) for d in extra_dirs if d)
    seen = set()
    for d in dirs:
        try:
            d = Path(d)
            key = str(d.resolve()) if d.exists() else str(d)
            if key in seen or not d.is_dir():
                continue
            seen.add(key)
            for p in d.iterdir():
                if not p.is_file():
                    continue
                n = p.name.lower()
                if (".enh.tmp." in n or ".dz.tmp." in n or ".tmp dl" in n
                        or re.search(r"\.tmp\.[^.]+$", n) or n.endswith((".part", ".ytdl"))):
                    try:
                        p.unlink()
                        log.info("cleanup orphan tmp: %s", p)
                    except Exception:
                        pass
        except Exception:
            pass

SOURCE_ENCODE_CAP = {
    "youtube": 160,
    "spotify": 160,
    "deezer": 160,
    "soundcloud": 128,
    "4shared": 192,
    "fourshared": 192,
    "archive": 256,
    "premium": 320,
}


def encode_cap_for(source) -> int:
    c = SOURCE_ENCODE_CAP.get(str(source or "").lower())
    try:
        if c is not None and float(c) == float(c):
            return int(c)
    except Exception:
        pass
    return 160


ENCODE_CAP = SOURCE_ENCODE_CAP


def _portable_ffmpeg_dirs() -> list[Path]:
    """Kandidat folder `ffmpeg/bin` milik project, urut dari yang paling mungkin.

    Naik sampai 6 tingkat karena di layout release modul ini berada di
    `<target>/release/_up_/python-engine`, bukan `<root>/python-engine`.

    `VOCALYX_RUNTIME_DIR` juga ikut diperiksa. Engine boleh dijalankan dengan
    Python milik user (mis. yang punya PyTorch CUDA) sementara script-nya tetap
    berada di folder resource installer; tanpa env itu, folder `ffmpeg` milik
    runtime hasil ekstraksi tidak akan pernah ditemukan karena bukan ancestor
    dari lokasi script.
    """
    bases: list[Path] = [Path.cwd()]
    rt = os.environ.get("VOCALYX_RUNTIME_DIR") or ""
    if rt:
        bases.append(Path(rt))
    bases.extend(Path(__file__).resolve().parents[:6])
    out: list[Path] = []
    for b in bases:
        d = b / "ffmpeg" / "bin"
        if d not in out:
            out.append(d)
    return out


def ffmpeg_bin() -> str | None:
    """Pilih executable ffmpeg.

    Urutan itu penting, bukan asal. Binary dari imageio-ffmpeg bernama
    `ffmpeg-win-<versi>.exe` dan foldernya tidak berisi `ffmpeg`/`ffprobe`
    bernama polos, jadi library yang memanggil `ffmpeg` sebagai nama polos
    (audio_separator melakukan `check_output(["ffmpeg", "-version"])`) akan
    kena WinError 2 begitu folder itu dimasukkan ke PATH. Karena itu portable
    project dan ffmpeg sistem di Dahulukan, imageio hanya fallback terakhir.
    """
    cands = []
    for d in _portable_ffmpeg_dirs():
        cands.append(str(d / "ffmpeg.exe"))
        cands.append(str(d / "ffmpeg"))
    try:
        w = shutil.which("ffmpeg")
        if w:
            cands.append(w)
    except Exception:
        pass
    try:
        import imageio_ffmpeg
        cands.append(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        pass
    for cand in cands:
        try:
            if cand and Path(cand).is_file():
                subprocess.run([str(cand), "-version"], capture_output=True,
                               timeout=15, check=True)
                return str(cand)
        except Exception:
            continue
    return None


def to_wav(src: Path, dst: Path) -> Path:
    """Convert mp3/m4a/... -> wav 44.1k stereo untuk pemroses audio."""
    ff = ffmpeg_bin()
    if src.suffix.lower() == ".wav" and ff is None:
        return src
    if ff is None:
        raise RuntimeError("ffmpeg tidak ditemukan. Install ffmpeg atau `pip install imageio-ffmpeg`.")
    cmd = [ff, "-y", "-i", str(src), "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(dst)]
    subprocess.run(cmd, check=True, capture_output=True)
    return dst


def device_pick() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


download_progress: dict = {}
enhance_progress: dict = {}


def _set_progress(pid: str, **kw):
    """Defensive progress write: never throws when entry missing."""
    try:
        d = download_progress.get(pid)
        if isinstance(d, dict):
            d.update(kw)
        e = enhance_progress.get(pid)
        if isinstance(e, dict) and e is not d:
            e.update(kw)
    except Exception:
        pass


def ffprobe_bin() -> str | None:

    ff = None
    try:
        ff = ffmpeg_bin()
    except Exception:
        ff = None
    if ff and ff != "ffmpeg":
        for name in ("ffprobe.exe", "ffprobe"):
            cand = Path(ff).parent / name
            if cand.exists():
                return str(cand)
    for d in (Path.cwd() / "ffmpeg" / "bin", Path(__file__).parent.parent / "ffmpeg" / "bin"):
        for name in ("ffprobe.exe", "ffprobe"):
            cand = d / name
            if cand.is_file():
                return str(cand)
    return shutil.which("ffprobe") or shutil.which("ffprobe.exe")


def ffmpeg_loc_for_ytdlp() -> str:
    """Direktori berisi ffmpeg DAN ffprobe untuk --ffmpeg-location yt-dlp.
    imageio-ffmpeg hanya punya binari bernama unik tanpa ffprobe — lewati.
    Utamakan portable project ffmpeg/bin bila keduanya ada."""
    for d in (Path.cwd() / "ffmpeg" / "bin", Path(__file__).parent.parent / "ffmpeg" / "bin"):
        if (d / "ffmpeg.exe").is_file() and (d / "ffprobe.exe").is_file():
            return str(d)
        if (d / "ffmpeg").is_file() and (d / "ffprobe").is_file():
            return str(d)
    ff = None
    try:
        ff = ffmpeg_bin()
    except Exception:
        ff = None
    if ff and Path(ff).is_file():
        parent = Path(ff).parent
        for name in ("ffprobe.exe", "ffprobe"):
            if (parent / name).is_file():
                return str(parent)
    if ff and Path(ff).is_file():
        return str(Path(ff).parent)
    return ""


def _probe_audio(path: Path, timeout: int = 30) -> dict:
    """Probe {kbps, duration} file via ffprobe (stream audio, abaikan nilai kecil);
    fallback durasi mutagen. Mirror music-dl probeAudioKbps."""

    info = {"kbps": None, "duration": None}
    try:
        fp = ffprobe_bin()
        if not fp:
            fp = shutil.which("ffprobe") or shutil.which("ffprobe.exe")
        if fp and Path(path).exists():
            proc = subprocess.run([fp, "-v", "error", "-select_streams", "a:0",
                                   "-show_entries", "stream=bit_rate",
                                   "-show_entries", "format=bit_rate,format=duration",
                                   "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                                  capture_output=True, text=True,
                                  timeout=max(2, min(20, timeout)))
            nums = []
            for tok in (proc.stdout or "").replace(",", " ").split():
                try:
                    v = int(float(tok))
                    if v > 8000:
                        nums.append(v)
                except Exception:
                    pass
            if nums:
                info["kbps"] = int(round(max(nums) / 1000))
            try:
                d = _audio_duration_sec(Path(path))
                if d:
                    info["duration"] = float(d)
            except Exception:
                pass
    except Exception:
        pass
    if info["duration"] is None:
        try:
            d = _audio_duration_sec(Path(path))
            if d:
                info["duration"] = float(d)
        except Exception:
            pass
    return info


def _cache_hit_notice(track: dict, file_path: Path) -> dict:
    """Notice utk file yg sudah ada (skip download). Mirror music-dl cacheHitNotice:
    passthrough akurat hanya utk sumber direct (4shared/archive).
    Non-direct: source dikosongkan — via unduhan asli tidak diketahui di sini;
    frontend pakai riwayat downloadedFrom path yang sama utk badge."""
    probed = _probe_audio(file_path)
    actual = probed.get("kbps")
    src = (track.get("source") or "").lower()
    if src in ("4shared", "archive", "archiveorg"):
        return _make_notice(actual, actual, src, True)
    return _make_notice(actual, None, "", False)


def _make_notice(actual, source_kbps, source, passthrough: bool, cap=None) -> dict:
    """Mirror music-dl makeAudioNotice: capped = tidak passthrough dan cap < 320."""
    if cap is None:
        cap = encode_cap_for(source)
    return {"actualKbps": actual, "sourceKbps": source_kbps,
            "capped": (not passthrough) and cap < 320,
            "passthrough": bool(passthrough), "source": str(source or "")}


def _audio_duration_sec(path: Path) -> float | None:
    """Durasi file audio via mutagen (ringan, tanpa ffprobe)."""
    try:
        suf = path.suffix.lower()
        if suf == ".mp3":

            return float(MP3(str(path)).info.length)
        if suf == ".m4a":

            return float(MP4(str(path)).info.length)
    except Exception as e:
        log.warning("duration probe failed: %s", e)
    return None
