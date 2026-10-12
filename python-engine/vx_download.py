"""VocaLyx engine - download routes (Spotify/Deezer/YouTube/SC/4shared/Archive) plus enhance."""
import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from vx_core import (
    AUDIO_JOB_LOCK, _audio_duration_sec, _cache_hit_notice, _make_notice,
    _probe_audio, _set_progress, download_progress, encode_cap_for, ffmpeg_bin,
    ffmpeg_loc_for_ytdlp, ffprobe_bin, log,
)
from vx_cover import _embed_cover, _resolve_cover_bytes
from vx_search import (
    _fetch_4shared_bytes, _resolve_4shared, _sc_full_available, _scsearch_url,
    _valid_cookies, _via_for_query, _youtube_queue, _ytm_url, _ytsearch_url,
)

router = APIRouter()


def _strict_map(options: dict) -> dict:
    """Map switch sumber-asli per source + fallback kunci lama scStrict."""
    m = options.get("strictSources")
    if not isinstance(m, dict):
        m = {}
    out = {str(k).lower(): bool(v) for k, v in m.items()}
    if "soundcloud" not in out and options.get("scStrict") is not None:
        out["soundcloud"] = bool(options.get("scStrict"))
    return out


def _is_strict(source: str, options: dict) -> bool:
    return bool(_strict_map(options).get((source or "").lower(), False))


def _yt_cookie_args(options: dict) -> list:
    """Bangun args cookies yt-dlp untuk YouTube.
    options['ytCookiesPath'] menang bila terisi (path cookies.txt Netscape).
    Lalu options['ytCookies']: 'off' (default) | 'auto' | 'chrome' | 'edge' | path."""
    path = str(options.get("ytCookiesPath") or "").strip()
    if path:
        ok = _valid_cookies(path)
        return ["--cookies", ok] if ok else []
    mode = str(options.get("ytCookies") or "off").strip().lower()
    if mode in ("", "off", "none", "no"):
        return []
    if mode == "auto":
        for c in (
            Path.home() / "Downloads" / "cookies.txt",
            Path.home() / ".vocalyx" / "cookies.txt",
            Path.cwd() / "cookies.txt",
        ):
            ok = _valid_cookies(str(c))
            if ok:
                return ["--cookies", ok]
        return []
    if mode in ("chrome", "edge", "firefox", "brave", "opera"):
        return ["--cookies-from-browser", mode]
    ok = _valid_cookies(mode)
    return ["--cookies", ok] if ok else []


def _is_yt_query(q: str) -> bool:
    s = str(q or "").lower()
    return "youtube.com" in s or s.startswith("ytsearch")


def _bot_hit(yt_tail: list) -> bool:
    tail = " ".join(yt_tail or []).lower()
    return any(x in tail for x in (
        "not a bot", "sign in to confirm", "cookies might be needed",
        "use --cookies", "login required",
    ))


def _yt_dlp_cmd() -> list[str] | None:
    for base in _venv_python_candidates():
        cmd = [str(base), "-m", "yt_dlp"]
        try:
            proc = subprocess.run(cmd + ["--version"], capture_output=True, text=True, timeout=25)
            if proc.returncode == 0:
                return cmd
        except Exception:
            continue
    for name in ("yt-dlp", "yt-dlp.exe"):
        try:
            found = shutil.which(name)
        except Exception:
            found = None
        if found:
            return [str(found)]
    return None


def _venv_python_candidates() -> list[Path]:
    out: list[Path] = []
    try:
        out.append(Path(sys.executable))
    except Exception:
        pass
    return out


def _sc_alt_urls(artist: str, title: str, skip=None, cookies: str = "", limit: int = 3) -> list:
    """Upload SC alternatif sejudul yg FULL (lewati URL yg sudah dicoba)."""

    skip = set(skip or [])
    out = []
    try:
        cmd0 = _yt_dlp_cmd()
        if not cmd0:
            return out
        q = f"{(artist or '').strip()} - {(title or '').strip()}".strip(" -")[:200]
        if not q:
            return out
        cmd = cmd0 + ["--quiet", "--no-warnings", "--flat-playlist", "--dump-json", "scsearch8:" + q]
        if cookies:
            cmd += ["--cookies", cookies]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if proc.returncode != 0:
            return out
        cands = []
        for line in (proc.stdout or "").splitlines():
            try:
                j = json.loads(line.strip())
            except Exception:
                continue
            if not isinstance(j, dict):
                continue
            page = str(j.get("webpage_url") or "")
            if not page or "soundcloud.com" not in page.lower() or page in skip:
                continue
            try:
                dur = int(float(j.get("duration"))) if j.get("duration") else None
            except Exception:
                dur = None
            if dur and dur <= 40:
                continue
            cands.append(page)
            if len(cands) >= limit + 2:
                break
    
        with ThreadPoolExecutor(max_workers=3) as ex:
            checks = list(ex.map(lambda u: (u, _sc_full_available(u, cookies, timeout=20)), cands))
        for u, full in checks:
            if full and len(out) < limit:
                out.append(u)
    except Exception as e:
        log.warning("sc alt search failed: %s", e)
    return out


def _resolve_download_url(track: dict, cookies: str = "", prefer_direct: bool = True) -> tuple:
    """Port music-dl resolveDownloadUrl: (url, via).
    via: archive-direct | soundcloud-direct | soundcloud-search | youtube-music | youtube.
    prefer_direct=False (switch sumber-asli OFF): lewati sumber asli -> langsung YouTube."""

    if prefer_direct:
        for cand in (track.get("trackId") or "", track.get("previewUrl") or ""):
            s = str(cand).strip()
            if re.match(r"^https?://[^/]*archive\.org/download/", s, re.I) and "\0" not in s:
                return s, "archive-direct"
    artist, title = track.get("artist") or "", track.get("title") or ""
    try:
        dur = int(float(track.get("duration"))) if track.get("duration") else None
    except Exception:
        dur = None
    if prefer_direct and (track.get("source") or "").lower() == "soundcloud":
        page = str(track.get("trackId") or "")
        ok_page = bool(re.match(r"^https?://", page)) and "soundcloud.com" in page.lower() \
            and not re.search(r"/tracks/\d+(\/|\?|#|$)", page, re.I)
        if ok_page:
            if dur and dur > 0 and dur <= 40:
                ym = _ytm_url(artist, title)
                if ym:
                    return ym, "youtube-music"
                return _ytsearch_url(artist, title), "youtube"
            if cookies and not _sc_full_available(page, cookies):
                alts = [u for u in _sc_alt_urls(artist, title, skip={page}, cookies=cookies) if u != page]
                if alts:
                    log.info("SC direct preview-only, pakai alternatif: %s", alts[0][:80])
                    return alts[0], "soundcloud-alt"
                log.info("SC direct hanya preview meski login, fallback YouTube")
                ym = _ytm_url(artist, title)
                if ym:
                    return ym, "youtube-music"
                return _ytsearch_url(artist, title), "youtube"
            return page, "soundcloud-direct"
        sc = _scsearch_url(artist, title, cookies=cookies)
        if sc:
            return sc, "soundcloud-search"
        return _ytsearch_url(artist, title), "youtube"
    ym = _ytm_url(artist, title)
    if ym:
        return ym, "youtube-music"
    return _ytsearch_url(artist, title), "youtube"


def _via_source(via: str, track: dict) -> str:
    v = (via or "").lower()
    if v.startswith("soundcloud"):
        return "soundcloud"
    if v.startswith("youtube"):
        return "youtube"
    if v.startswith("4shared"):
        return "4shared"
    if v.startswith("archive"):
        return "archive"
    if v.startswith("premium") or v.startswith("spotify"):
        return "premium"
    return str((track or {}).get("source") or "")


def _spotify_id_from_track(track: dict) -> str | None:
    raw = str(track.get("trackId") or track.get("id") or "").strip()
    if not raw:
        return None
    if "open.spotify.com/track/" in raw:
        try:
            return raw.split("open.spotify.com/track/")[1].split("?")[0].split("/")[0].strip()
        except Exception:
            pass
    if raw.startswith("spotify:track:"):
        return raw.split(":")[-1].strip()
    if len(raw) >= 22 and raw.replace("-", "").replace("_", "").isalnum():
        if "/" not in raw and ":" not in raw:
            return raw.split("?")[0].strip()
    if "/" in raw:
        try:
            return raw.rstrip("/").split("/")[-1].split("?")[0].strip()
        except Exception:
            pass
    return raw if raw else None


def _unlink_quiet(p) -> None:
    """Hapus file bila ada (diamkan semua error) - dipakai untuk bersihkan artefak tmp."""
    if not p:
        return
    try:
        Path(p).unlink(missing_ok=True)
    except Exception:
        pass


_INTERPRETER_PROBE: dict = {}
_PREMIUM_MISSING: dict = {}  # alasan terakhir `_premium_backend` gagal resolve, per layanan, supaya pesan ke user menyebut penyebab nyata dan bukan selalu "paket tidak terbundel"
_PREMIUM_PROCS: list = []  # child Spotify Connect milik proses server ini, supaya disconnect bisa menghentikannya (tanpa registry, proses yatim dari server lama tidak ikut)


def _interpreter_usable(exe: str) -> bool:
    """True kalau interpreter venv premium benar-benar bisa dijalankan.

    Venv tidak bisa dipindah: `pyvenv.cfg` menyimpan `home` absolut ke Python
    yang membuatnya. Kalau projectnya dipindah/rename, atau Python aslinya
    di-uninstall, `Scripts/python.exe` masih ADA tapi isinya cuma launcher
    yang gagal seketika:

        No Python at '"...\\Programs\\Python\\Python311\\python.exe"'   (exit 103)

    Kalau hanya dicek `.exists()`, venv rusak itu tetap dipilih, seluruh
    premium child process langsung mati, dan Connect cuma berakhir sebagai
    "timeout 120 detik" tanpa menyebut sebabnya. Hasil probe di-cache karena
    interpreter tidak berubah selama engine hidup.
    """
    cached = _INTERPRETER_PROBE.get(exe)
    if cached is not None:
        return cached
    ok = False
    try:
        proc = subprocess.run([exe, "-c", "pass"], capture_output=True,
                              timeout=25, text=True)
        ok = proc.returncode == 0
        if not ok:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            log.warning("premium backend: interpreter rusak %s: %s", exe,
                        detail[0][:160] if detail else "exit %s" % proc.returncode)
    except Exception as e:
        log.warning("premium backend: interpreter tidak jalan %s: %s", exe, e)
        ok = False
    _INTERPRETER_PROBE[exe] = ok
    return ok


def _premium_backend(service: str, script_name: str):
    """Resolve (interpreter, script, extra_env) backend premium per layanan.

    Prioritas: paket staged `premium/<service>/` (ikut resource installer,
    dijalankan dengan interpreter mesin + PYTHONPATH ke paketnya) -> fallback
    dev: venv lokal scripts/<service>-venv + glue repo scripts/. Venv lokal
    TIDAK ikut terbundel, jadi build wajib men-stagel paket via
    scripts/stage_premium.py (beforeBuildCommand).
    """
    stem = script_name[:-3] if script_name.endswith(".py") else script_name
    for base in (Path.cwd() / "premium",
                 Path(__file__).resolve().parent.parent / "build" / "premium"):
        pkg = base / service
        vault = pkg / f"{stem}.pyv"
        loader = pkg / "vx_vault.pyc"
        if vault.is_file() and loader.is_file():
            extra = {"PYTHONPATH": str(pkg),
                     "VX_VAULT_TARGET": str(vault)}
            if os.environ.get("PYTHONPATH"):
                extra["PYTHONPATH"] += os.pathsep + os.environ["PYTHONPATH"]
            return str(sys.executable), str(loader), extra
        for cand in (pkg / f"{stem}.pyc", pkg / script_name):
            if cand.is_file():
                extra = {"PYTHONPATH": str(pkg)}
                if os.environ.get("PYTHONPATH"):
                    extra["PYTHONPATH"] += os.pathsep + os.environ["PYTHONPATH"]
                return str(sys.executable), str(cand), extra
    venv_dir = Path.cwd() / "scripts" / f"{service}-venv"
    script = Path.cwd() / "scripts" / script_name
    saw_venv = False
    for cand in (venv_dir / "Scripts" / "python.exe",
                 venv_dir / "bin" / "python"):
        if not cand.is_file():
            continue
        saw_venv = True
        if not _interpreter_usable(str(cand)):
            continue
        if script.is_file():
            return str(cand), str(script), {}
    _PREMIUM_MISSING[service] = (
        f"venv {venv_dir.name} ada tapi interpreter-nya tidak bisa dijalankan "
        f"(Python pembuat venv sudah tidak ada / project dipindah). "
        f"Hapus folder itu lalu rebuild: python scripts/stage_premium.py"
        if saw_venv else
        f"paket premium belum ter-stage untuk {service}"
    )
    return None


def _premium_missing_error(service: str, fallback: str) -> str:
    """Pesan 'backend tidak ada' yang menyebut penyebab sebenarnya."""
    note = _PREMIUM_MISSING.get(service)
    return f"{fallback} ({note})" if note else fallback


def _spotify_try_premium(track: dict, out_path: Path, options: dict, download_id: str) -> dict:
    """Coba download Premium via backend librespot (paket staged / venv dev).

    Hanya file kredensial reusable dari Spotify Connect — login
    username/password sudah dimatikan Spotify untuk app pihak ketiga.
    """
    try:
        sid = _spotify_id_from_track(track)
        if not sid:
            return {"need_creds": True, "failed": True, "error": "Track Spotify tanpa ID valid — tidak bisa Premium"}
        be = _premium_backend("spotify", "spotify_premium_download.py")
        if not be:
            return {"failed": True, "error": "Backend Spotify Premium tidak ada (paket premium tidak terbundel; jalankan stage_premium.py lalu build ulang)"}
        venv_py, script, prem_env = be
        cred_path = Path.cwd() / ".spotify-premium" / "credentials.json"
        if not (cred_path.exists() and cred_path.stat().st_size > 16):
            return {"need_creds": True, "failed": True, "error": "Kredensial Premium kosong (hubungkan via Spotify Connect dulu di Settings)"}
        download_progress[download_id]["percent"] = 8

        tmp_dir = tempfile.mkdtemp(prefix="sp-prem-")
        ogg_path = str(Path(tmp_dir) / "out.ogg")

        env = {**os.environ, **prem_env}
        cmd = [str(venv_py), str(script), "--track", sid, "--out", ogg_path, "--quality", "very_high", "--stored-creds", str(cred_path)]
        for didp in [Path.cwd() / ".spotify-premium" / "device_id.txt"]:
            try:
                if didp.exists():
                    did = didp.read_text(encoding="utf-8", errors="ignore").strip()[:64]
                    if did:
                        cmd += ["--device-id", did]
                    break
            except Exception:
                pass
        cache_dir = str(Path.cwd() / ".spotify-premium" / "cache")
        try:
            Path(cache_dir).mkdir(parents=True, exist_ok=True)
            cmd += ["--cache-dir", cache_dir]
        except Exception:
            pass
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, bufsize=1)
        stdout_lines = []
        err_buf = []
        try:

            start = time.time()
            stdout_lines = []
            err_text = ""
            while True:
                line = proc.stdout.readline() if proc.stdout else ""
                if line:
                    stdout_lines.append(line.rstrip("\n"))
                    try:
                        j = json.loads(line.strip())
                        if isinstance(j, dict) and "bytes" in j:
                            b = int(j.get("bytes") or 0)
                            pct = 8 + min(67, int(b / (8 * 1024 * 1024) * 67))
                            download_progress[download_id]["percent"] = pct
                        if isinstance(j, dict) and j.get("progress") is not None and "bytes" not in j:
                            cur = download_progress[download_id].get("percent", 8)
                            download_progress[download_id]["percent"] = min(70, cur + 3)
                    except Exception:
                        pass
                    continue
                if proc.poll() is not None:
                    break
                if time.time() - start > 3 and proc.poll() is None:
                    cur = download_progress[download_id].get("percent", 8)
                    if cur < 65:
                        download_progress[download_id]["percent"] = cur + 1
                    start = time.time()
                time.sleep(0.15)
            try:
                _, err_text = proc.communicate(timeout=5)
                err = err_text or ""
            except Exception:
                err = ""
            try:
                rem = proc.stdout.read() if proc.stdout else ""
                if rem:
                    stdout_lines += rem.splitlines()
            except Exception:
                pass
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
            return {"failed": True, "error": "Timeout download Premium (Spotify lambat/timeout)"}
        except Exception as e:
            return {"failed": True, "error": str(e)[:300]}
        result = None
        for line in reversed(stdout_lines):
            line = line.strip()
            if not line:
                continue
            try:
                j = json.loads(line)
                if isinstance(j, dict) and ("ok" in j or "error" in j or "progress" in j):
                    if "ok" in j:
                        result = j
                        break
            except Exception:
                continue
        if not result:
            err_txt = (err or "")[:500] if 'err' in locals() else ""
            return {"failed": True, "error": f"Premium gagal (no result): {err_txt[:200]}"}
        if not result.get("ok"):
            errm = str(result.get("error") or "Premium gagal")[:500]
            low = errm.lower()
            if "badcredentials" in low or "bad credentials" in low or "401" in low or "unauthorized" in low:
                errm = "Login username/password sudah dimatikan Spotify untuk aplikasi pihak ketiga (librespot) — bukan salah akun Anda. Gunakan Connect: pilih device VocaLyx-XXXX di aplikasi Spotify (satu WiFi); kredensial tersimpan reusable tanpa password."
            need = "kredensial" in low or "connect" in low or "badcredentials" in low
            return {"failed": True, "need_creds": need, "error": errm}
        ogg_file = result.get("path") or ogg_path
        if not ogg_file or not Path(ogg_file).exists():
            if not Path(ogg_path).exists():
                return {"failed": True, "error": "File OGG Premium tidak terbentuk"}
            ogg_file = ogg_path
        download_progress[download_id]["percent"] = 78
        ext = out_path.suffix.lower().lstrip(".") or "mp3"
        ff = ffmpeg_bin()
        if not ff:
            try:
                if Path(ogg_file) != out_path:
                
                    shutil.move(str(ogg_file), str(out_path))
                download_progress[download_id]["percent"] = 90
                return {"success": True, "filePath": str(out_path), "sourceKbps": 320}
            except Exception as e:
                return {"failed": True, "error": f"Gagal simpan OGG: {e}"}
            finally:
                try:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                except Exception:
                    pass
        tmp_out = str(out_path) + ".prem." + ext
        try:
            if ext == "m4a":
                codec = ["-vn", "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"]
            else:
                codec = ["-vn", "-c:a", "libmp3lame", "-b:a", "320k"]
            conv_cmd = [ff, "-y", "-i", str(ogg_file)] + codec + [str(tmp_out)]
            proc = subprocess.run(conv_cmd, capture_output=True, timeout=120)
            download_progress[download_id]["percent"] = 88
            if proc.returncode == 0 and Path(tmp_out).exists() and Path(tmp_out).stat().st_size > 1024:
                try:
                    if out_path.exists():
                        out_path.unlink()
                except Exception:
                    pass
                Path(tmp_out).rename(out_path)
                try:
                    Path(ogg_file).unlink(missing_ok=True)
                except Exception:
                    pass
                try:
                
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                except Exception:
                    pass
                return {"success": True, "filePath": str(out_path), "sourceKbps": 320}
            return {"failed": True, "error": f"Convert Premium gagal: {(proc.stderr or proc.stdout or b'')[:200].decode(errors='ignore') or f'exit {proc.returncode}'}".strip()}
        except Exception as e:
            return {"failed": True, "error": str(e)[:300]}
        finally:
            _unlink_quiet(tmp_out)
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass
    except Exception as e:
        _unlink_quiet(locals().get("tmp_out"))
        _td = locals().get("tmp_dir")
        if _td:
            try:
                shutil.rmtree(_td, ignore_errors=True)
            except Exception:
                pass
        return {"failed": True, "error": str(e)[:400]}


def _deezer_id_from_track(track: dict) -> str | None:
    raw = str(track.get("trackId") or track.get("id") or "").strip()
    if not raw:
        return None

    m = re.search(r"/track/(\d+)", raw)
    if m:
        return m.group(1)
    m = re.search(r"(\d{6,})", raw)
    if m:
        return m.group(1)
    if raw.startswith("dz-"):
        return raw[3:].strip()
    return None


def _deezer_get_arl(options: dict) -> str:
    return str(options.get("deezerArl") or "").strip()[:512]


def _deezer_try_full(track: dict, out_path: Path, options: dict, download_id: str) -> dict:
    """Download Deezer full via deemix venv + ARL. Return {success/filePath/sourceKbps/error}."""
    try:
        did = _deezer_id_from_track(track)
        if not did or not did.isdigit():
            return {"failed": True, "error": "Track Deezer tanpa ID valid — tidak bisa download full"}
        arl = _deezer_get_arl(options)
        if not arl:
            return {"need_creds": True, "failed": True, "error": "ERR_DEEZER_ARL_REQUIRED: Isi ARL Deezer dulu (Settings -> Deezer ARL) untuk download full."}
        be = _premium_backend("deezer", "deezer_download.py")
        if not be:
            return {"failed": True, "error": "Backend Deezer tidak ada (paket premium tidak terbundel; jalankan stage_premium.py lalu build ulang)"}

        staging = tempfile.mkdtemp(prefix="dz-dl-")
        env = {**os.environ, **be[2]}
        env["DEEZER_ARL"] = arl
        cmd = [be[0], be[1], "--track", did, "--out", staging]
        download_progress[download_id]["percent"] = 8
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, bufsize=1)
        stdout_lines = []
        try:
            start = time.time()
            while True:
                line = proc.stdout.readline() if proc.stdout else ""
                if line:
                    stdout_lines.append(line.rstrip("\n"))
                    try:
                        j = json.loads(line.strip())
                        if isinstance(j, dict) and "dz_progress" in j:
                            pct = int(j["dz_progress"])
                            download_progress[download_id]["percent"] = max(8, min(82, 42 + int(pct * 0.4)))
                    except Exception:
                        pass
                    continue
                if proc.poll() is not None:
                    break
                if time.time() - start > 2 and proc.poll() is None:
                    cur = download_progress[download_id].get("percent", 8)
                    if cur < 40:
                        download_progress[download_id]["percent"] = cur + 1
                    start = time.time()
                time.sleep(0.2)
            try:
                rem_out, rem_err = proc.communicate(timeout=10)
                if rem_out:
                    stdout_lines += rem_out.splitlines()
                err = rem_err or ""
            except Exception:
                err = ""
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
            return {"failed": True, "error": "Timeout download Deezer (ARL lambat/timeout)"}
        result = None
        for line in reversed(stdout_lines):
            line = line.strip()
            if not line:
                continue
            try:
                j = json.loads(line)
                if isinstance(j, dict) and "ok" in j:
                    result = j
                    break
            except Exception:
                continue
        if not result:
            return {"failed": True, "error": f"Deezer gagal (no result): {(err or '')[:200]}"}
        if not result.get("ok"):
            errm = str(result.get("error") or "Deezer gagal")[:500]
            low = errm.lower()
            need = "arl" in low and ("kosong" in low or "required" in low or "expired" in low or "invalid" in low)
            return {"failed": True, "need_creds": need, "error": errm}
        staged_file = result.get("file") or ""
        if staged_file and Path(staged_file).exists():
            src_file = Path(staged_file)
        else:
            cands = [p for p in Path(staging).rglob("*") if p.is_file() and p.suffix.lower() in (".mp3", ".flac", ".wav", ".ogg", ".m4a")]
            if not cands:
                return {"failed": True, "error": "File Deezer tidak terbentuk (staging kosong)"}
            src_file = max(cands, key=lambda p: p.stat().st_mtime)
        probed = _probe_audio(src_file)
        src_kbps = probed.get("kbps")
        ext = out_path.suffix.lower().lstrip(".") or "mp3"
        staged_ext = src_file.suffix.lower().lstrip(".")
        download_progress[download_id]["percent"] = 84
        if staged_ext == ext:
            try:
                if out_path.exists():
                    out_path.unlink()
            
                shutil.move(str(src_file), str(out_path))
            except Exception:
                try:
                
                    shutil.copy(str(src_file), str(out_path))
                except Exception as e:
                    return {"failed": True, "error": f"Gagal pindah file Deezer: {e}"}
            try:
            
                shutil.rmtree(staging, ignore_errors=True)
            except Exception:
                pass
            return {"success": True, "filePath": str(out_path), "sourceKbps": src_kbps or (320 if probed.get("duration") else 192), "passthrough": True}
        tgt = max(64, min(320, src_kbps or 192))
        ff = ffmpeg_bin()
        if not ff:
            try:
            
                shutil.move(str(src_file), str(out_path))
                return {"success": True, "filePath": str(out_path), "sourceKbps": src_kbps}
            except Exception as e:
                return {"failed": True, "error": f"Gagal simpan Deezer: {e}"}
        tmp_out = str(out_path) + ".dz.tmp." + ext
        try:
            if ext == "m4a":
                codec = ["-vn", "-c:a", "aac", "-b:a", f"{tgt}k", "-movflags", "+faststart"]
            else:
                codec = ["-vn", "-c:a", "libmp3lame", "-b:a", f"{tgt}k"]
            proc2 = subprocess.run([ff, "-y", "-i", str(src_file)] + codec + [tmp_out], capture_output=True, timeout=120)
            if proc2.returncode == 0 and Path(tmp_out).exists() and Path(tmp_out).stat().st_size > 1024:
                try:
                    if out_path.exists():
                        out_path.unlink()
                except Exception:
                    pass
                Path(tmp_out).rename(out_path)
                try:
                
                    shutil.rmtree(staging, ignore_errors=True)
                except Exception:
                    pass
                return {"success": True, "filePath": str(out_path), "sourceKbps": src_kbps}
            return {"failed": True, "error": f"Convert Deezer gagal: {(proc2.stderr or proc2.stdout or b'')[-400:].decode(errors='ignore') or f'exit {proc2.returncode}'}".strip()}
        except Exception as e:
            return {"failed": True, "error": str(e)[:300]}
        finally:
            try:
                _t = Path(tmp_out)
                if _t.exists():
                    _t.unlink()
            except Exception:
                pass
    except Exception as e:
        return {"failed": True, "error": str(e)[:400]}


def _duration_ok(actual, expected) -> bool:
    """True bila durasi hasil masuk akal vs metadata track (opsi bila expected None)."""
    if not expected or expected <= 60:
        return True
    if not actual:
        return False
    return not (actual <= 45 or actual < expected * 0.5)


def _list_stem_files(folder, stem: str) -> list:
    """List file dgn prefix '{stem}.' — hindari glob [ ] * ? pada judul lagu."""
    out = []
    try:
        for p in Path(folder).iterdir():
            if not p.is_file():
                continue
            name = p.name
            if name.startswith(stem + ".") or p.stem == stem:
                out.append(p)
    except Exception:
        pass
    return out


def _is_partial_artifact(p: Path) -> bool:
    """Artefak unduhan parsial yt-dlp / tmp enhance / convert (bukan lagu final valid)."""
    n = p.name.lower()
    if ".enh.tmp." in n or ".dz.tmp." in n or ".prem." in n or ".tmp dl" in n or re.search(r"\.tmp\.[^.]+$", n):
        return True
    if n.endswith((".part", ".ytdl", ".temp", ".tmp")) or ".part" in n:
        return True
    if re.search(r"\.f\d+\.", n):
        return True
    try:
        if p.suffix.lower() in (".mp4", ".webm", ".m4a", ".mp3", ".opus", ".ogg", ".flac", ".wav"):
            if p.stat().st_size < 64 * 1024:
                return True
    except Exception:
        return True
    return False


def _probe_duration(path: Path) -> float | None:
    """Durasi dgn retry singkat (mutagen → ffprobe)."""
    d = _audio_duration_sec(path)
    if d:
        return d
    try:
        d = _probe_audio(path).get("duration")
        if d:
            return float(d)
    except Exception:
        pass
    time.sleep(0.3)
    d = _audio_duration_sec(path)
    if d:
        return d
    try:
        d = _probe_audio(path).get("duration")
        return float(d) if d else None
    except Exception:
        return None


def _finalize_download(download_id: str, out_path: Path, via: str, source_kbps,
                       source: str, passthrough: bool, track: dict, options: dict = None) -> bool:
    """Embed cover + enhance (optional) + probe final + tulis progress done beserta audioNotice."""
    opts = options or {}
    try:
        try:
            expected0 = int(float(track.get("duration"))) if track.get("duration") else None
        except Exception:
            expected0 = None
        actual0 = _probe_duration(out_path)
        if expected0 and expected0 > 60:
            if actual0 is None:
                log.warning("duration gate pre skipped (probe None) path=%s expected=%s", out_path, expected0)
            elif not _duration_ok(actual0, expected0):
                log.warning("finalize blocked: durasi %s vs expected %ss path=%s", actual0, expected0, out_path)
                try:
                    out_path.unlink()
                except Exception:
                    pass
                download_progress[download_id] = {"percent": 0, "status": "failed",
                    "downloadedFrom": via,
                    "error": f"File rusak/tidak lengkap (durasi {actual0:.0f} dtk, ekspektasi ~{expected0} dtk) — tidak disimpan"}
                return False
    except Exception as e:
        log.warning("duration gate skipped: %s", e)

    try:
        cov = _resolve_cover_bytes(track)
        if cov:
            _embed_cover(out_path, track.get("title") or "", track.get("artist") or "",
                         track.get("album") or "", cov, with_meta=True)
    except Exception as e:
        log.warning("auto-embed skipped: %s", e)

    enhanced = False
    try:
        enhanced = _enhance_audio(out_path, opts, download_id)
    except Exception as e:
        log.warning("enhance error: %s", e)

    probed = _probe_audio(out_path)
    try:
        try:
            expected1 = int(float(track.get("duration"))) if track.get("duration") else None
        except Exception:
            expected1 = None
        actual1 = _probe_duration(out_path) or probed.get("duration")
        if expected1 and expected1 > 60:
            if actual1 is None:
                log.warning("duration gate post skipped (probe None) path=%s", out_path)
            elif not _duration_ok(actual1, expected1):
                log.warning("finalize blocked post-enhance: durasi %s vs expected %ss path=%s", actual1, expected1, out_path)
                try:
                    out_path.unlink()
                except Exception:
                    pass
                download_progress[download_id] = {"percent": 0, "status": "failed",
                    "downloadedFrom": via,
                    "error": f"File rusak setelah proses (durasi {actual1:.0f} dtk, ekspektasi ~{expected1} dtk) — tidak disimpan"}
                return False
    except Exception as e:
        log.warning("post-enhance duration gate skipped: %s", e)

    notice = _make_notice(probed.get("kbps"), source_kbps, source, passthrough)
    if enhanced:
        notice = {**notice, "enhanced": True}
    download_progress[download_id] = {"percent": 100, "status": "done", "path": str(out_path),
                                      "downloadedFrom": via, "audioNotice": notice}
    return True


def _probe_bits(path: Path, timeout: int = 30) -> int | None:
    """Bit depth PCM file via ffprobe (hanya ``bits_per_raw_sample``).

    Dipakai supaya encode ulang mempertahankan bit depth sumber. Tanpa itu
    ffmpeg memilih 24-bit dari input float untuk FLAC sehingga file 16-bit
    membengkak ~70% tanpa tambahan informasi apa pun - sementara file 24-bit
    harus tetap 24-bit, dipaksa s16 justru merusak.

    Hanya ``bits_per_raw_sample`` yang dipercaya; ``sample_fmt`` ambigu
    (``s32`` bisa berarti 24 atau 32 bit). File lossy tidak melapor, dan
    memang ``None`` di situ berarti "pakai 16-bit" karena sumbernya sudah
    kehilangan informasi lebih dari itu.
    """
    fp = ffprobe_bin()
    if not fp or not Path(path).exists():
        return None
    try:
        proc = subprocess.run(
            [fp, "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=bits_per_raw_sample",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=max(2, min(20, timeout)))
    except Exception:
        return None
    raw = (proc.stdout or "").strip().splitlines()
    if raw:
        v = raw[0].strip()
        if v.isdigit() and int(v) > 0:
            return int(v)
    return None


def _enhance_audio(out_path: Path, options: dict, download_id: str, force: bool = False) -> bool:
    """Post-process audio: declip + HQ resample + loudnorm.
    Returns True if enhanced (file replaced), False if skipped/failed.
    force=True bypasses the lossy-source gate (explicit per-file enhance)."""

    try:
        audio_enhance = bool(options.get("audioEnhance", False))
        normalize_volume = bool(options.get("normalizeVolume", False))
        target_lufs = float(options.get("targetLufs", -14))
        if not (audio_enhance or normalize_volume):
            return False
        if not (-30 <= target_lufs <= -1):
            target_lufs = -14
        if not force:
            track_source = (options.get("track_source") or "").lower()
            lossy_sources = {"deezer", "youtube", "youtube-music", "youtube-fallback", "soundcloud", "soundcloud-search", "soundcloud-direct", "4shared", "archive", "archive-direct"}
            if track_source not in lossy_sources:
                return False
        ff = ffmpeg_bin()
        if not ff:
            return False
        hq_resample = "aresample=osr=44100:dither_method=triangular"
        if audio_enhance and normalize_volume:
            filter_chain = f"adeclip,{hq_resample},loudnorm=I={target_lufs}:TP=-1:LRA=11:linear=true"
        elif audio_enhance:
            filter_chain = f"adeclip,{hq_resample}"
        else:
            filter_chain = f"loudnorm=I={target_lufs}:TP=-1:LRA=11:linear=true"
        ext = out_path.suffix.lower().lstrip(".")
        if ext == "m4a":
            codec_args = ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"]
        elif ext == "mp3":
            codec_args = ["-c:a", "libmp3lame", "-qscale:a", "2"]
        elif ext in ("flac",):
            src_bits = _probe_bits(out_path)
            bits = 16 if src_bits is None else min(24, max(16, int(src_bits)))
            codec_args = ["-sample_fmt", f"s{bits}", "-c:a", "flac",
                          "-compression_level", "5"]
        elif ext in ("ogg", "opus"):
            codec_args = ["-c:a", "libvorbis", "-qscale:a", "3"]
        else:
            codec_args = ["-c:a", "aac", "-b:a", "256k"]
        map_args = ["-map", "0:a:0", "-map_metadata", "0"]
        if ext in ("mp3", "m4a", "flac", "ogg", "opus"):
            map_args += ["-map", "0:v?", "-c:v", "copy"]
        _set_progress(download_id, percent=95, status="enhancing")
        tmp_out = str(out_path) + ".enh.tmp." + ext
        try:
            proc = subprocess.run(
                [ff, "-y", "-i", str(out_path)] + map_args + ["-filter:a", filter_chain] + codec_args + [tmp_out],
                capture_output=True, timeout=300
            )
            if proc.returncode == 0 and Path(tmp_out).exists() and Path(tmp_out).stat().st_size > 1024:
                try:
                    sz_in = out_path.stat().st_size
                    sz_out = Path(tmp_out).stat().st_size
                    d_in = _probe_duration(out_path)
                    d_out = _probe_duration(Path(tmp_out))
                    pin = _probe_audio(out_path)
                    pout = _probe_audio(Path(tmp_out))
                    k_in, k_out = pin.get("kbps"), pout.get("kbps")
                    if d_in is None:
                        log.warning("enhance rollback: probe input duration None — keep original %s", out_path)
                        return False
                    if d_out is None:
                        log.warning("enhance rollback: probe output duration None — keep original")
                        return False
                    if d_in > 60 and not _duration_ok(d_out, d_in):
                        log.warning("enhance rollback: output %.0fs < input %.0fs — keep original", d_out, d_in)
                        return False
                    if sz_out < max(2048, int(sz_in * 0.08)):
                        log.warning("enhance rollback: size out=%s in=%s — keep original", sz_out, sz_in)
                        return False
                    if k_in and k_out and k_out < 32 and k_in >= 64:
                        log.warning("enhance rollback: kbps out=%s in=%s — keep original", k_out, k_in)
                        return False
                except Exception as e:
                    log.warning("enhance safety check failed (%s) — keep original", e)
                    return False
                bak = Path(str(out_path) + ".bak")
                try:
                    shutil.copy2(out_path, bak)
                except Exception as e:
                    log.warning("enhance backup failed (%s) — keep original", e)
                    return False
                try:
                    os.replace(str(tmp_out), str(out_path))
                except Exception:
                    try:
                        if out_path.exists():
                            out_path.unlink()
                        Path(tmp_out).rename(out_path)
                    except Exception as e:
                        log.warning("enhance replace failed (%s) — restore backup", e)
                        try:
                            if bak.exists():
                                shutil.copy2(bak, out_path)
                        except Exception:
                            pass
                        return False
                try:
                    v_dur = _probe_duration(out_path)
                    if v_dur is None:
                        raise ValueError("duration None after replace")
                    if d_in and d_in > 60 and not _duration_ok(v_dur, d_in):
                        raise ValueError(f"duration {v_dur} vs input {d_in}")
                except Exception as e:
                    log.warning("enhance post-replace verify failed (%s) — restore backup", e)
                    try:
                        if bak.exists():
                            shutil.copy2(bak, out_path)
                    except Exception:
                        pass
                    return False
                try:
                    bak.unlink()
                except Exception:
                    pass
                _set_progress(download_id, percent=100)
                return True
            return False
        finally:
            try:
                if Path(tmp_out).exists():
                    Path(tmp_out).unlink()
            except Exception:
                pass
    except Exception as e:
        log.warning("enhance failed: %s", e)
        return False
    return False


@router.post("/download")
async def download(payload: dict):

    track = payload.get("track") or {}
    options = payload.get("options") or {}
    download_id = hashlib.md5(f"{track.get('title','')}{track.get('artist','')}{time.time()}".encode()).hexdigest()[:12]
    download_progress[download_id] = {"percent": 0, "status": "starting", "title": track.get("title","Unknown")}
    folder = options.get("downloadFolder") or payload.get("downloadFolder") or ""
    if not folder or not Path(folder).exists():
        folder = str(Path.home() / "Downloads" / "VocaLyx")
        Path(folder).mkdir(parents=True, exist_ok=True)
    fmt = options.get("format", "m4a")
    ext = "m4a" if fmt=="m4a" else "mp3"
    safe = re.sub(r'[\\/:*?"<>|\[\]]', "_", f"{track.get('artist','Unknown')} - {track.get('title','Unknown')}")
    out_path = Path(folder) / f"{safe}.{ext}"
    def do_download():
        nonlocal out_path
        AUDIO_JOB_LOCK.acquire()
        try:
            download_progress[download_id]["status"] = "downloading"
            try:
                if out_path.exists() and out_path.stat().st_size > 1024:
                    probed0 = _probe_audio(out_path)
                    if probed0.get("duration"):
                        notice0 = _cache_hit_notice(track, out_path)
                        download_progress[download_id] = {"percent": 100, "status": "done",
                                                          "path": str(out_path),
                                                          "downloadedFrom": "cache-hit",
                                                          "audioNotice": notice0}
                        return
            except Exception:
                pass
            track_source = (track.get("source") or "").lower()
            options["track_source"] = track_source
            if track_source == "spotify":
                strict_sp = _is_strict("spotify", options)
                if not strict_sp:
                    log.info("[spotify] sumber-asli OFF -> langsung fallback YouTube")
                else:
                    prem = _spotify_try_premium(track, out_path, options, download_id)
                    if prem.get("success"):
                        _finalize_download(download_id, Path(prem["filePath"]), "spotify-premium", prem.get("sourceKbps") or 320, "premium", False, track, options)
                        return
                    if prem.get("need_creds") or prem.get("failed"):
                        msg = prem.get("error") or "Spotify Premium gagal"
                        download_progress[download_id] = {"percent": 0, "status": "failed", "downloadedFrom": "spotify-premium", "error": msg}
                        return
            if track_source == "deezer":
                strict_dz = _is_strict("deezer", options)
                if not strict_dz:
                    log.info("[deezer] sumber-asli OFF -> langsung fallback YouTube")
                else:
                    dz = _deezer_try_full(track, out_path, options, download_id)
                    if dz.get("success"):
                        _finalize_download(download_id, Path(dz["filePath"]), "deezer-direct", dz.get("sourceKbps") or 192, "deezer", dz.get("passthrough", False), track, options)
                        return
                    msg = dz.get("error") or "Deezer gagal"
                    download_progress[download_id] = {"percent": 0, "status": "failed", "downloadedFrom": "deezer-direct", "error": msg}
                    return
            audio_source = options.get("audioSource", "youtube")
            if audio_source=="spotify" and track.get("source") in ("spotify",):
                pass
            sc_cookies = _valid_cookies(options.get("scCookies") or payload.get("scCookies") or "")
            is_sc_track = (track.get("source") or "").lower() == "soundcloud"
            strict_sc = _is_strict("soundcloud", options) or (audio_source == "soundcloud")
            strict_sc = strict_sc and (is_sc_track or audio_source == "soundcloud")
            strict_here = _is_strict(track_source, options)
            sc_routed_url, sc_routed_via = None, None
            if audio_source == "soundcloud" and not is_sc_track:
                sc_routed_url = _scsearch_url(track.get("artist") or "", track.get("title") or "",
                                              cookies=sc_cookies)
                if sc_routed_url:
                    sc_routed_via = "soundcloud-search"
                elif strict_sc:
                    download_progress[download_id] = {"percent": 0, "status": "failed",
                        "downloadedFrom": "soundcloud-missing",
                        "error": "Tidak ditemukan padanannya di SoundCloud (mode strict: tanpa fallback YouTube)"}
                    return
            download_progress[download_id]["percent"] = max(download_progress[download_id].get("percent", 0), 5)
            fs_stream = None
            if track_source == "4shared" and not sc_routed_url and strict_here:
                fs_stream = _resolve_4shared(track.get("trackId") or "")
                if fs_stream.get("previewUrl"):
                    url, via = fs_stream["previewUrl"], "4shared-direct"
                elif strict_here:
                    download_progress[download_id] = {"percent": 0, "status": "failed",
                        "downloadedFrom": "4shared-resolve-failed",
                        "error": f"4shared: {fs_stream.get('error') or 'resolve gagal'} (switch sumber-asli ON: tanpa fallback YouTube)."}
                    return
            prefer_direct = bool(strict_here) or (bool(strict_sc) and is_sc_track)
            if sc_routed_url:
                url, via = sc_routed_url, sc_routed_via
            elif track_source == "4shared" and fs_stream and fs_stream.get("previewUrl"):
                pass
            else:
                url, via = _resolve_download_url(track, cookies=sc_cookies, prefer_direct=prefer_direct)
                if strict_sc and via == "youtube" and is_sc_track:
                    download_progress[download_id] = {"percent": 0, "status": "failed",
                        "downloadedFrom": "youtube-skipped",
                        "error": "SoundCloud hanya menyediakan preview (switch sumber-asli ON: tanpa fallback YouTube). Matikan switch-nya untuk via YouTube."}
                    return
                if via == "youtube" and not sc_routed_url and strict_here \
                        and track_source in ("spotify", "deezer"):
                    download_progress[download_id] = {"percent": 0, "status": "failed",
                        "downloadedFrom": "youtube-skipped",
                        "error": f"Tidak ada sumber asli untuk {track_source} (switch sumber-asli ON: tanpa fallback YouTube). Matikan switch-nya untuk via YouTube."}
                    return
            download_progress[download_id]["downloadedFrom"] = via
            download_progress[download_id]["percent"] = max(download_progress[download_id].get("percent", 0), 8)
            log.info("download [%s]: %s - %s", via, track.get('artist',''), track.get('title',''))
            if via == "4shared-direct":
                try:
                    download_progress[download_id]["percent"] = 8
                    data, err = _fetch_4shared_bytes(url)
                    if data:
                        download_progress[download_id]["percent"] = 62
                        tmp = out_path.with_suffix(".tmp DL")
                        tmp.write_bytes(data)
                        download_progress[download_id]["percent"] = 68
                        src_probe = _probe_audio(tmp)
                        src_kbps = src_probe.get("kbps")
                        try:
                            probe_ext = ""
                            if data[:3] == b"ID3" or data[0:2] == b"\xff\xfb" or data[0:2] == b"\xff\xf3":
                                probe_ext = ".mp3"
                            elif data[4:12] == b"ftypM4A " or data[4:12] == b"ftypmp42":
                                probe_ext = ".m4a"
                        except Exception:
                            probe_ext = ""
                        passthrough = bool(probe_ext and probe_ext == f".{ext}")
                        if not passthrough:
                            ff = ffmpeg_bin()
                            tgt = min(src_kbps, 320) if src_kbps else 320
                            if ff:
                                download_progress[download_id]["percent"] = 72
                                conv = out_path.with_suffix(f".tmp.{ext}")
                                subprocess.run([ff, "-y", "-vn", "-i", str(tmp), "-c:a", "aac" if ext == "m4a" else "libmp3lame", "-b:a", f"{tgt}k", str(conv)], capture_output=True)
                                if conv.exists():
                                    tmp.unlink(missing_ok=True)
                                    tmp = conv
                        if tmp != out_path:
                            if out_path.exists():
                                out_path.unlink()
                            tmp.rename(out_path)
                        download_progress[download_id]["percent"] = 82
                        eff_track = dict(track)
                        big = (fs_stream or {}).get("coverUrl") or ""
                        if big:
                            eff_track["coverUrl"] = big
                        _finalize_download(download_id, out_path, via, src_kbps, "4shared", passthrough, eff_track, options)
                        return
                    log.info("4shared direct gagal (%s), lanjut fallback", err or 'unknown')
                except Exception as e:
                    log.warning("4shared download failed: %s", e)
                    err = str(e)
                    log.info("4shared direct gagal (%s), lanjut fallback", err or 'unknown')
            if via == "archive-direct":
                try:
                    r = requests.get(url, timeout=60, stream=True)
                    if r.ok:
                        tmp = out_path.with_suffix(".tmp DL")
                        total = int(r.headers.get("content-length") or 0)
                        got = 0
                        download_progress[download_id]["percent"] = 10
                        with open(tmp, "wb") as f:
                            for chunk in r.iter_content(chunk_size=65536):
                                if not chunk:
                                    continue
                                f.write(chunk)
                                got += len(chunk)
                                if total > 0:
                                    pct = 10 + int((got / total) * 60)
                                    download_progress[download_id]["percent"] = min(70, pct)
                                elif got % (512 * 1024) < 65536:
                                    cur = download_progress[download_id].get("percent", 10)
                                    download_progress[download_id]["percent"] = min(70, cur + 2)
                        download_progress[download_id]["percent"] = 72
                        src_probe = _probe_audio(tmp)
                        src_kbps = src_probe.get("kbps")
                        passthrough = str(url).lower().split("?")[0].endswith(f".{ext}")
                        if not passthrough:
                            ff = ffmpeg_bin()
                            tgt = min(src_kbps, 320) if src_kbps else 320
                            if ff:
                                download_progress[download_id]["percent"] = 78
                                conv = out_path.with_suffix(f".tmp.{ext}")
                                subprocess.run([ff, "-y", "-vn", "-i", str(tmp), "-c:a", "aac" if ext == "m4a" else "libmp3lame", "-b:a", f"{tgt}k", str(conv)], capture_output=True)
                                if conv.exists():
                                    tmp.unlink(missing_ok=True)
                                    tmp = conv
                        if tmp != out_path:
                            if out_path.exists():
                                out_path.unlink()
                            tmp.rename(out_path)
                        download_progress[download_id]["percent"] = 85
                        _finalize_download(download_id, out_path, via, src_kbps, "archive", passthrough, track, options)
                        return
                except Exception as e:
                    log.warning("Archive download failed: %s", e)
            if via in ("archive-direct", "4shared-direct") and strict_here:
                download_progress[download_id] = {"percent": 0, "status": "failed",
                    "downloadedFrom": via.replace("direct", "failed"),
                    "error": f"Download langsung {track_source} gagal (switch sumber-asli ON: tanpa fallback YouTube)."}
                return
            if url.startswith("ytsearch1:"):
                queries = [url, _ytsearch_url(track.get("artist") or "", track.get("title") or "", suffix="")]
            elif "youtube.com" in str(url).lower():
                queries = [url] + _youtube_queue(track.get("artist") or "", track.get("title") or "")
            else:
                queries = [url]
            queries = list(dict.fromkeys(queries))
            cap = None
            yt_tried = False
            last_yt_err = ""
            try:
                yt_dlp = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
                if yt_dlp:
                    yt_tried = True
                    ff_loc = ffmpeg_loc_for_ytdlp()
                    is_sc = via.startswith("soundcloud")
                    thumb_args = ["--embed-thumbnail", "--convert-thumbnails", "jpg"] if is_sc else []
                    sc_cookie_args = ["--cookies", sc_cookies] if (is_sc and sc_cookies) else []
                    yt_cookie_args = _yt_cookie_args(options)
                    yt_cookie_used = bool(yt_cookie_args)
                    artist_q, title_q = track.get("artist") or "", track.get("title") or ""
                    try:
                        expected_dur = int(float(track.get("duration"))) if track.get("duration") else None
                    except Exception:
                        expected_dur = None
                    pending = list(queries)
                    tried_sc = {url} if via.startswith("soundcloud") and url.startswith("http") else set()
                    attempt = 0
                    while pending:
                        q = pending.pop(0)
                        attempt += 1
                        if attempt > 1:
                            via = _via_for_query(q, artist_q, title_q)
                            if via == "soundcloud-alt":
                                tried_sc.add(q)
                            download_progress[download_id]["downloadedFrom"] = via
                        cap = encode_cap_for(_via_source(via, track))
                        src_ceiling = 128 if via.startswith("soundcloud") else cap
                        if ext == "m4a":
                            pp_args = ["--postprocessor-args", f"ffmpeg:-c:a aac -b:a {cap}k -movflags +faststart"]
                        else:
                            pp_args = ["--postprocessor-args", f"ffmpeg:-b:a {cap}k"]
                        cmd = [yt_dlp, "-x", "--audio-format", ext, "--audio-quality", f"{cap}K"]
                        cmd += pp_args
                        if ff_loc:
                            cmd += ["--ffmpeg-location", ff_loc]
                        cmd += thumb_args
                        if _is_yt_query(q):
                            cmd += yt_cookie_args
                        else:
                            cmd += sc_cookie_args
                        cmd += ["--newline", "--progress", "--progress-template", "download PROG:%(progress._percent_str)s",
                                "--output", str(out_path.with_suffix("")) + ".%(ext)s", "--no-playlist", "--no-warnings", q]
                        cmd = [c for c in cmd if c]
                        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                        if download_progress[download_id].get("percent", 0) < 5:
                            download_progress[download_id]["percent"] = 5
                        yt_rc = None
                        yt_tail = []
                        for line in proc.stdout or []:
                            m = re.search(r"PROG:\s*([0-9.]+)%", line) or re.search(r"\[download\]\s+([0-9.]+)%", line)
                            if m:
                                pct = float(m.group(1))
                                cur = download_progress[download_id].get("percent", 0)
                                download_progress[download_id]["percent"] = max(cur, int(pct * 0.85))
                            else:
                                s = (line or "").strip()
                                if s:
                                    yt_tail.append(s)
                                    if len(yt_tail) > 24:
                                        yt_tail.pop(0)
                        try:
                            yt_rc = proc.wait(timeout=420)
                        except subprocess.TimeoutExpired:
                            try:
                                proc.kill()
                            except Exception:
                                pass
                            yt_rc = -1
                            last_yt_err = "yt-dlp timeout 420s"
                        if download_progress[download_id].get("percent", 0) < 70:
                            download_progress[download_id]["percent"] = 70
                        if yt_rc != 0:
                            tail_txt = " | ".join(yt_tail)[-400:]
                            if yt_rc == -1 and "timeout" in (last_yt_err or ""):
                                pass
                            else:
                                last_yt_err = f"yt-dlp exit {yt_rc}" + (f": {tail_txt}" if tail_txt else "")
                            log.warning("%s (query=%s)", last_yt_err, str(q)[:120])
                            stem_files = _list_stem_files(folder, safe)
                            valid_out = None
                            for p in stem_files:
                                if p.suffix.lower() == f".{ext}" and p.stat().st_size > 1024:
                                    pd = _probe_duration(p)
                                    if pd and pd > 5:
                                        valid_out = p
                                        break
                            if valid_out is None:
                                for p in stem_files:
                                    if _is_partial_artifact(p):
                                        try:
                                            p.unlink()
                                        except Exception:
                                            pass
                            else:
                                log.warning("yt-dlp exit %s tapi file valid ada (%s) — lanjut finalize", yt_rc, valid_out.name)
                            if valid_out is None:
                                if _is_yt_query(q) and _bot_hit(yt_tail) and not yt_cookie_used:
                                    yt_cookie_used = True
                                    if not yt_cookie_args:
                                        yt_cookie_args = _yt_cookie_args({**options, "ytCookies": "auto"})
                                    if yt_cookie_args:
                                        log.info("yt-dlp bot-check, retry dengan cookies: %s", yt_cookie_args)
                                        pending.insert(0, q)
                                        continue
                                if pending:
                                    continue
                                download_progress[download_id] = {"percent": 0, "status": "failed",
                                    "downloadedFrom": via, "error": f"Download gagal ({last_yt_err})"}
                                return
                            if valid_out != out_path:
                                try:
                                    if out_path.exists():
                                        out_path.unlink()
                                    valid_out.rename(out_path)
                                except Exception:
                                    out_path = valid_out
                        stem_files = _list_stem_files(folder, safe)
                        found = next((c for c in stem_files if c.suffix.lower() == f".{ext}"), None)
                        if found is None and out_path.exists() and out_path.stat().st_size > 1024:
                            found = out_path
                        if found is not None:
                            if found != out_path and found.exists():
                                try:
                                    if out_path.exists():
                                        out_path.unlink()
                                    found.rename(out_path)
                                except Exception as e:
                                    log.warning("rename hasil download gagal: %s", e)
                                    out_path = found
                            actual = _probe_duration(out_path)
                            is_short = bool(
                                actual and expected_dur and expected_dur > 60
                                and (actual <= 45 or actual < expected_dur * 0.5)
                            )
                            if actual is None and expected_dur and expected_dur > 60:
                                log.warning("duration trap skipped (probe None) path=%s expected=%s", out_path, expected_dur)
                            if is_short:
                                log.info("duration trap (%.0fs vs ekspektasi %ss, via=%s)", actual, expected_dur, via)
                                try:
                                    out_path.unlink()
                                except Exception:
                                    pass
                                if via.startswith("soundcloud"):
                                    alts = [u for u in _sc_alt_urls(artist_q, title_q, skip=tried_sc, cookies=sc_cookies) if u not in tried_sc]
                                    if alts:
                                        log.info("coba %d upload SC alternatif", len(alts))
                                        pending.extend(alts)
                                        continue
                                    if strict_sc:
                                        download_progress[download_id] = {"percent": 0, "status": "failed",
                                            "downloadedFrom": "soundcloud-preview",
                                            "error": f"SoundCloud hanya menyediakan preview {actual:.0f} dtk (switch sumber-asli ON: tanpa fallback YouTube). Matikan switch-nya untuk via YouTube."}
                                        return
                                if pending:
                                    continue
                                download_progress[download_id] = {"percent": 0, "status": "failed",
                                    "downloadedFrom": via,
                                    "error": f"File hasil terlalu pendek ({actual:.0f} dtk, ekspektasi ~{expected_dur} dtk) — tidak disimpan"}
                                return
                            if not _finalize_download(download_id, out_path, via, src_ceiling, _via_source(via, track), False, track, options):
                                return
                            return
                        last_yt_err = last_yt_err or "yt-dlp tidak menghasilkan file"
                        if pending:
                            continue
                        break
            except Exception as e:
                log.warning("yt-dlp failed: %s", e)
                last_yt_err = str(e)[:300]
            if yt_tried:
                download_progress[download_id] = {"percent": 0, "status": "failed",
                    "downloadedFrom": via,
                    "error": last_yt_err or f"Download {track_source or 'track'} gagal"}
                return
            if strict_sc or (strict_here and track_source in ("spotify", "deezer", "4shared", "archive")):
                download_progress[download_id] = {"percent": 0, "status": "failed",
                    "downloadedFrom": via,
                    "error": f"Download {track_source or 'track'} gagal (switch sumber-asli ON: tanpa fallback YouTube)"}
                return
            out_path.write_text(f"Dummy download for {track.get('title')} - format {ext}", encoding="utf-8")
            download_progress[download_id] = {"percent": 100, "status": "done", "path": str(out_path),
                                              "downloadedFrom": via,
                                              "audioNotice": _make_notice(None, None, _via_source(via, track), False)}
        except Exception as e:
            download_progress[download_id] = {"percent": 0, "status": "failed", "error": str(e)}
        finally:
            AUDIO_JOB_LOCK.release()

    threading.Thread(target=do_download, daemon=True).start()
    return {"downloadId": download_id, "status": "started"}

@router.get("/download/progress")
async def download_progress_get(downloadId: str = ""):
    if downloadId and downloadId in download_progress:
        return download_progress[downloadId]
    return download_progress


@router.post("/deezer/arl")
async def deezer_arl(payload: dict):
    """Test ARL Deezer (request-scoped, tidak dipersist server)."""

    arl = str(payload.get("arl") or payload.get("deezerArl") or "").strip()[:512]
    if not arl:
        return JSONResponse({"ok": False, "error": "ARL_KOSONG"}, status_code=401)
    be = _premium_backend("deezer", "deezer_arl_test.py")
    if not be:
        return JSONResponse({"ok": False, "error": "Backend Deezer tidak ada (paket premium tidak terbundel)"}, status_code=500)
    env = {**os.environ, **be[2]}
    env["DEEZER_ARL"] = arl
    try:
        proc = subprocess.run([be[0], be[1]], capture_output=True, text=True, timeout=60, env=env)
        for line in (proc.stdout or "").splitlines():
            line=line.strip()
            if not line:
                continue
            try:
                j=json.loads(line)
                if isinstance(j, dict) and "ok" in j:
                    if j.get("ok"):
                        return {"ok": True, "data": j}
                    return JSONResponse({"ok": False, "error": j.get("error") or "ARL_INVALID"}, status_code=401)
            except Exception:
                continue
        return JSONResponse({"ok": False, "error": (proc.stderr or proc.stdout or "ARL test gagal")[:300]}, status_code=401)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:300]}, status_code=500)


_PREMIUM_RAW_HINTS = (  # pola output mentah child premium yang TIDAK pernah jadi JSON, dipetakan ke aksi yang bisa dilakukan user; tanpa ini `connect-status` hanya melihat baris non-JSON, deempatkan `waiting: True`, dan UI baru memberi tahu "timeout 120 detik" padahal prosesnya sudah mati di detik pertama karena sebab yang jauh lebih jelas
    ("no python at",
     "Interpreter venv Spotify Premium rusak - Python yang membuat venv sudah "
     "tidak ada di mesin ini. Rebuild paket premium: python scripts/stage_premium.py"),
    ("no module named",
     "Backend Spotify Premium tidak lengkap di paket staged. Rebuild: "
     "python scripts/stage_premium.py"),
    ("bad magic number",
     "Versi Python engine tidak cocok dengan paket premium. Rebuild runtime: "
     "python scripts/build_runtime.py --repack"),
    ("the system cannot find",
     "File backend Spotify Premium tidak ditemukan. Rebuild paket premium: "
     "python scripts/stage_premium.py"),
)


def _premium_error_text(raw: str) -> str:
    """Terjemahkan output mentah child premium jadi pesan yang bisa ditindaklanjuti."""
    low = raw.lower()
    for key, msg in _PREMIUM_RAW_HINTS:
        if key in low:
            return msg
    return raw[:300]


@router.post("/spotify/validate")
async def spotify_validate(payload: dict):

    cid = (payload.get("clientId") or payload.get("id") or "").strip()
    sec = (payload.get("clientSecret") or payload.get("secret") or "").strip()
    if not cid or not sec:
        return {"valid": False, "error": "Missing ID/Secret"}
    try:
        auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        r = requests.post("https://accounts.spotify.com/api/token", headers={"Authorization": f"Basic {auth}"}, data={"grant_type": "client_credentials"}, timeout=10)
        if r.ok and r.json().get("access_token"):
            return {"valid": True}
        return {"valid": False, "error": r.text[:200]}
    except Exception as e:
        return {"valid": False, "error": str(e)}

@router.post("/spotify/premium")
async def spotify_premium(payload: dict):
    action = payload.get("action", "")
    cred_path = Path.cwd() / ".spotify-premium" / "credentials.json"
    device_path = Path.cwd() / ".spotify-premium" / "device_id.txt"
    if action == "status":
        return {"connected": cred_path.exists() and cred_path.stat().st_size > 16, "deviceName": f"VocaLyx-{device_path.read_text().strip()[-4:] if device_path.exists() else 'XXXX'}"}
    if action == "disconnect":
        for p in list(_PREMIUM_PROCS):  # hentikan sisa child Connect (librespot) supaya tidak jalan tanpa sesi
            try:
                if p.poll() is None:
                    p.terminate()
            except Exception:
                pass
        _PREMIUM_PROCS[:] = [p for p in _PREMIUM_PROCS if p.poll() is None]
        for f in (cred_path, device_path, cred_path.parent / "connect-last.log"):  # creds + sisa sesi basi (device/log lama membingungkan connect-status berikutnya)
            try:
                if f.exists():
                    f.unlink()
            except Exception:
                pass
        return {"ok": True}
    if action == "test":
        if not (cred_path.exists() and cred_path.stat().st_size > 16):
            return {"ok": False, "error": "Belum ada sesi tersimpan — klik Connect lalu pilih device VocaLyx-XXXX di aplikasi Spotify (login tanpa password)"}
        try:
            be = _premium_backend("spotify", "spotify_premium_download.py")
            if not be:
                return {"ok": False, "error": _premium_missing_error(
                    "spotify", "Backend Spotify Premium tidak ada")}
            venv_py, script, prem_env = be
            cmd = [str(venv_py), str(script), "--test-login", "--stored-creds", str(cred_path)]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45,
                                  env={**os.environ, **prem_env})
            log.debug("premium verify stdout: %s stderr: %s", proc.stdout[:500], proc.stderr[:500])
            if proc.returncode == 0:
                username = ""
                for line in reversed((proc.stdout or "").strip().splitlines()):
                    try:
                        j = json.loads(line)
                        if isinstance(j, dict) and j.get("ok"):
                            username = str(j.get("username") or "")
                            break
                    except Exception:
                        continue
                return {"ok": True, "via": "stored-validated", "username": username}
            err = ""
            for line in reversed((proc.stdout or "").strip().splitlines()):
                try:
                    j = json.loads(line)
                    if isinstance(j, dict) and j.get("error"):
                        err = str(j["error"])
                        break
                except Exception:
                    continue
            if not err:
                err = (proc.stderr or proc.stdout or "").strip()
            low_err = err.lower()
            if any(k in low_err for k in ("kedaluwarsa", "ditolak", "bad credentials", "badcredentials", "unauthorized")):
                err = "Sesi tersimpan kedaluwarsa/ditolak — klik Connect ulang untuk memperbarui (tanpa password)."
            return {"ok": False, "error": err[:500] or "Verifikasi gagal — klik Connect ulang"}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Verifikasi timeout (jaringan lambat) — coba lagi"}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "connect-start":
        try:
            be = _premium_backend("spotify", "spotify_premium_auth.py")
            if not be:
                return {"ok": False, "error": _premium_missing_error(
                    "spotify", "Backend Spotify Connect tidak ada")}
            venv_py, script, prem_env = be

            sid = str(uuid.uuid4())[:8]
            out_path = cred_path
            out_path.parent.mkdir(parents=True, exist_ok=True)
            device_name = f"VocaLyx-{sid.upper()}"
            try:
                device_path.parent.mkdir(parents=True, exist_ok=True)
                device_path.write_text(device_name, encoding="utf-8")
            except Exception:
                pass
            log_f = None
            log_path = cred_path.parent / "connect-last.log"
            try:
                log_f = open(str(log_path), "w", encoding="utf-8")
            except Exception:
                log_f = None
            proc = subprocess.Popen(
                [str(venv_py), str(script), "--out", str(out_path), "--timeout", "120", "--device-name", device_name],
                stdout=log_f if log_f else subprocess.DEVNULL,
                stderr=subprocess.STDOUT if log_f else subprocess.DEVNULL,
                env={**os.environ, **prem_env},
            )
            if log_f:
                try:
                    log_f.close()  # child memegang dup-nya sendiri
                except Exception:
                    pass
            _PREMIUM_PROCS.append(proc)  # catat supaya disconnect bisa terminate; entri mati dibersihkan di sana
            await asyncio.sleep(1.2)  # child yang langsung mati (venv rusak, import gagal, PYTHONPATH keliru) terlihat sebagai `returncode` dalam hitungan milidetik; tanpa jeda ini UI menganggap Connect berjalan lalu menunggu 120 detik dan menampilkan "timeout", padahal prosesnya sudah selesai di detik pertama. `await`, bukan `time.sleep`, supaya loop event engine tetap melayani request lain selama jeda.
            rc = proc.poll()
            if rc is not None:
                detail = ""
                try:
                    if log_path.is_file():
                        txt = log_path.read_text(encoding="utf-8",
                                                 errors="replace").strip()
                        detail = txt.splitlines()[-1][:240] if txt else ""
                except Exception:
                    pass
                log.error("connect-start: child berhenti langsung rc=%s: %s", rc, detail)
                return {"ok": False,
                        "error": _premium_error_text(
                            detail or "Proses Spotify Connect berhenti (exit %s)" % rc)}
            return {"sessionId": sid, "deviceName": device_name}
        except Exception as e:
            log.error("connect-start failed: %s", e)
            return {"ok": False, "error": f"Gagal memulai Spotify Connect: {str(e)[:200]}"}
    if action == "connect-status":
        if cred_path.exists() and cred_path.stat().st_size > 16:
            did = device_path.read_text().strip()[-4:] if device_path.exists() else "XXXX"
            return {"connected": True, "deviceName": f"VocaLyx-{did}"}
        try:  # kegagalan auth (Zeroconf/firewall/timeout/import) ada di log: tampilkan, jangan waiting buta
            logp = cred_path.parent / "connect-last.log"
            if logp.exists():
                plain = ""
                for line in reversed(logp.read_text(encoding="utf-8", errors="replace").splitlines()):
                    line = line.strip()
                    if not line:
                        continue
                    if not line.startswith("{"):  # launcher venv yang rusak, galat runtime, atau traceback tidak pernah jadi JSON; simpan baris pertamanya supaya penyebabnya bisa dilaporkan, bukan dibiarkan jadi "menunggu" sampai UI ke timeout 120 detik
                        if not plain:
                            plain = line
                        continue
                    try:
                        j = json.loads(line)
                    except Exception:
                        continue
                    if isinstance(j, dict) and "ok" in j:
                        if j.get("ok") is False and j.get("error"):
                            return {"connected": False, "error": str(j["error"])[:500]}
                        plain = ""
                        break
                if plain:
                    return {"connected": False, "error": _premium_error_text(plain)}
        except Exception:
            pass
        return {"connected": False, "waiting": True}
    return {"ok": False, "error": "Unknown action"}
