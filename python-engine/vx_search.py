"""VocaLyx engine - online search routes (Spotify/SoundCloud/Archive/Deezer/4shared/YouTube)."""
import base64
import json
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

import requests
import urllib3
from fastapi import APIRouter

from vx_core import log

router = APIRouter()

search_cache: dict = {}

def _search_deezer(query: str, n: int):

    out = []
    try:
        r = requests.get("https://api.deezer.com/search", params={"q": query}, timeout=10)
        if r.ok:
            for j in r.json().get("data", [])[:n]:
                did = str(j.get("id") or "").strip()
                out.append({
                    "id": f"deezer-{did}",
                    "title": j.get("title") or query,
                    "artist": (j.get("artist") or {}).get("name") or "Unknown",
                    "album": (j.get("album") or {}).get("title") or "",
                    "coverUrl": (j.get("album") or {}).get("cover_xl")
                        or (j.get("album") or {}).get("cover_big")
                        or (j.get("album") or {}).get("cover_medium") or "",
                    "previewUrl": j.get("preview"),
                    "duration": int(j.get("duration") or 0) or None,
                    "source": "deezer",
                    "trackId": did,
                })
    except Exception as e:
        log.warning("Deezer search failed: %s", e)
    return out


def _search_soundcloud(query: str, n: int, cookies: str = ""):
    """Hanya upload yg dibuka pemiliknya (stream FULL). Preview-only tersaring."""


    out = []
    try:
        yt_dlp = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
        if not yt_dlp:
            return out
        want = min(max(n * 2, 6), 10)
        cmd = [yt_dlp, "--quiet", "--no-warnings", "--flat-playlist", "--dump-json", f"scsearch{want}:{query}"]
        if cookies:
            cmd += ["--cookies", cookies]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if proc.returncode != 0:
            log.warning("scsearch failed: %s", (proc.stderr or '')[-300:])
            return out
        cands = []
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                j = json.loads(line)
            except Exception:
                continue
            sid = str(j.get("id") or "")
            if not sid:
                continue
            dur = j.get("duration")
            try:
                dur = int(float(dur)) if dur else None
            except Exception:
                dur = None
            if dur and dur <= 40:
                continue
            page = j.get("webpage_url") or ""
            if not page or "soundcloud.com" not in str(page).lower():
                continue
            cands.append((j, sid, dur, str(page)))
            if len(cands) >= max(n * 2, 6):
                break
        def _probe(c):
            j, sid, dur, page = c
            try:
                if _sc_full_available(page, cookies, timeout=20):
                    return c
            except Exception:
                pass
            return None
        full = []
        with ThreadPoolExecutor(max_workers=4) as ex:
            for c in ex.map(_probe, cands):
                if c and len(full) < n:
                    full.append(c)
        for (j, sid, dur, page) in full:
            title = str(j.get("title") or query)
            artist = str(j.get("uploader") or j.get("channel") or j.get("uploader_id") or "SoundCloud")
            thumbs = j.get("thumbnails") or []
            cover = ""
            try:
                if isinstance(thumbs, list) and thumbs:
                    urls = [t.get("url") or "" for t in thumbs if isinstance(t, dict)]
                    cover = next((u for u in urls if "t500x500" in u or "original" in u), "") or next((u for u in urls if "large" in u), "") or (urls[-1] if urls else "")
                if not cover:
                    cover = str(j.get("thumbnail") or "")
            except Exception:
                cover = ""
            out.append({
                "id": f"sc-{sid}",
                "title": title,
                "artist": artist,
                "album": "",
                "duration": dur,
                "coverUrl": cover,
                "previewUrl": None,
                "source": "soundcloud",
                "trackId": page,
            })
    except Exception as e:
        log.warning("SoundCloud search failed: %s", e)
    return out


def _search_archive(query: str, n: int):


    out = []
    try:
        q = query.strip().replace('"', "")[:120]
        if not q:
            return out
        lucene = f'(title:({q}) OR creator:({q})) AND mediatype:audio'
        r = requests.get("https://archive.org/advancedsearch.php", params={
            "q": lucene, "fl[]": ["identifier", "title", "creator", "downloads"],
            "rows": min(max(n, 1), 10), "page": 1, "output": "json",
        }, headers={"User-Agent": "Mozilla/5.0 VocaLyx/0.1"}, timeout=12)
        if not r.ok:
            return out
        docs = (r.json().get("response") or {}).get("docs") or []
        for d in docs[:n]:
            ident = d.get("identifier") or ""
            if not ident:
                continue
            title = d.get("title")
            if isinstance(title, list):
                title = title[0] if title else query
            artist = d.get("creator")
            if isinstance(artist, list):
                artist = artist[0] if artist else "Archive.org"
            title, artist = str(title or query), str(artist or "Archive.org")
            preview, dur, cover = None, None, f"https://archive.org/services/img/{ident}"
            try:
                mr = requests.get(f"https://archive.org/metadata/{ident}", timeout=10)
                if mr.ok:
                    files = (mr.json().get("files") or [])
                    best = None
                    for f in files:
                        name = str(f.get("name") or "")
                        if not name or "/" in name:
                            continue
                        if str(f.get("private") or "").lower() == "true":
                            continue
                        low = name.lower()
                        if not any(low.endswith("." + e) for e in ("mp3", "m4a", "ogg", "flac", "opus", "wav", "aac")):
                            continue
                        if "_spectrogram" in low or low.endswith(".png") or low.endswith(".jpg"):
                            continue
                        best = f
                        if low.endswith(".mp3"):
                            break
                    if best:
                        fname = str(best.get("name"))
                        preview = f"https://archive.org/download/{ident}/{fname}"
                        try:
                            length = best.get("length")
                            dur = int(float(str(length))) if length else None
                        except Exception:
                            dur = None
            except Exception as e:
                log.warning("Archive metadata %s failed: %s", ident, e)
            if not preview:
                continue
            clean = re.sub(r"\.[a-z0-9]{2,4}$", "", title, flags=re.I).replace("_", " ").strip() or query
            out.append({
                "id": f"ia-{ident}",
                "title": clean,
                "artist": artist,
                "album": "",
                "duration": dur,
                "coverUrl": cover,
                "previewUrl": preview,
                "source": "archive",
                "trackId": preview,
            })
    except Exception as e:
        log.warning("Archive.org search failed: %s", e)
    return out


_FS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Accept": "text/html,application/xhtml+xml",
}
_FS_AUDIO_EXTS = {"mp3", "m4a", "wav", "flac", "ogg", "wma", "aac", "opus", "webm"}


def _fs_is_url(url: str) -> bool:

    u = str(url or "")
    return bool(re.search(r"(^|\.)4shared\.com", u, re.I) or re.search(r"(^|\.)4s\.io", u, re.I))


def _fs_is_host(hostname: str) -> bool:

    h = str(hostname or "").strip()
    return bool(re.search(r"(^|\.)4shared\.com$", h, re.I) or re.search(r"(^|\.)4s\.io$", h, re.I)
                or re.search(r"(^|\.)static\.4shared\.com$", h, re.I))


def _fs_fetch(url: str, headers=None, timeout: int = 15, verify_default: bool = True):
    """GET dgn TLS longgar KHUSUS host 4shared (cert kedaluwarsa terukur)."""


    host_ok = _fs_is_host(urlparse(url).hostname or "")
    if host_ok:
        try:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        except Exception:
            pass
    return requests.get(url, headers=headers or _FS_HEADERS, timeout=timeout,
                        allow_redirects=True, verify=(False if host_ok else verify_default))


def _fs_parse_cards(html: str):
    """Port music-dl parseCards: kartu jsCardItem, link file 4s.io."""

    import html as _html
    items = []
    seen = set()
    chunks = html.split("jsCardItem")[1:]
    for c in chunks:
        try:
            link_m = re.search(r"https://www\.4s\.io/(?:mp3|music|video)/([A-Za-z0-9_-]{6,})/[^\"'\\s<>]*?\.html", c)
            if not link_m:
                continue
            file_id = link_m.group(1)
            if file_id in seen:
                continue
            seen.add(file_id)
            page_url = link_m.group(0)
            ext_m = re.search(r'jsFileCardExt">\s*([a-z0-9]+)\s*<', c, re.I)
            ext = (ext_m.group(1) if ext_m else "").lower()
            if ext and ext not in _FS_AUDIO_EXTS:
                continue
            name_m = re.search(r'jsFileName">\s*([^<]{1,200}?)\s*(?:</div>)', c, re.I | re.S)

            def _clean(s):
                s = _html.unescape(s or "")
                return re.sub(r"\s+", " ", s.replace("_", " ").replace("+", " ")).strip()
            raw_name = _clean(name_m.group(1) if name_m else "")
            if not raw_name:
                continue
            author_m = re.search(r'jsFileAuthorName"[^>]*>\s*([^<]{1,120}?)\s*(?:</div>|</a>)', c, re.I | re.S)
            author = _clean(author_m.group(1) if author_m else "")
            dur_m = re.search(r'jsFileDuration">\s*([\d:]{2,8})\s*<', c)
            duration = None
            if dur_m:
                parts = dur_m.group(1).strip().split(":")
                try:
                    nums = [int(x) for x in parts]
                    if len(nums) == 3:
                        duration = nums[0] * 3600 + nums[1] * 60 + nums[2]
                    elif len(nums) == 2:
                        duration = nums[0] * 60 + nums[1]
                    elif len(nums) == 1:
                        duration = nums[0]
                except Exception:
                    duration = None
            cover_m = re.search(r"background-image:\s*url\('([^']{10,300}?)'\)", c)
            raw_cover = cover_m.group(1) if cover_m else ""
            cover = raw_cover.replace("thumbnailSize=s", "thumbnailSize=m") if raw_cover.startswith("http") else ""
            title = re.sub(r"\.(mp3|m4a|wav|flac|ogg|wma|aac|opus|webm)$", "", raw_name, flags=re.I).strip() or raw_name
            artist = author
            if not artist or artist.lower() == "unknown":
                parts = [p.strip() for p in title.split(" - ", 1)]
                if len(parts) == 2:
                    artist, title = parts[0], parts[1]
            if not artist:
                artist = "Unknown"
            if not title:
                continue
            items.append({"fileId": file_id, "pageUrl": page_url, "title": title,
                          "artist": artist, "duration": duration or 0,
                          "coverUrl": cover, "ext": ext or "mp3"})
        except Exception:
            continue
    return items


def _search_fourshared(query: str, n: int):


    out = []
    try:
        q = (query or "").strip()[:120]
        if not q:
            return out
        want = max(1, min(40, int(n) or 8))
        pages = [(0, f"https://www.4shared.com/web/q?category=1&query={quote_plus(q)}")]
        seen_ids = set()
        for pi, (offset, url) in enumerate(pages):
            try:
                if offset:
                    url = f"https://www.4shared.com/web/q?category=1&offset={offset}&query={quote_plus(q)}"
                r = _fs_fetch(url, timeout=12)
                if not r.ok or not r.text or len(r.text) < 5000:
                    continue
                items = _fs_parse_cards(r.text)
                added = 0
                for it in items:
                    if it["fileId"] in seen_ids:
                        continue
                    seen_ids.add(it["fileId"])
                    out.append({
                        "id": f"fs-{it['fileId']}",
                        "title": it["title"][:120],
                        "artist": it["artist"][:120],
                        "album": "",
                        "duration": it["duration"] or None,
                        "coverUrl": it["coverUrl"] or "",
                        "previewUrl": None,
                        "source": "4shared",
                        "trackId": it["pageUrl"],
                    })
                    added += 1
                    if len(out) >= want:
                        break
                if len(out) >= want or added == 0 or pi >= 2:
                    break
                pages.append((len(seen_ids), ""))
            except Exception:
                continue
    except Exception as e:
        log.warning("4shared search failed: %s", e)
    return out[:n]


def _fs_parse_input(html: str, cls: str) -> str:
    """Ambil value input tersembunyi 4s.io by class (port parseFsInput)."""

    m = re.search(r'class=["\'][^"\']*' + cls + r'[^"\']*["\'][^>]*value=["\']([^"\']{10,1200}?)["\']', html, re.I) \
        or re.search(r'value=["\']([^"\']{10,1200}?)["\'][^>]*class=["\'][^"\']*' + cls, html[:2000000], re.I)
    return (m.group(1) if m else "").strip()


def _fs_decode_dlink(seg: str) -> str:
    """Decode segmen dlink_<hex> -> path /download/... (port decodeFsDlink)."""

    s = str(seg or "").strip()
    if re.match(r"^dlink_", s, re.I):
        s = s[6:]

    def _hx(m):
        try:
            return chr(int(m.group(1), 16))
        except Exception:
            return "_" + m.group(1)
    return re.sub(r"_([0-9A-Fa-f]{2})", _hx, s)


def _resolve_4shared(page_url: str, timeout: int = 20) -> dict:
    """Resolve halaman file 4s.io -> stream asli. Port music-dl resolveFoursharedStream.
    Return: {previewUrl, downloadUrl, coverUrl, sizeBytes, fileId} atau {error, gate}."""

    clean = str(page_url or "").strip()
    if not clean or "\0" in clean or not _fs_is_url(clean):
        return {"error": "URL 4shared tidak valid"}
    id_m = re.search(r"4s\.io/(?:mp3|music|video)/([A-Za-z0-9_-]{6,})", clean, re.I)
    file_id = id_m.group(1) if id_m else ""
    try:
        r = _fs_fetch(clean, timeout=timeout)
        if not r.ok or not r.text:
            return {"error": f"Halaman 4shared HTTP {r.status_code}"}
        html = r.text
        lim_m = re.search(r'id=["\']jsFreeUserTrafficLimitExceeded["\'][^>]*value=["\']([^"\']*)["\']', html, re.I) \
            or re.search(r'value=["\']([^"\']*)["\'][^>]*id=["\']jsFreeUserTrafficLimitExceeded["\']', html, re.I)
        limited = (lim_m.group(1).strip().lower() if lim_m else "") == "true"
        preview_url = _fs_parse_input(html, "jsD1PreviewUrl")
        if not preview_url or not re.match(r"^https?://", preview_url, re.I):
            gate_txt = bool(re.search(r"you have exceeded your traffic limit|traffic limit exceeded|please[^<]{0,60}log\s?in to download|prove you are not a robot|buktikan anda bukan robot", html, re.I))
            if gate_txt or limited:
                return {"error": "4shared meminta login / batas trafik tercapai (gate)", "gate": True}
            return {"error": "Stream 4shared tidak ditemukan di halaman (markup berubah?)"}
        try:
            h = _fs_fetch(preview_url, headers={**_FS_HEADERS, "Range": "bytes=0-1"}, timeout=15)
            if h.status_code not in (200, 206):
                return {"error": f"Stream 4shared HTTP {h.status_code}",
                        "gate": h.status_code in (401, 403)}
            size = int(h.headers.get("content-length") or 0) or 0
        except Exception as e:
            return {"error": f"Stream 4shared tak terjangkau: {str(e)[:120]}"}
        download_url = None
        try:
            dlink_m = re.search(r"(dlink_[A-Za-z0-9_.]+)", preview_url)
            if dlink_m:

                dc_host = urlparse(preview_url).hostname or ""
                decoded = _fs_decode_dlink(dlink_m.group(1))
                if decoded.startswith("/download/"):
                    download_url = f"https://{dc_host}{decoded}"
        except Exception:
            pass
        cover = _fs_parse_input(html, "jsD1BigCoverUrl") or _fs_parse_input(html, "jsD1SmallCoverUrl")
        return {"previewUrl": preview_url, "downloadUrl": download_url, "coverUrl": cover,
                "sizeBytes": size, "fileId": file_id, "limited": limited}
    except Exception as e:
        return {"error": f"Resolve 4shared gagal: {str(e)[:200]}"}


def _fetch_4shared_bytes(url: str, timeout: int = 180, max_bytes: int = 120 * 1024 * 1024) -> tuple:
    """Download bytes stream 4shared (ikuti redirect manual, maks 5 hop, tetap di host 4shared).
    Return (data|None, error|None). Port music-dl fetchFsBytes."""


    try:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except Exception:
        pass
    current = url
    try:
        for _hop in range(5):
            host_ok = _fs_is_host(urlparse(current).hostname or "")
            try:
                with requests.get(current, headers=_FS_HEADERS, timeout=timeout, stream=True,
                                  allow_redirects=False, verify=(False if host_ok else True)) as r:
                    if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                        nxt = urljoin(current, r.headers["location"])
                        if not _fs_is_host(urlparse(nxt).hostname or ""):
                            return None, "Redirect stream 4shared keluar domain"
                        current = nxt
                        continue
                    if r.status_code not in (200, 206):
                        return None, f"Stream 4shared HTTP {r.status_code}"
                    chunks, total = [], 0
                    for ch in r.iter_content(chunk_size=65536):
                        if not ch:
                            continue
                        total += len(ch)
                        if total > max_bytes:
                            return None, f"File 4shared melebihi batas ({max_bytes // 1048576}MB)"
                        chunks.append(ch)
                    data = b"".join(chunks)
                    if len(data) < 1024:
                        return None, "File 4shared kosong"
                    return data, None
            except Exception as e:
                return None, str(e)[:200]
        return None, "Terlalu banyak redirect stream 4shared"
    except Exception as e:
        return None, str(e)[:200]


def _search_spotify(query: str, n: int, client_id: str, client_secret: str):


    out = []
    try:
        cid, sec = (client_id or "").strip(), (client_secret or "").strip()
        if not cid or not sec:
            return out
        auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        tr = requests.post("https://accounts.spotify.com/api/token", headers={"Authorization": f"Basic {auth}"},
                           data={"grant_type": "client_credentials"}, timeout=10)
        if not tr.ok:
            log.warning("Spotify token failed: %s", tr.text[:200])
            return out
        token = tr.json().get("access_token") or ""
        if not token:
            return out
        sr = requests.get("https://api.spotify.com/v1/search", params={"q": query, "type": "track", "limit": min(max(n, 1), 10)},
                          headers={"Authorization": f"Bearer {token}"}, timeout=12)
        if not sr.ok:
            log.warning("Spotify search failed: %s", sr.text[:200])
            return out
        for j in ((sr.json().get("tracks") or {}).get("items") or [])[:n]:
            artists = j.get("artists") or []
            artist = ", ".join(a.get("name") or "" for a in artists if isinstance(a, dict)) or "Spotify"
            album = (j.get("album") or {}).get("name") or ""
            imgs = (j.get("album") or {}).get("images") or []
            cover = (imgs[0].get("url") if imgs else "") or ""
            out.append({
                "id": f"sp-{j.get('id')}",
                "title": j.get("name") or query,
                "artist": artist,
                "album": album,
                "duration": int((j.get("duration_ms") or 0) / 1000) or None,
                "coverUrl": cover,
                "previewUrl": j.get("preview_url"),
                "source": "spotify",
                "trackId": (j.get("external_urls") or {}).get("spotify") or j.get("uri") or "",
            })
    except Exception as e:
        log.warning("Spotify search failed: %s", e)
    return out


@router.post("/search")
async def search(payload: dict):

    query = (payload.get("query") or "").strip()
    search_type = payload.get("type", "all")
    src_filter = str(payload.get("source") or "all").strip().lower()
    if src_filter not in ("all", "spotify", "deezer", "soundcloud", "archive", "4shared"):
        src_filter = "all"
    limit = min(int(payload.get("limit", 100)), 100)
    if not query:
        return {"tracks": [], "albums": [], "artists": [], "debug": {}}
    client_id = (payload.get("clientId") or payload.get("spotifyClientId") or "").strip()
    client_secret = (payload.get("clientSecret") or payload.get("spotifyClientSecret") or "").strip()
    sc_cookies = _valid_cookies(payload.get("scCookies") or "")
    cache_key = f"{query.lower()}::{search_type}::src={src_filter}::{limit}::sp={bool(client_id)}::sc={bool(sc_cookies)}"
    now = time.time()
    if cache_key in search_cache and now - search_cache[cache_key][0] < 90:
        cached = search_cache[cache_key][1]
        if cached.get("tracks") or cached.get("debug"):
            return cached
    _only = src_filter if src_filter != "all" else None
    active_sources = 5
    per_base = limit // active_sources
    remainder = limit % active_sources
    per_sp = limit if _only == "spotify" else (0 if _only else per_base + (1 if remainder > 0 else 0))
    per_dz = limit if _only == "deezer" else (0 if _only else per_base + (1 if remainder > 1 else 0))
    per_sc = limit if _only == "soundcloud" else (0 if _only else per_base + (1 if remainder > 2 else 0))
    per_ia = limit if _only == "archive" else (0 if _only else per_base + (1 if remainder > 3 else 0))
    per_fs = limit if _only == "4shared" else (0 if _only else per_base + (1 if remainder > 4 else 0))

    def _safe(fut, timeout, label, skip_reason=""):
        """Ambil hasil future tanpa melempar; isi debug {ok, count, error}."""
        t0 = time.time()
        if fut is None:
            return [], {"ok": False, "count": 0, "error": skip_reason or "skip", "ms": 0}
        try:
            out = fut.result(timeout=timeout)
            if not isinstance(out, list):
                out = []
            return out, {"ok": True, "count": len(out),
                         "error": "" if out else "0 hasil", "ms": int((time.time() - t0) * 1000)}
        except Exception as e:
            log.warning("search source %s failed: %s", label, e)
            return [], {"ok": False, "count": 0, "error": str(e)[:160],
                        "ms": int((time.time() - t0) * 1000)}

    with ThreadPoolExecutor(max_workers=5) as ex:
        _skip = f"filter source: {src_filter}" if _only else ""
        f_sp = ex.submit(_search_spotify, query, per_sp, client_id, client_secret) if (client_id and client_secret and per_sp) else None
        f_dz = ex.submit(_search_deezer, query, per_dz) if per_dz else None
        f_sc = ex.submit(_search_soundcloud, query, per_sc, sc_cookies) if per_sc else None
        f_ia = ex.submit(_search_archive, query, per_ia) if per_ia else None
        f_fs = ex.submit(_search_fourshared, query, per_fs) if per_fs else None
        sp, dbg_sp = _safe(f_sp, 25, "spotify", "kredensial Spotify belum diisi" if not _skip else _skip)
        dz, dbg_dz = _safe(f_dz, 25, "deezer", _skip)
        sc, dbg_sc = _safe(f_sc, 60, "soundcloud", _skip)
        ia, dbg_ia = _safe(f_ia, 30, "archive", _skip)
        fs, dbg_fs = _safe(f_fs, 25, "fourshared", _skip)
    debug = {"spotify": dbg_sp, "deezer": dbg_dz, "soundcloud": dbg_sc,
             "archive": dbg_ia, "fourshared": dbg_fs}
    tracks = []
    for bucket in (sp, dz, sc, ia, fs):
        for t in bucket:
            if len(tracks) >= limit:
                break
            if _only and str(t.get("source") or "").lower() != _only:
                continue
            tracks.append(t)
        if len(tracks) >= limit:
            break
    seen, uniq = set(), []
    for t in tracks:
        key = ((t.get("title") or "").strip().lower(), (t.get("artist") or "").strip().lower())
        if key in seen:
            continue
        seen.add(key)
        uniq.append(t)
    saran = ""
    before_filter = len(uniq)
    if search_type == "title":
        ql = query.lower()
        uniq = [t for t in uniq if ql in (t.get("title") or "").lower()]
    elif search_type == "artist":
        ql = query.lower()
        uniq = [t for t in uniq if ql in (t.get("artist") or "").lower()]
    elif search_type == "album":
        ql = query.lower()
        uniq = [t for t in uniq if ql in (t.get("album") or "").lower()]
    if not uniq and before_filter > 0 and search_type != "all":
        saran = f"Filter {search_type} mengosongkan {before_filter} hasil — coba filter Semua"
    result = {"tracks": uniq[:limit], "albums": [], "artists": [], "debug": debug, "saran": saran}
    if uniq:
        search_cache[cache_key] = (now, result)
    if len(search_cache) > 60:
        oldest = min(search_cache, key=lambda k: search_cache[k][0])
        del search_cache[oldest]
    return result

def _ytsearch_url(artist: str, title: str, suffix: str = " audio") -> str:
    q = f"{(artist or '').strip()} - {(title or '').strip()}{suffix}".strip(" -")
    return f"ytsearch1:{q}"


def _ytm_search_ytdlp(artist: str, title: str, timeout: int = 25) -> str | None:
    """Resolve trek resmi YT Music via yt-dlp search URL (port music-dl searchMusic).
    Prefix ytmusicsearch1 TIDAK didukung yt-dlp 2026.08.19 — pakai URL search langsung
    (extractor youtube:music:search_url). Hanya entri watch?v= (lewati kanal/browse).
    None bila tak ketemu / timeout / gagal. Tidak pernah throw."""
    try:
        a, t = (artist or "").strip(), (title or "").strip()
        clean = f"{a} - {t} audio".strip(" -").replace("\r", " ").replace("\n", " ").replace("\0", "")[:200]
        if not clean:
            return None
        yt_dlp = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
        if not yt_dlp:
            return None
        search_url = f"https://music.youtube.com/search?q={quote_plus(clean)}"
        cmd = [yt_dlp, "--quiet", "--no-warnings", "--flat-playlist", "--dump-json", search_url]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            log.warning("ytm yt-dlp search exit %s: %s", proc.returncode, (proc.stderr or "")[-300:])
            return None
        vid_re = re.compile(r"^[\w-]{11}$")
        for line in (proc.stdout or "").splitlines():
            s = line.strip()
            if not s.startswith("{"):
                continue
            try:
                e = json.loads(s)
            except Exception:
                continue
            if not isinstance(e, dict):
                continue
            u = str(e.get("url") or e.get("webpage_url") or "")
            m = re.search(r"[?&]v=([\w-]{11})", u)
            vid = m.group(1) if m else ""
            if not vid and vid_re.match(str(e.get("id") or "") or ""):
                vid = str(e.get("id") or "")
            if not vid:
                continue
            if not str(e.get("title") or "").strip():
                continue
            return f"https://music.youtube.com/watch?v={vid}"
    except subprocess.TimeoutExpired:
        log.warning("ytm yt-dlp search timeout %ss", timeout)
    except Exception as e:
        log.warning("ytm yt-dlp search failed: %s", e)
    return None


def _ytm_url(artist: str, title: str, timeout: int = 20) -> str | None:
    """Resolve trek resmi YT Music. Urutan: yt-dlp search (ala music-dl) dulu,
    ytmusicapi cadangan bila gagal. Prefer judul+artis persis; fallback hasil pertama."""
    a, t = (artist or "").strip(), (title or "").strip()
    if not a and not t:
        return None
    ytdlp = _ytm_search_ytdlp(a, t)
    if ytdlp:
        return ytdlp
    try:
        from ytmusicapi import YTMusic
        yt = YTMusic()
        res = yt.search(f"{a} {t}".strip()[:120], filter="songs", limit=10) or []
        norm = lambda s: str(s or "").lower().strip()
        n_title, n_artist = norm(t), norm(a.split(",")[0])
        for r in res:
            if not isinstance(r, dict) or not r.get("videoId"):
                continue
            arts = " ".join(x.get("name") or "" for x in (r.get("artists") or []) if isinstance(x, dict))
            if n_title and norm(r.get("title")) == n_title and (not n_artist or n_artist in norm(arts)):
                return f"https://music.youtube.com/watch?v={r['videoId']}"
        for r in res:
            if isinstance(r, dict) and r.get("videoId"):
                return f"https://music.youtube.com/watch?v={r['videoId']}"
    except Exception as e:
        log.warning("ytmusic resolve failed: %s", e)
    return None


def _youtube_queue(artist: str, title: str) -> list:
    """Antrean fallback YouTube: YT Music dulu, baru YouTube Video (+audio), lalu polos."""
    ytm = _ytm_url(artist, title)
    q = [ytm] if ytm else []
    q += [_ytsearch_url(artist, title), _ytsearch_url(artist, title, suffix="")]
    return list(dict.fromkeys([x for x in q if x]))


def _via_for_query(q: str, artist: str, title: str) -> str:
    if isinstance(q, str) and "music.youtube.com" in q:
        return "youtube-music"
    if q == _ytsearch_url(artist, title, suffix=""):
        return "youtube-fallback"
    if isinstance(q, str) and "soundcloud.com" in q:
        return "soundcloud-alt"
    return "youtube"


def _valid_cookies(path: str | None) -> str:
    """Kembalikan path cookies bila file valid, else ''. Tidak pernah throw."""
    try:
        if not path:
            return ""
        p = Path(str(path).strip())
        if not p.is_file() or p.stat().st_size < 16:
            return ""
        head = p.read_bytes()[:2048]
        if b"soundcloud.com" not in head and b"#HttpOnly" not in head and b"Netscape" not in head:
            return ""
        return str(p)
    except Exception:
        return ""


def _sc_full_available(url: str, cookies: str = "", timeout: int = 25) -> bool:
    """True bila SoundCloud menyediakan stream FULL (non-preview) utk URL ini."""

    try:
        yt_dlp = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
        if not yt_dlp or not url:
            return False
        cmd = [yt_dlp, "--no-warnings", "--skip-download", "-J", url]
        if cookies:
            cmd += ["--cookies", cookies]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            return False
        data = json.loads(proc.stdout or "{}")
        fmts = data.get("formats") or []
        if isinstance(fmts, dict):
            fmts = [fmts]
        for f in fmts:
            if not isinstance(f, dict):
                continue
            if (f.get("acodec") or "none") == "none" and not f.get("url"):
                continue
            fid = str(f.get("format_id") or "")
            if "preview" in fid.lower():
                continue
            if (f.get("acodec") or "none") != "none" or "mp3" in fid or "opus" in fid or "http" in fid or "hls" in fid:
                return True
    except Exception as e:
        log.warning("sc full-check failed: %s", e)
    return False


def _scsearch_url(artist: str, title: str, timeout: int = 20, cookies: str = "") -> str | None:
    """Resolve URL SoundCloud FULL pertama (lewati yg preview-only)."""

    try:
        yt_dlp = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
        if not yt_dlp:
            return None
        q = f"{(artist or '').strip()} - {(title or '').strip()}".strip(" -")[:200]
        if not q:
            return None
        cmd = [yt_dlp, "--quiet", "--no-warnings", "--flat-playlist", "--dump-json", "scsearch5:" + q]
        if cookies:
            cmd += ["--cookies", cookies]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            return None
        for line in (proc.stdout or "").splitlines():
            try:
                j = json.loads(line.strip())
            except Exception:
                continue
            if not isinstance(j, dict):
                continue
            try:
                dur = int(float(j.get("duration"))) if j.get("duration") else None
            except Exception:
                dur = None
            if dur and dur <= 40:
                continue
            page = j.get("webpage_url") or ""
            if not page or "soundcloud.com" not in str(page).lower():
                continue
            if _sc_full_available(str(page), cookies, timeout=20):
                return str(page)
    except Exception as e:
        log.warning("scsearch resolve failed: %s", e)
    return None
