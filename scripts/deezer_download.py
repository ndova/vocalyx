#!/usr/bin/env python3
"""Download 1 track Deezer kualitas TERBAIK yang diizinkan akun (tanpa upscale).

- ARL HANYA via env DEEZER_ARL (tidak pernah argv/log/output).
- Kualitas: minta FLAC (9) dengan fallbackBitrate=True -> Free otomatis turun
  ke MP3_128, Premium dapat FLAC/320. Tidak ada pilihan bitrate user.
- Progress: baris {"dz_progress": pct} ke stdout (Node mengabaikan selain hasil).
- Hasil: SATU baris akhir {"ok": true, "file": path} atau
  {"ok": false, "error": "ARL_KOSONG|ARL_EXPIRED|TRACK_MISSING|TIER_LIMITED|TIMEOUT|..."}.
- Tidak menulis config/.arl ke mana pun (tidak seperti CLI deemix).

Usage: python deezer_download.py --track <id|url> --out <dir> [--timeout 420]
"""
import argparse
import json
import os
import sys
import time
from copy import deepcopy
from pathlib import Path

AUDIO_EXTS = (".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav")


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


class Listener:
    def __init__(self):
        self.started = time.time()

    def send(self, key, value=None):
        try:
            if key == "updateQueue":
                return
            if key in ("downloadInfo", "downloadWarn", "downloadError"):
                return
            if key == "updateProgress":
                try:
                    pct = 0
                    if isinstance(value, dict):
                        done = float(value.get("downloaded", 0) or 0)
                        total = float(value.get("total", 0) or 0)
                        if total > 0:
                            pct = max(0, min(100, done / total * 100))
                    emit({"dz_progress": round(pct, 1)})
                except Exception:
                    pass
        except Exception:
            pass


def newest_audio(outdir):
    best = None
    best_key = (-1, -1.0)
    try:
        for p in Path(outdir).rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in AUDIO_EXTS:
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            if st.st_size < 1024:
                continue
            key = (st.st_size, st.st_mtime)
            if key > best_key:
                best_key = key
                best = p
    except OSError:
        pass
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", required=True, help="Deezer track id atau URL")
    ap.add_argument("--out", required=True, help="Folder output")
    ap.add_argument("--timeout", type=int, default=420)
    args = ap.parse_args()

    arl = str(os.environ.get("DEEZER_ARL", "") or "").strip()
    if not arl:
        emit({"ok": False, "error": "ARL_KOSONG"})
        return 0

    outdir = Path(args.out)
    try:
        outdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        emit({"ok": False, "error": "OUTDIR_GAGAL: " + str(e)[:100]})
        return 0

    raw = str(args.track or "").strip()
    if not raw:
        emit({"ok": False, "error": "TRACK_KOSONG"})
        return 0
    link = raw if raw.startswith("http") else f"https://www.deezer.com/track/{raw}"

    try:
        from deezer import Deezer, TrackFormats
        from deemix import generateDownloadObject
        from deemix.downloader import Downloader
        from deemix.settings import DEFAULTS, OverwriteOption
        from deemix.itemgen import GenerationError
        from deemix.errors import DownloadFailed
    except Exception as e:
        emit({"ok": False, "error": "LIB_MISSING: " + str(e)[:120]})
        return 0

    deadline = time.time() + max(60, min(900, int(args.timeout or 420)))
    try:
        dz = Deezer()
        if not dz.login_via_arl(arl):
            emit({"ok": False, "error": "ARL_EXPIRED"})
            return 0
    except Exception as e:
        emit({"ok": False, "error": "JARINGAN: " + str(e)[:140]})
        return 0

    settings = deepcopy(DEFAULTS)
    settings["downloadLocation"] = str(outdir)
    settings["maxBitrate"] = str(int(TrackFormats.FLAC))
    settings["fallbackBitrate"] = True
    settings["fallbackSearch"] = False
    settings["overwriteFile"] = OverwriteOption.OVERWRITE
    settings["saveArtwork"] = False
    settings["saveArtworkArtist"] = False
    settings["logErrors"] = False
    settings["logSearched"] = False
    settings["createM3U8File"] = False
    settings["syncedLyrics"] = False

    listener = Listener()
    try:
        obj = generateDownloadObject(dz, link, int(TrackFormats.FLAC), {}, listener)
    except GenerationError as e:
        msg = str(getattr(e, "message", e) or "")[:160]
        emit({"ok": False, "error": "TRACK_MISSING: " + msg if msg else "TRACK_MISSING"})
        return 0
    except Exception as e:
        emit({"ok": False, "error": "RESOLVE_GAGAL: " + str(e)[:140]})
        return 0

    try:
        Downloader(dz, obj, settings, listener).start()
    except DownloadFailed as e:
        emit({"ok": False, "error": "DOWNLOAD_GAGAL: " + str(e)[:140]})
        return 0
    except Exception as e:
        name = type(e).__name__
        if "WrongLicense" in name or "LICENSE" in str(e)[:40].upper():
            emit({"ok": False, "error": "TIER_LIMITED"})
        else:
            emit({"ok": False, "error": "DOWNLOAD_GAGAL: " + str(e)[:140]})
        return 0

    if time.time() > deadline:
        emit({"ok": False, "error": "TIMEOUT"})
        return 0

    best = newest_audio(outdir)
    if not best:
        emit({"ok": False, "error": "FILE_TIDAK_ADA"})
        return 0
    emit({"ok": True, "file": str(best)})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        try:
            emit({"ok": False, "error": "FATAL"})
        except Exception:
            pass
        sys.exit(2)
