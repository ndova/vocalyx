"""VocaLyx engine - audio preview resolve plus relay stream."""
import json
import re
import shutil
import subprocess
from urllib.parse import urlparse

import requests
import urllib3
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from vx_core import log, yt_dlp_cmd
from vx_search import _FS_HEADERS, _fs_is_host, _resolve_4shared

router = APIRouter()



def _sc_preview_url(page_url: str, cookies: str = "", timeout: int = 25):
    """Ambil SATU stream URL SoundCloud yg playable utk preview on-demand.
    Progressive (http) diutamakan agar tag <audio> bisa langsung putar; HLS terakhir.
    Return (url, proto) atau None. URL kedaluwarsa -> resolve ulang tiap klik."""

    try:
        yt_dlp = yt_dlp_cmd()
        if not yt_dlp or not page_url:
            return None
        cmd = yt_dlp + ["--no-warnings", "--skip-download", "-J", page_url]
        if cookies:
            cmd += ["--cookies", cookies]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            return None
        data = json.loads(proc.stdout or "{}")
        fmts = data.get("formats") or []
        if isinstance(fmts, dict):
            fmts = [fmts]
        prog, hls = None, None
        for f in fmts:
            if not isinstance(f, dict):
                continue
            url = f.get("url") or ""
            if not url:
                continue
            if (f.get("acodec") or "none") == "none":
                continue
            fid = str(f.get("format_id") or "").lower()
            if "preview" in fid:
                continue
            proto = str(f.get("protocol") or "").lower()
            is_hls = "m3u8" in url or "hls" in proto or "hls" in fid or "dash" in proto
            if is_hls:
                if hls is None:
                    hls = url
            elif prog is None:
                prog = url
        if prog:
            return (prog, "http")
        if hls:
            return (hls, "hls")
    except Exception as e:
        log.warning("sc preview failed: %s", e)
    return None


def _itunes_preview(title: str, artist: str, timeout: int = 12):
    """Preview iTunes utk lagu Spotify (Spotify sudah tak sediakan preview_url).
    Return {url, artwork} atau None."""


    try:
        q = f"{(artist or '').strip()} {(title or '').strip()}".strip()[:160]
        if not q:
            return None
        r = requests.get("https://itunes.apple.com/search",
                         params={"term": q, "media": "music", "entity": "song", "limit": 10},
                         timeout=timeout)
        if not r.ok:
            return None
        items = r.json().get("results") or []

        def norm(s):
            s = (s or "").lower()
            s = re.sub(r"\(.*?\)|\[.*?]", "", s)
            return re.sub(r"[^a-z0-9 ]", "", s).strip()

        nt, na = norm(title), norm(artist)
        best, best_score = None, -1
        for j in items:
            if not isinstance(j, dict) or not j.get("previewUrl"):
                continue
            jt, ja = norm(j.get("trackName")), norm(j.get("artistName"))
            score = 0
            if jt and nt and jt == nt:
                score += 3
            elif jt and nt and (nt in jt or jt in nt):
                score += 1
            if na and ja and (na == ja or na in ja or ja in na):
                score += 2
            if score > best_score:
                best, best_score = j, score
        if not best or best_score < 2:
            return None
        art = str(best.get("artworkUrl100") or "")
        return {"url": best["previewUrl"],
                "artwork": art.replace("100x100", "500x500") if art else ""}
    except Exception as e:
        log.warning("itunes preview failed: %s", e)
    return None


@router.get("/preview")
async def preview(source: str = "", trackId: str = "", title: str = "", artist: str = ""):
    """Resolve URL preview on-demand utk tombol play hasil online.
    - soundcloud: stream via yt-dlp (progressive dulu, HLS terakhir)
    - 4shared: stream preview via resolve halaman (sdh ada)
    - spotify: preview iTunes (cross-source, Spotify tak sediakan preview_url)
    URL stream kedaluwarsa -> frontend panggil endpoint ini tiap klik."""
    src = (source or "").strip().lower()
    try:
        if src == "soundcloud":
            got = _sc_preview_url(trackId or "")
            if got:
                return {"ok": True, "url": got[0], "protocol": got[1], "source": "soundcloud"}
            return {"ok": False, "error": "nopreview"}
        if src == "4shared":
            fs = _resolve_4shared(trackId or "")
            if fs.get("previewUrl"):
                return {"ok": True, "url": fs["previewUrl"], "source": "4shared",
                        "relay": True}
            return {"ok": False, "error": fs.get("error") or "nopreview"}
        if src == "spotify":
            it = _itunes_preview(title, artist)
            if it:
                return {"ok": True, "url": it["url"], "artwork": it.get("artwork") or "",
                        "protocol": "http", "source": "spotify", "via": "itunes"}
            return {"ok": False, "error": "nopreview"}
        return {"ok": False, "error": "unsupported-source"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


@router.get("/preview/stream")
async def preview_stream(url: str = "", request: Request = None):
    """Relay byte-range utk preview 4shared (port music-dl previewRelay).
    Browser tak bisa handshake langsung ke dc* (cert kedaluwarsa) -> engine
    teruskan byte + Range dgn TLS longgar khusus host 4shared, balas dgn CORS *.
    Allowlist generik (_fs_is_host) agar gampang diperluas ke host lain."""


    raw = (url or "").strip()
    if not raw or "\0" in raw:
        return {"ok": False, "error": "bad-url"}
    try:
        parts = urlparse(raw)
    except Exception:
        return {"ok": False, "error": "bad-url"}
    if parts.scheme not in ("http", "https"):
        return {"ok": False, "error": "bad-scheme"}
    if not _fs_is_host(parts.hostname or ""):
        return {"ok": False, "error": "host-not-allowed"}
    headers = {"User-Agent": _FS_HEADERS.get("User-Agent", "Mozilla/5.0")}
    try:
        rng = request.headers.get("range") if request is not None else None
    except Exception:
        rng = None
    if rng:
        headers["Range"] = rng
    try:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except Exception:
        pass
    try:
        up = requests.get(raw, headers=headers, stream=True, timeout=(10, 60),
                          allow_redirects=True, verify=False)
    except Exception as e:
        return {"ok": False, "error": f"relay-fetch: {str(e)[:150]}"}
    if up.status_code not in (200, 206):
        try:
            up.close()
        except Exception:
            pass
        return {"ok": False, "error": f"upstream HTTP {up.status_code}"}
    h = {}
    for k in ("content-type", "content-length", "content-range", "accept-ranges"):
        v = up.headers.get(k)
        if v:
            h[k] = v
    if "content-type" not in h:
        h["content-type"] = "audio/mpeg"
    if "accept-ranges" not in h:
        h["accept-ranges"] = "bytes"
    h["access-control-allow-origin"] = "*"
    h["cache-control"] = "public, max-age=3600"

    def gen():
        sent = 0
        try:
            for chunk in up.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                sent += len(chunk)
                if sent > 64 * 1024 * 1024:
                    break
                yield chunk
        finally:
            try:
                up.close()
            except Exception:
                pass
    return StreamingResponse(gen(), status_code=up.status_code, headers=h)
