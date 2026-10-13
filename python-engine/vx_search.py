"""VocaLyx engine - online search routes (Spotify/SoundCloud/Archive/Deezer/4shared/YouTube)."""
import base64
import json
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

import requests
import urllib3
from fastapi import APIRouter

from vx_core import log, yt_dlp_cmd

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
        yt_dlp = yt_dlp_cmd()
        if not yt_dlp:
            raise RuntimeError("yt-dlp tidak tersedia di runtime - lengkapi runtime lalu ulangi")
        want = min(max(n * 2, 6), 10)
        cmd = yt_dlp + ["--quiet", "--no-warnings", "--flat-playlist", "--dump-json", f"scsearch{want}:{query}"]
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
                if _sc_full_available(page, cookies, timeout=40, retries=1):
                    return c
            except Exception:
                pass
            return None
        # Berhenti awal: ambil hasil sesuai selesai (bukan tunggu semua),
        # batalkan sisanya begitu kuota n terpenuhi. Tanpa ini satu probe
        # lambat menahan semuanya sampai timeout future.
        full, preview_only = [], []
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = {ex.submit(_probe, c): c for c in cands}
            try:
                for fut in as_completed(futs, timeout=90):
                    try:
                        hit = fut.result()
                    except Exception:
                        hit = None
                    if hit is not None:
                        full.append(hit)
                    else:
                        preview_only.append(futs[fut])
                    if len(full) >= n:
                        break
            except Exception:
                pass
            for f in futs:
                f.cancel()
        # Fallback: bila TIDAK ADA yang full, tampilkan kandidat preview-only
        # ber-badge (lebih baik dari 0 total; user yang putuskan). Metadata
        # kandidat sudah valid (halaman soundcloud.com + durasi disaring).
        use_preview_fallback = not full and bool(preview_only)
        for (j, sid, dur, page) in (full or preview_only[:n]):
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
                "preview_only": bool(use_preview_fallback),
                "trackId": page,
            })
    except Exception as e:
        log.warning("SoundCloud search failed: %s", e)
    return out


def _lucene_escape(q: str) -> str:
    """Escape karakter khusus Lucene yang aman di dalam grup kurung.

    Terverifikasi live: meng-escape `-` menjadi `\\-` justru melempar
    `[BACKEND_ERROR] Invalid or no response from Elasticsearch`, sementara
    tanpa escape backend OK. `-` hanya spesial di awal klausa, jadi TIDAK
    di-escape. Yang di-escape: karakter pemecah sintaks
    (`"` `:` `(` `)` dan operator boolean/field lainnya).
    """
    return re.sub(r'([+=&|><!(){}[\]^"~*?:\\/])', r"\\\1", str(q or ""))


def _archive_metadata(ident: str, timeout: int = 25, retries: int = 1):
    """Daftar files metadata archive.org, atau None bila gagal total.

    Timeout 25 dtk + 1x retry: dari log lapangan, 10 dtk tanpa retry membuat
    dokumen terlewat satu per satu padahal server hanya lambat.
    """
    url = f"https://archive.org/metadata/{ident}"
    attempt = 0
    while True:
        try:
            mr = requests.get(url, timeout=timeout)
            if mr.ok:
                return mr.json().get("files") or []
            if attempt < retries and mr.status_code in (429, 500, 502, 503, 504):
                attempt += 1
                time.sleep(1.5 * attempt)
                continue
            return None
        except Exception as e:
            if attempt < retries:
                attempt += 1
                time.sleep(1.5 * attempt)
                continue
            log.warning("Archive metadata %s failed: %s", ident, e)
            return None


def _search_archive(query: str, n: int):


    out = []
    try:
        q = _lucene_escape(query.strip()[:120])
        if not q.strip("\\"):
            return out
        lucene = f'(title:({q}) OR creator:({q})) AND mediatype:audio'
        params = {
            "q": lucene, "fl[]": ["identifier", "title", "creator", "downloads"],
            "rows": min(max(n, 1), 10), "page": 1, "output": "json",
        }
        r = requests.get("https://archive.org/advancedsearch.php", params=params,
                         headers={"User-Agent": "Mozilla/5.0 VocaLyx/0.1"}, timeout=20)
        if not r.ok:
            log.warning("Archive search HTTP %s: %s", r.status_code, (r.text or "")[:160])
            return out
        try:
            body = r.json()
        except Exception:
            log.warning("Archive search bukan JSON: %s", (r.text or "")[:160])
            return out
        if isinstance(body, dict) and body.get("error"):
            # Backend Elasticsearch menolak sintaks fielded (pernah terukur
            # untuk pola tertentu) -> mundur ke query polos yang longgar.
            log.warning("Archive search backend error, coba query polos: %s", str(body.get("error"))[:120])
            plain = f"{query.strip()[:120]} AND mediatype:audio"
            r2 = requests.get("https://archive.org/advancedsearch.php",
                              params={**params, "q": plain},
                              headers={"User-Agent": "Mozilla/5.0 VocaLyx/0.1"}, timeout=20)
            try:
                body = r2.json() if r2.ok else {}
            except Exception:
                body = {}
        docs = (body.get("response") or {}).get("docs") or [] if isinstance(body, dict) else []
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
            files = _archive_metadata(ident)
            best = None
            if files:
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
            clean = re.sub(r"\.[a-z0-9]{2,4}$", "", title, flags=re.I).replace("_", " ").strip() or query
            if not preview:
                # Fallback: metadata gagal total, tapi itemnya ADA. Tampilkan
                # entri halaman (bisa dibuka manual) alih-alih dibuang diam-diam;
                # unduhan langsung tidak bisa tanpa URL file (page_only=True).
                out.append({
                    "id": f"ia-{ident}",
                    "title": clean,
                    "artist": artist,
                    "album": "",
                    "duration": dur,
                    "coverUrl": cover,
                    "previewUrl": None,
                    "source": "archive",
                    "page_only": True,
                    "trackId": f"https://archive.org/details/{ident}",
                })
                continue
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


_FS_REST_HEADERS = {
    **_FS_HEADERS,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
}

_FS_REST_REFERER = "https://www.4shared.com/web/q?category=1&query="


def _fs_rest_search(query: str, offset: int, limit: int, timeout: int = 25, retries: int = 1):
    """Cari via REST JSON 4shared (pengganti scraping HTML yang markup-nya mati).

    Halaman search kini JS-rendered (hasil via XHR `GET /web/rest/v1_2/files`
    dengan param `search`, BUKAN `query`; respons `{"files": [...]}`). Scraping
    `jsCardItem` lama menghasilkan 0 kartu dan dipertahankan hanya sebagai
    fallback bila REST gagal total.
    """
    from urllib.parse import urlencode

    params = {"search": query, "category": "1", "offset": offset, "limit": limit}
    url = "https://www.4shared.com/web/rest/v1_2/files?" + urlencode(params)
    headers = {**_FS_REST_HEADERS, "Referer": _FS_REST_REFERER + quote_plus(query)}
    attempt = 0
    while True:
        try:
            r = _fs_fetch(url, headers=headers, timeout=timeout)
            if not r.ok:
                if attempt < retries and r.status_code in (429, 500, 502, 503, 504):
                    attempt += 1
                    time.sleep(1.5 * attempt)
                    continue
                log.warning("4shared REST HTTP %s", r.status_code)
                return []
            try:
                data = r.json()
            except Exception:
                log.warning("4shared REST bukan JSON: %s", (r.text or "")[:160])
                return []
            files = data.get("files") if isinstance(data, dict) else None
            return files if isinstance(files, list) else []
        except Exception as e:
            if attempt < retries:
                attempt += 1
                time.sleep(1.5 * attempt)
                continue
            log.warning("4shared REST gagal: %s", e)
            return []


def _fs_rest_item(f: dict) -> dict | None:
    """Petakan satu item REST -> format internal. None bila bukan audio layak."""
    try:
        if not isinstance(f, dict):
            return None
        if f.get("abusiveContent") or f.get("ownerOnly"):
            return None
        fid = str(f.get("id") or "")
        name = str(f.get("name") or "")
        if not fid or not name:
            return None
        low = name.lower()
        ext = low.rsplit(".", 1)[-1] if "." in low else ""
        mime = str(f.get("mimeType") or "")
        if ext not in _FS_AUDIO_EXTS and not mime.startswith("audio/"):
            return None
        import html as _html

        raw = re.sub(r"\s+", " ", _html.unescape(name).replace("_", " ")).strip()
        title = re.sub(r"\.(mp3|m4a|wav|flac|ogg|wma|aac|opus|webm)$", "", raw, flags=re.I).strip() or raw
        parts = [p.strip() for p in title.split(" - ", 1)]
        if len(parts) == 2:
            artist, title = parts[0], parts[1]
        else:
            artist = "Unknown"
        page = str(f.get("downloadPage") or "")
        if not page or not _fs_is_url(page):
            return None
        return {"fileId": fid, "pageUrl": page, "title": title[:120] or raw[:120],
                "artist": artist[:120], "duration": None,
                "coverUrl": str(f.get("thumbnailUrl") or ""), "ext": ext or "mp3"}
    except Exception:
        return None


def _search_fourshared(query: str, n: int):


    out = []
    try:
        q = (query or "").strip()[:120]
        if not q:
            return out
        want = max(1, min(40, int(n) or 8))
        seen_ids = set()
        offset = 0
        for _page in range(4):
            items = _fs_rest_search(q, offset, 12)
            if not items:
                # Fallback terakhir: scraping HTML lama (markup 2024).
                if not out and offset == 0:
                    try:
                        r = _fs_fetch(
                            f"https://www.4shared.com/web/q?category=1&query={quote_plus(q)}",
                            timeout=25)
                        if r.ok and r.text and len(r.text) >= 5000:
                            items = [{"_legacy": it} for it in _fs_parse_cards(r.text)]
                    except Exception:
                        pass
                if not items:
                    break
            added = 0
            for entry in items:
                it = entry["_legacy"] if isinstance(entry, dict) and "_legacy" in entry else _fs_rest_item(entry)
                if not it or it["fileId"] in seen_ids:
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
            if len(out) >= want or added == 0:
                break
            offset += len(items)
        if not out:
            log.warning("4shared search 0 hasil: %s", q[:80])
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
            # Kelas karakter WAJIB mencakup `-`: segmen dlink asli mengandung
            # strip (mis. `...Tulus_5F-_5FHati...`); tanpanya URL unduhan
            # terpotong di tengah path (terbukti saat probing REST 2026).
            dlink_m = re.search(r"(dlink_[A-Za-z0-9_.\-]+)", preview_url)
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
        sc, dbg_sc = _safe(f_sc, 100, "soundcloud", _skip)
        ia, dbg_ia = _safe(f_ia, 90, "archive", _skip)
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
    # Urut relevansi: API longgar (Deezer fonetik, 4shared populer) menaruh
    # "I Wanna/Akon" di atas untuk query "iwan fals". Exact-first yang stabil:
    # cocok tetap di atas, sisanya tenggelam tapi tidak dihapus.
    ql_all = query.lower()
    qwords = [w for w in ql_all.split() if len(w) > 2]
    def _score(t):
        ti = (t.get("title") or "").lower()
        ar = (t.get("artist") or "").lower()
        al = (t.get("album") or "").lower()
        s = 0
        if ql_all and ql_all in ti:
            s += 3
        if ql_all and ql_all in ar:
            s += 2
        if ql_all and ql_all in al:
            s += 2
        for w in qwords:
            if w in ti:
                s += 1
            if w in ar:
                s += 1
        return s
    uniq.sort(key=_score, reverse=True)
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
        yt_dlp = yt_dlp_cmd()
        if not yt_dlp:
            return None
        search_url = f"https://music.youtube.com/search?q={quote_plus(clean)}"
        cmd = yt_dlp + ["--quiet", "--no-warnings", "--flat-playlist", "--dump-json", search_url]
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


def _sc_full_available(url: str, cookies: str = "", timeout: int = 40, retries: int = 1) -> bool:
    """True bila SoundCloud menyediakan stream FULL (non-preview) utk URL ini.

    Timeout 40 dtk + 1x retry: dari log lapangan, probe `-J` sering timeout
    tepat di 20 dtk karena throttling SoundCloud (bukan karena URL mati).
    Retry hanya untuk timeout/gagal jalan; hasil parse definitif (tidak ada
    format full) langsung False tanpa retry.
    """

    yt_dlp = yt_dlp_cmd()
    if not yt_dlp or not url:
        return False
    cmd = yt_dlp + ["--no-warnings", "--skip-download", "-J", url]
    if cookies:
        cmd += ["--cookies", cookies]
    attempt = 0
    while True:
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            log.warning("sc full-check timeout (%ss): %s", timeout, url[-80:])
            if attempt < retries:
                attempt += 1
                continue
            log.warning("sc full-check failed: %s", e)
            return False
        except Exception as e:
            log.warning("sc full-check failed: %s", e)
            return False
        if proc.returncode != 0:
            err = (proc.stderr or "")[-200:]
            if attempt < retries and ("timed out" in err.lower() or "timeout" in err.lower() or not (proc.stdout or "").strip()):
                attempt += 1
                continue
            return False
        try:
            data = json.loads(proc.stdout or "{}")
        except Exception:
            return False
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
        return False


def _scsearch_url(artist: str, title: str, timeout: int = 20, cookies: str = "") -> str | None:
    """Resolve URL SoundCloud FULL pertama (lewati yg preview-only)."""

    try:
        yt_dlp = yt_dlp_cmd()
        if not yt_dlp:
            return None
        q = f"{(artist or '').strip()} - {(title or '').strip()}".strip(" -")[:200]
        if not q:
            return None
        cmd = yt_dlp + ["--quiet", "--no-warnings", "--flat-playlist", "--dump-json", "scsearch5:" + q]
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
