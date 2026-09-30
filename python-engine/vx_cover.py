"""VocaLyx engine - cover art resolve/embed plus embed tag/rename/cover routes."""
import io
import re
import time
from pathlib import Path
from urllib.parse import unquote

import requests
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1
from mutagen.mp4 import MP4, MP4Cover
from PIL import Image

from vx_core import log

router = APIRouter()

_cover_cache: dict = {}


def _cover_mime(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _to_jpeg(data: bytes) -> bytes | None:
    """Konversi PNG/WebP -> JPEG (mutagen APIC/covr paling aman pakai JPEG)."""
    try:


        img = Image.open(io.BytesIO(data))
        if img.mode in ("RGBA", "LA", "PA"):
            bg = Image.new("RGB", img.size, (0, 0, 0))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        return buf.getvalue()
    except Exception as e:
        log.warning("cover convert failed: %s", e)
        return None


def _fetch_cover_bytes(url: str, timeout: int = 12) -> bytes | None:

    try:
        if not url or not url.startswith("http"):
            return None
        r = requests.get(url, timeout=timeout, headers={"User-Agent": "Mozilla/5.0 VocaLyx/0.1"})
        if not r.ok or not r.content:
            return None
        mime = _cover_mime(r.content[:16])
        if mime in ("image/jpeg", "image/png"):
            return r.content
        if mime == "image/webp":
            return _to_jpeg(r.content)
        ct = (r.headers.get("content-type") or "").lower()
        if "jpeg" in ct or "jpg" in ct or "png" in ct:
            return r.content
        if "webp" in ct:
            return _to_jpeg(r.content)
        return None
    except Exception as e:
        log.warning("fetch cover failed: %s", e)
        return None


def _itunes_cover_url(artist: str, title: str, album: str = "", timeout: int = 6) -> str | None:
    """Fallback cover via iTunes Search API. Album included for tighter matching."""


    a, t, alb = (artist or "").strip(), (title or "").strip(), (album or "").strip()
    if not a and not t:
        return None
    key = f"{a.lower()}::{t.lower()}::{alb.lower()}"
    now = time.time()
    if key in _cover_cache and now - _cover_cache[key][1] < 600:
        return _cover_cache[key][0]
    url = None
    try:
        term = f"{a} {t}".strip()[:120]
        r = requests.get("https://itunes.apple.com/search",
                         params={"term": term, "entity": "song", "limit": 5}, timeout=timeout)
        if r.ok:
            results = r.json().get("results") or []
            def norm(s):
                s = str(s or "").lower().strip()
                s = re.sub(r"\s*[\(\[].*?[\)\]]\s*", " ", s)
                s = re.sub(r"\s+-\s+(single|remaster|version|cover|acoustic|live).*$", "", s)
                return re.sub(r"\s+", " ", s).strip()
            n_title, n_artist, n_album = norm(t), norm(a.split(",")[0]), norm(alb)
            best = None
            for j in results:
                if (norm(j.get("trackName")) == n_title
                        and n_artist and n_artist in norm(j.get("artistName"))
                        and (not n_album or n_album == norm(j.get("collectionName")))):
                    best = j.get("artworkUrl100") or j.get("artworkUrl60")
                    break
            if not best:
                for j in results:
                    if norm(j.get("trackName")) == n_title and n_artist and n_artist in norm(j.get("artistName")):
                        best = j.get("artworkUrl100") or j.get("artworkUrl60")
                        break
            if not best:
                for j in results:
                    if norm(j.get("trackName")) == n_title and j.get("artworkUrl100"):
                        best = j.get("artworkUrl100")
                        break
            if not best:
                first = next((j for j in results if j.get("artworkUrl100") or j.get("artworkUrl60")), None)
                if first:
                    best = first.get("artworkUrl100") or first.get("artworkUrl60")
            if best:
                url = str(best).replace("100x100bb", "600x600bb").replace("100x100", "600x600").replace("60x60bb", "600x600bb")
    except Exception as e:
        log.warning("iTunes cover lookup failed: %s", e)
    _cover_cache[key] = (url, now)
    if len(_cover_cache) > 200:
        oldest = min(_cover_cache, key=lambda k: _cover_cache[k][1])
        del _cover_cache[oldest]
    return url


def _norm_cover_key(s: str) -> str:
    s = str(s or "").lower().strip()
    s = re.sub(r"\s*[\(\[].*?[\)\]]\s*", " ", s)
    s = re.sub(r"\s+-\s+(single|remaster|version|cover|acoustic|live).*$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _deezer_cover_url(artist: str, title: str, album: str = "", timeout: int = 8) -> str | None:
    """Fallback cover via Deezer Search API. Album included for tighter matching."""


    a, t, alb = (artist or "").strip(), (title or "").strip(), (album or "").strip()
    if not a and not t:
        return None
    key = f"dz::{a.lower()}::{t.lower()}::{alb.lower()}"
    now = time.time()
    if key in _cover_cache and now - _cover_cache[key][1] < 600:
        return _cover_cache[key][0]
    url = None
    try:
        r = requests.get("https://api.deezer.com/search",
                         params={"q": f"{a} {t}".strip()[:120]}, timeout=timeout)
        if r.ok:
            data = r.json().get("data") or []
            n_title, n_artist, n_album = _norm_cover_key(t), _norm_cover_key(a.split(",")[0]), _norm_cover_key(alb)
            best = None
            for j in data:
                alb = j.get("album") or {}
                if (_norm_cover_key(j.get("title")) == n_title
                        and n_artist and n_artist in _norm_cover_key((j.get("artist") or {}).get("name"))
                        and (not n_album or n_album == _norm_cover_key(alb.get("title")))):
                    best = alb.get("cover_xl") or alb.get("cover_big") or alb.get("cover_medium")
                    break
            if not best:
                for j in data:
                    alb = j.get("album") or {}
                    if _norm_cover_key(j.get("title")) == n_title and n_artist and n_artist in _norm_cover_key((j.get("artist") or {}).get("name")):
                        best = alb.get("cover_xl") or alb.get("cover_big") or alb.get("cover_medium")
                        break
            if not best:
                for j in data:
                    alb = j.get("album") or {}
                    if _norm_cover_key(j.get("title")) == n_title and alb.get("cover_medium"):
                        best = alb.get("cover_xl") or alb.get("cover_big") or alb.get("cover_medium")
                        break
            if not best and data:
                alb = (data[0].get("album") or {})
                best = alb.get("cover_xl") or alb.get("cover_big") or alb.get("cover_medium")
            if best:
                url = str(best)
    except Exception as e:
        log.warning("Deezer cover lookup failed: %s", e)
    _cover_cache[key] = (url, now)
    if len(_cover_cache) > 200:
        oldest = min(_cover_cache, key=lambda k: _cover_cache[k][1])
        del _cover_cache[oldest]
    return url


_spotify_token_cache: dict = {"token": "", "exp": 0.0}


def _spotify_token(client_id: str, client_secret: str, timeout: int = 8) -> str:
    """Client Credentials token (cache in-memory ±55 mnt). Kosong bila gagal."""
    import base64
    cid, sec = (client_id or "").strip(), (client_secret or "").strip()
    if not cid or not sec:
        return ""
    now = time.time()
    if _spotify_token_cache["token"] and now < _spotify_token_cache["exp"]:
        return _spotify_token_cache["token"]
    try:
        basic = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        r = requests.post("https://accounts.spotify.com/api/token",
                          data={"grant_type": "client_credentials"},
                          headers={"Authorization": f"Basic {basic}"},
                          timeout=timeout)
        if not r.ok:
            return ""
        j = r.json()
        tok = str(j.get("access_token") or "")
        if not tok:
            return ""
        _spotify_token_cache["token"] = tok
        _spotify_token_cache["exp"] = now + int(j.get("expires_in") or 3600) - 300
        return tok
    except Exception as e:
        log.warning("spotify token failed: %s", e)
        return ""


def _spotify_cover_url(artist: str, title: str, album: str = "",
                       client_id: str = "", client_secret: str = "",
                       timeout: int = 8) -> str | None:
    """Cover via Spotify Search API (butuh client id/secret). None bila gagal."""

    a, t, alb = (artist or "").strip(), (title or "").strip(), (album or "").strip()
    if not a and not t:
        return None
    key = f"sp::{a.lower()}::{t.lower()}::{alb.lower()}"
    now = time.time()
    if key in _cover_cache and now - _cover_cache[key][1] < 600:
        return _cover_cache[key][0]
    url = None
    try:
        tok = _spotify_token(client_id, client_secret, timeout)
        if not tok:
            _cover_cache[key] = (None, now)
            return None
        r = requests.get("https://api.spotify.com/v1/search",
                         params={"q": f"{a} {t}".strip()[:120],
                                 "type": "track", "limit": 5},
                         headers={"Authorization": f"Bearer {tok}"},
                         timeout=timeout)
        if r.ok:
            items = (r.json().get("tracks") or {}).get("items") or []
            n_title, n_artist = _norm_cover_key(t), _norm_cover_key(a.split(",")[0])
            best = None
            for j in items:
                anames = " ".join(x.get("name", "") for x in j.get("artists") or [])
                if (_norm_cover_key(j.get("name")) == n_title
                        and n_artist and n_artist in _norm_cover_key(anames)):
                    imgs = ((j.get("album") or {}).get("images") or [])
                    if imgs:
                        best = max(imgs, key=lambda im: im.get("height") or 0).get("url")
                        break
            if not best:
                for j in items:
                    imgs = ((j.get("album") or {}).get("images") or [])
                    if _norm_cover_key(j.get("name")) == n_title and imgs:
                        best = max(imgs, key=lambda im: im.get("height") or 0).get("url")
                        break
            if not best:
                for j in items:
                    imgs = ((j.get("album") or {}).get("images") or [])
                    if imgs:
                        best = max(imgs, key=lambda im: im.get("height") or 0).get("url")
                        break
            url = best
    except Exception as e:
        log.warning("spotify cover lookup failed: %s", e)
    _cover_cache[key] = (url, now)
    if len(_cover_cache) > 200:
        oldest = min(_cover_cache, key=lambda k: _cover_cache[k][1])
        del _cover_cache[oldest]
    return url


def _resolve_cover_bytes(track: dict) -> bytes | None:
    data = _fetch_cover_bytes(track.get("coverUrl") or "")
    if data:
        return data
    url = _spotify_cover_url(track.get("artist") or "", track.get("title") or "",
                             track.get("album") or "",
                             track.get("spotifyClientId") or "",
                             track.get("spotifyClientSecret") or "")
    if url:
        data = _fetch_cover_bytes(url)
        if data:
            return data
    url = _itunes_cover_url(track.get("artist") or "", track.get("title") or "", track.get("album") or "")
    if url:
        data = _fetch_cover_bytes(url)
        if data:
            return data
    url = _deezer_cover_url(track.get("artist") or "", track.get("title") or "", track.get("album") or "")
    return _fetch_cover_bytes(url) if url else None


def _resolve_cover_bytes_with_url(track: dict) -> tuple[bytes | None, str | None]:
    """Seperti _resolve_cover_bytes tapi ikut mengembalikan source URL (bila ada)."""
    manual = (track.get("coverUrl") or "").strip()
    if manual:
        data = _fetch_cover_bytes(manual)
        if data:
            return data, manual
    url = _spotify_cover_url(track.get("artist") or "", track.get("title") or "",
                             track.get("album") or "",
                             track.get("spotifyClientId") or "",
                             track.get("spotifyClientSecret") or "")
    if url:
        data = _fetch_cover_bytes(url)
        if data:
            return data, url
    url = _itunes_cover_url(track.get("artist") or "", track.get("title") or "", track.get("album") or "")
    if url:
        data = _fetch_cover_bytes(url)
        if data:
            return data, url
    url = _deezer_cover_url(track.get("artist") or "", track.get("title") or "", track.get("album") or "")
    if url:
        data = _fetch_cover_bytes(url)
        if data:
            return data, url
    return None, None


def _bytes_to_data_url(data: bytes) -> str | None:
    """Bungkus bytes gambar jadi data URL (fallback bila source URL tak ada)."""
    import base64
    try:
        mime = _cover_mime(data[:16]) or "image/jpeg"
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception:
        return None


COVER_DATA_MAX_BYTES = 8 * 1024 * 1024


def _decode_cover_data(data_url: str) -> bytes | None:
    """Decode data URL gambar dari frontend (drag-drop / browse file).

    Terima data:image/{jpeg,png,webp};base64,.... WebP dikonversi ke JPEG.
    Return bytes siap embed, atau None bila format/ukuran tak valid.
    """
    import base64
    try:
        s = str(data_url or "").strip()
        if not s.startswith("data:"):
            return None
        head, _, b64 = s.partition(",")
        if not b64:
            return None
        raw = base64.b64decode(b64, validate=True)
        if not raw or len(raw) > COVER_DATA_MAX_BYTES:
            return None
        mime = _cover_mime(raw[:16])
        if mime == "image/webp":
            return _to_jpeg(raw)
        if mime in ("image/jpeg", "image/png"):
            return raw
        return None
    except Exception:
        return None


def _has_cover(path: Path) -> bool:
    try:
        suf = path.suffix.lower()
        if suf == ".mp3":

            try:
                tags = ID3(str(path))
            except Exception:
                return False
            return any(k.startswith("APIC") for k in tags.keys())
        if suf == ".m4a":

            try:
                tags = MP4(str(path))
            except Exception:
                return False
            return bool(tags.tags.get("covr"))
    except Exception:
        pass
    return False


def _write_tags(path: Path, title: str, artist: str, album: str) -> bool:
    """Tulis tag title/artist/album saja (cover tidak disentuh). Gagal -> False."""
    try:
        suf = path.suffix.lower()
        if suf == ".mp3":

            try:
                tags = ID3(str(path))
            except Exception:
                tags = ID3()
            if title:
                tags.delall("TIT2")
                tags.add(TIT2(encoding=3, text=title))
            if artist:
                tags.delall("TPE1")
                tags.add(TPE1(encoding=3, text=artist))
            if album:
                tags.delall("TALB")
                tags.add(TALB(encoding=3, text=album))
            tags.save(str(path))
            return True
        if suf == ".m4a":

            mp4 = MP4(str(path))
            if mp4.tags is None:
                mp4.add_tags()
            if title:
                mp4.tags["\xa9nam"] = [title]
            if artist:
                mp4.tags["\xa9ART"] = [artist]
            if album:
                mp4.tags["\xa9alb"] = [album]
            mp4.save()
            return True
    except Exception as e:
        log.warning("write tags failed %s: %s", path.name, e)
    return False


def _embed_cover(path: Path, title: str, artist: str, album: str, cover: bytes, with_meta: bool = False) -> bool:
    """Tanam cover (+opsional title/artist/album). Gagal -> False, tidak throw."""
    try:
        mime = _cover_mime(cover[:16])
        if mime == "image/webp":
            cover = _to_jpeg(cover)
            if not cover:
                return False
            mime = "image/jpeg"
        if mime not in ("image/jpeg", "image/png"):
            return False
        suf = path.suffix.lower()
        if with_meta and not _write_tags(path, title, artist, album):
            return False
        if suf == ".mp3":

            try:
                tags = ID3(str(path))
            except Exception:
                tags = ID3()
            tags.delall("APIC")
            tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=cover))
            tags.save(str(path))
            return True
        if suf == ".m4a":

            fmt = MP4Cover.FORMAT_JPEG if mime == "image/jpeg" else MP4Cover.FORMAT_PNG
            mp4 = MP4(str(path))
            if mp4.tags is None:
                mp4.add_tags()
            mp4.tags["covr"] = [MP4Cover(cover, imageformat=fmt)]
            mp4.save()
            return True
    except Exception as e:
        log.warning("embed cover failed %s: %s", path.name, e)
    return False


def _sanitize_stem(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "_", str(s or "")).strip().strip(".")
    return s[:150] or "Unknown"


@router.get("/embed/tags")
async def embed_tags(path: str = ""):
    """Baca tag title/artist/album file utk prefill form edit."""

    p = Path(unquote(path) if "%" in path else path)
    if not p.is_file() or p.suffix.lower() not in (".mp3", ".m4a"):
        return JSONResponse({"ok": False, "error": "File tidak ditemukan"}, status_code=404)
    title, artist, album = "", "", ""
    try:
        if p.suffix.lower() == ".mp3":

            try:
                t = ID3(str(p))
                title = str((t.get("TIT2") or [None])[0] or "") if t.get("TIT2") else ""
                artist = str((t.get("TPE1") or [None])[0] or "") if t.get("TPE1") else ""
                album = str((t.get("TALB") or [None])[0] or "") if t.get("TALB") else ""
            except Exception:
                pass
        else:

            try:
                t = MP4(str(p))
                if t.tags:
                    title = str((t.tags.get("\xa9nam") or [""])[0])
                    artist = str((t.tags.get("\xa9ART") or [""])[0])
                    album = str((t.tags.get("\xa9alb") or [""])[0])
            except Exception:
                pass
    except Exception:
        pass
    if not title or not artist:
        stem = p.stem
        if " - " in stem:
            a, t = [s.strip() for s in stem.split(" - ", 1)]
            artist = artist or a
            title = title or t
        else:
            title = title or stem
    return {"ok": True, "title": title, "artist": artist or "Unknown", "album": album}


@router.post("/embed/rename")
async def embed_rename(payload: dict):
    """Edit tag + rename file lagu. Body: {path, title, artist, album}.
    Rename pola '{Artis} - {Judul}.{ext}' + suffix (1) bila tabrakan.
    Sidecar .lrc yg stem-nya sama ikut di-rename (best-effort)."""
    src = Path(str(payload.get("path") or ""))
    title = str(payload.get("title") or "").strip()
    artist = str(payload.get("artist") or "").strip()
    album = str(payload.get("album") or "").strip()
    if not title:
        return JSONResponse({"ok": False, "error": "Judul tidak boleh kosong"}, status_code=400)
    if not src.is_file() or src.suffix.lower() not in (".mp3", ".m4a"):
        return JSONResponse({"ok": False, "error": "File tidak ditemukan / format harus mp3/m4a"}, status_code=404)
    if not _write_tags(src, title, artist, album):
        return JSONResponse({"ok": False, "error": "Gagal menulis tag"}, status_code=500)
    new_stem = _sanitize_stem(f"{artist} - {title}" if artist else title)
    dst = src.parent / f"{new_stem}{src.suffix.lower()}"
    if dst.resolve() != src.resolve():
        base, i = dst.with_suffix(""), 1
        while dst.exists():
            dst = src.parent / f"{base.name} ({i}){src.suffix.lower()}"
            i += 1
            if i > 100:
                return JSONResponse({"ok": False, "error": "Terlalu banyak nama kembar"}, status_code=409)
        try:
            src.rename(dst)
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"Gagal rename: {e}"}, status_code=500)
        old_stem = src.stem
        if old_stem != dst.stem:
            for cand in (src.parent / "Lyrics" / f"{old_stem}.lrc", src.parent / f"{old_stem}.lrc"):
                try:
                    if cand.is_file():
                        target = cand.parent / f"{dst.stem}.lrc"
                        if not target.exists():
                            cand.rename(target)
                except Exception:
                    pass
    else:
        dst = src
    return {"ok": True, "oldPath": str(src), "newPath": str(dst),
            "title": title, "artist": artist or "Unknown", "album": album}


async def _invalidate_cover_cache(artist: str, title: str, album: str = ""):
    """Hapus cache cover untuk track ini (biar resolve berikutnya fresh)."""
    a, t, alb = (artist or "").strip().lower(), (title or "").strip().lower(), (album or "").strip().lower()
    keys_to_del = [k for k in _cover_cache.keys()
                   if k.startswith(f"{a}::{t}::") or k.startswith(f"dz::{a}::{t}::")]
    for k in keys_to_del:
        _cover_cache.pop(k, None)


@router.post("/embed/cover")
async def embed_cover(payload: dict):
    """Update cover single file.
    Body: {path, coverUrl?, coverData?, autoResolve: true, artist?, title?, album?,
           spotifyClientId?, spotifyClientSecret?}
    - coverData: data URL gambar (drag-drop / browse file, maks ~8MB).
      Prioritas tertinggi — mengalahkan coverUrl & autoResolve.
    - coverUrl: URL manual ke gambar (jpg/png). Jika diisi -> fetch & embed langsung.
    - autoResolve: true (default) -> resolve via Spotify (bila ada
      kredensial) -> iTunes -> Deezer jika coverUrl kosong.
    - artist/title/album: dipakai untuk autoResolve (jika tidak diisi, ambil dari tag file).
    """


    src = Path(str(payload.get("path") or ""))
    if not src.is_file() or src.suffix.lower() not in (".mp3", ".m4a"):
        return JSONResponse({"ok": False, "error": "File tidak ditemukan / format harus mp3/m4a"}, status_code=404)

    cover_url = str(payload.get("coverUrl") or "").strip()
    auto_resolve = payload.get("autoResolve", True)

    existing_title = str(payload.get("title") or "").strip()
    existing_artist = str(payload.get("artist") or "").strip()
    existing_album = str(payload.get("album") or "").strip()

    if not (existing_title and existing_artist):
        try:
            if src.suffix.lower() == ".mp3":
    
                tags = ID3(str(src))
                existing_title = existing_title or str((tags.get("TIT2") or [None])[0] or "")
                existing_artist = existing_artist or str((tags.get("TPE1") or [None])[0] or "")
                existing_album = existing_album or str((tags.get("TALB") or [None])[0] or "")
            else:
    
                tags = MP4(str(src))
                existing_title = existing_title or str(tags.tags.get("\xa9nam", [""])[0] or "")
                existing_artist = existing_artist or str(tags.tags.get("\xa9ART", [""])[0] or "")
                existing_album = existing_album or str(tags.tags.get("\xa9alb", [""])[0] or "")
        except Exception:
            pass

    cover_bytes = None
    final_cover_url = None

    cover_data = str(payload.get("coverData") or "").strip()
    if cover_data:
        cover_bytes = _decode_cover_data(cover_data)
        if cover_bytes:
            final_cover_url = "embedded"
        else:
            return JSONResponse({"ok": False, "error": "File gambar tak valid (jpg/png/webp, maks 8MB)"}, status_code=400)
    elif cover_url:
        cover_bytes = _fetch_cover_bytes(cover_url)
        if cover_bytes:
            final_cover_url = cover_url
        else:
            return JSONResponse({"ok": False, "error": "Gagal fetch cover dari URL manual"}, status_code=400)
    elif auto_resolve:
        track_info = {"artist": existing_artist, "title": existing_title, "album": existing_album, "coverUrl": "",
                      "spotifyClientId": str(payload.get("spotifyClientId") or ""),
                      "spotifyClientSecret": str(payload.get("spotifyClientSecret") or "")}
        cover_bytes, resolved_url = _resolve_cover_bytes_with_url(track_info)
        if cover_bytes:
            final_cover_url = resolved_url or _bytes_to_data_url(cover_bytes)

    if not cover_bytes:
        return JSONResponse({"ok": False, "error": "Cover tidak ditemukan (auto-resolve gagal, coba isi manual coverUrl)"}, status_code=404)

    ok = _embed_cover(src, existing_title, existing_artist, existing_album, cover_bytes, with_meta=False)
    if not ok:
        return JSONResponse({"ok": False, "error": "Gagal menanam cover"}, status_code=500)

    await _invalidate_cover_cache(existing_artist, existing_title, existing_album)

    return {"ok": True, "path": str(src), "coverUrl": final_cover_url}


@router.delete("/embed/cover")
async def embed_cover_delete(payload: dict):
    """Hapus embedded cover art dari file (strip APIC/covr), tag lain tetap."""


    src = Path(str(payload.get("path") or ""))
    if not src.is_file() or src.suffix.lower() not in (".mp3", ".m4a"):
        return JSONResponse({"ok": False, "error": "File tidak ditemukan / format harus mp3/m4a"}, status_code=404)

    try:
        if src.suffix.lower() == ".mp3":

            tags = ID3(str(src))
            tags.delall("APIC")
            tags.save(str(src))
        else:

            tags = MP4(str(src))
            if tags.tags and "covr" in tags.tags:
                del tags.tags["covr"]
                tags.save()
        artist = title = album = ""
        try:
            if src.suffix.lower() == ".mp3":
    
                tags = ID3(str(src))
                artist = str((tags.get("TPE1") or [None])[0] or "")
                title = str((tags.get("TIT2") or [None])[0] or "")
                album = str((tags.get("TALB") or [None])[0] or "")
            else:
    
                tags = MP4(str(src))
                artist = str(tags.tags.get("\xa9ART", [""])[0] or "")
                title = str(tags.tags.get("\xa9nam", [""])[0] or "")
                album = str(tags.tags.get("\xa9alb", [""])[0] or "")
        except Exception:
            pass
        await _invalidate_cover_cache(artist, title, album)

        return {"ok": True, "path": str(src)}
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"Gagal hapus cover: {e}"}, status_code=500)
