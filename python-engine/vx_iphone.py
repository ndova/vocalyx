"""VocaLyx engine - iPhone music export + import via AFC (Apple File Conduit).

Export: stream tracks from iPhone to PC.
Import: add tracks to iPhone Music app via DB replacement.
"""
import asyncio
import os
import sqlite3
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response, StreamingResponse

from vx_core import log

router = APIRouter()

_iph_cover_cache: dict = {}


def _iph_cover_invalidate(item_pid) -> None:
    try:
        _iph_cover_cache.pop(int(item_pid), None)
    except Exception:
        pass


def _extract_embedded_cover(path: Path):
    """Largest embedded picture from a local temp audio copy -> (bytes, mime)|None."""
    try:
        suf = path.suffix.lower()
        if suf == ".mp3":
            from mutagen.id3 import ID3
            try:
                tags = ID3(str(path))
            except Exception:
                return None
            best = None
            for k in tags.keys():
                if k.startswith("APIC"):
                    apic = tags[k]
                    if getattr(apic, "type", None) == 3 or best is None:
                        best = apic
                        if getattr(apic, "type", None) == 3:
                            break
            if best is None:
                return None
            data = bytes(best.data)
            mime = best.mime or "image/jpeg"
            return data, mime
        if suf in (".m4a", ".mp4", ".aac"):
            from mutagen.mp4 import MP4, MP4Cover
            try:
                mp4 = MP4(str(path))
            except Exception:
                return None
            if not mp4.tags:
                return None
            covers = mp4.tags.get("covr") or []
            if not covers:
                return None
            c = covers[0]
            data = bytes(c)
            fmt = getattr(c, "imageformat", None)
            mime = "image/png" if fmt == MP4Cover.FORMAT_PNG else "image/jpeg"
            return data, mime
    except Exception as e:
        log.warning("extract embedded cover fail: %s", e)
    return None


def _iph_cover_thumb(data: bytes, mime: str):
    """Downscale cover to <=300px JPEG for the Device list; fall back raw."""
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        if img.mode in ("RGBA", "LA", "PA"):
            bg = Image.new("RGB", img.size, (0, 0, 0))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail((300, 300))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=82)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        return data, (mime or "image/jpeg")



async def _get_iphone_library_count() -> dict:
    """Count iPhone music via AFC listdir F00..F50 + MediaLibrary.sqlitedb."""
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService
        lockdown = await _open_lockdown()
        async with AfcService(lockdown) as afc:
            count = 0
            for folder in [f"F{i:02d}" for i in range(100)]:
                try:
                    files = await afc.listdir(f"/iTunes_Control/Music/{folder}")
                    count += len([f for f in files if f not in (".", "..")])
                except Exception:
                    pass
            try:
                db_data = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb')
                tmp = tempfile.mktemp(suffix='.db')
                open(tmp, 'wb').write(db_data)
                try:
                    wal = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-wal')
                    open(tmp + '-wal', 'wb').write(wal)
                    shm = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-shm')
                    open(tmp + '-shm', 'wb').write(shm)
                except Exception:
                    pass
                conn = sqlite3.connect(tmp)
                cur = conn.cursor()
                cur.execute("SELECT COUNT(*) FROM item WHERE media_type=8")
                db_count = cur.fetchone()[0]
                conn.close()
                try:
                    os.remove(tmp)
                    os.remove(tmp + '-wal')
                    os.remove(tmp + '-shm')
                except Exception:
                    pass
                return {"file_count": count, "library_count": db_count}
            except Exception:
                return {"file_count": count, "library_count": 0}
    except Exception as e:
        log.warning("iPhone library count fail: %s", e)
        return {"file_count": 0, "library_count": 0}
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass


def _sanitize_filename(name: str) -> str:
    """Make a string safe for use as a filename."""
    return "".join(c for c in name if c.isalnum() or c in (" ", "-", "_")).strip() or "track"


_USBMUXD_TTL = 10.0
_usbmuxd_cache: dict = {"at": -1.0, "ok": False}


def _probe_usbmuxd(timeout: float) -> bool:
    import socket
    for _ in range(2):
        try:
            with socket.create_connection(("127.0.0.1", 27015), timeout=timeout):
                return True
        except Exception:
            continue
    return False


def usbmuxd_reachable(timeout: float = 0.6) -> bool:
    """True kalau service Apple Mobile Device (usbmuxd) grudup di 127.0.0.1:27015.

    pymobiledevice3 bicara lewat usbmux, jadi tanpa service itu iPhone yang
    tertancap tetap tidak bisa dibaca. Cek ini murni socket dan tidak butuh
    pymobiledevice3 terpasang, jadi aman dipakai untuk pesan prasyarat.

    Hasil di-cache sebentar: probe ini blocking (2x connect dengan timeout),
    sedangkan frontend meny polls endpoint ini secara berkala. Tanpa cache,
    tiap panggilan menahan event loop asyncio FastAPI.
    """
    now = time.monotonic()
    if _usbmuxd_cache["at"] >= 0 and (now - _usbmuxd_cache["at"]) < _USBMUXD_TTL:
        return _usbmuxd_cache["ok"]
    ok = _probe_usbmuxd(timeout)
    _usbmuxd_cache["at"] = now
    _usbmuxd_cache["ok"] = ok
    return ok


async def usbmuxd_reachable_async(timeout: float = 0.6) -> bool:
    """usbmuxd_reachable() tanpa memblokir event loop."""
    return await asyncio.to_thread(usbmuxd_reachable, timeout)


async def usbmuxd_reachable_fresh(timeout: float = 0.6) -> bool:
    """Probe segar tanpa cache (untuk retry sebelum menyerah).

    Cache 10 detik di atas bisa basi tepat saat user mencolokkan iPhone /
    service Apple baru start: `iphone_devices` akan membalas driver-missing
    padahal service sudah jalan. Fungsi ini memaksa probe baru dan
    memperbarui cache, dipakai maksimal sekali per request gagal.
    """
    ok = await asyncio.to_thread(_probe_usbmuxd, timeout)
    _usbmuxd_cache["at"] = time.monotonic()
    _usbmuxd_cache["ok"] = ok
    return ok


def _apple_driver_error() -> dict:
    """Bentuk respons ketika driver Apple tidak ada."""
    return {
        "ok": False,
        "code": "ERR_APPLE_DRIVER_MISSING",
        "error": "Apple Mobile Device Support tidak terpasang (service usbmuxd tidak merespons)",
        "hint": "Pasang iTunes for Windows / Apple Devices dari Apple, jalankan sebagai administrator, "
                "sambungkan iPhone via kabel data USB, buka kunci layar, lalu ketuk Trust.",
        "devices": [],
    }


def _classify_iphone_error(exc: BaseException) -> tuple:
    """Petakan exception pymobiledevice3/usbmux ke (code, hint).

    Frontend memakai `code` untuk menampilkan pesan yang bisa ditindaklanjuti
    (buka kunci / ketuk Trust / ganti kabel), bukan sekadar "tidak terhubung".
    """
    name = type(exc).__name__ or ""
    msg = str(exc) or name
    low = f"{name} {msg}".lower()
    if "notpaired" in low.replace("_", "") or "not paired" in low:
        return ("ERR_NOT_TRUSTED",
                "iPhone belum di-trust: buka kunci iPhone, cabut-colok kabel USB, lalu ketuk Trust saat dialog muncul.")
    if "pair" in low and ("trust" in low or "accept" in low or "dialog" in low or "timeout" in low):
        return ("ERR_NOT_TRUSTED",
                "Pairing belum disetujui: ketuk Trust di iPhone (buka kunci dulu), lalu Refresh.")
    if "locked" in low or "passcode" in low:
        return ("ERR_DEVICE_LOCKED",
                "iPhone terkunci: masukkan passcode / buka kunci layar, biarkan menyala, lalu Refresh.")
    if ("no device" in low or "no mux device" in low or "device not found" in low
            or "no device found" in low or "empty" in low and "device" in low):
        return ("ERR_NO_DEVICE",
                "Tidak ada iPhone di usbmux: pakai kabel DATA USB (bukan kabel cas saja), "
                "colok langsung ke PC (bukan hub), lalu ketuk Trust.")
    if "usbmux" in low or "mux" in low or "connection refused" in low or "winerror" in low:
        return ("ERR_USBMUX",
                "Service Apple (usbmuxd) tidak merespons: pastikan Apple Mobile Device Service berjalan, "
                "jalankan VocaLyx sebagai administrator, lalu colok ulang iPhone.")
    return ("ERR_IPHONE", msg)


def _mask_serial(serial: str) -> str:
    s = str(serial or "")
    if len(s) <= 8:
        return (s[:2] + "…" + s[-2:]) if len(s) > 4 else "…"
    return s[:4] + "…" + s[-4:]


async def _mux_devices_snapshot(timeout: float = 10.0) -> list:
    """Daftar device yang terlihat usbmux (USB didahulukan). Tak pernah melempar."""
    try:
        from pymobiledevice3 import usbmux
        devs = await asyncio.wait_for(usbmux.list_devices(), timeout)
        return sorted(list(devs or []), key=lambda d: (0 if getattr(d, "is_usb", False) else 1,
                                                      getattr(d, "devid", 0)))
    except Exception as e:
        log.debug("mux list_devices: %s", e)
        return []


async def _open_lockdown(timeout: float = 90.0):
    """Buka lockdown ke iPhone, preferensi USB.

    `create_using_usbmux()` tanpa serial mengambil device pertama apa adanya —
    itu bisa device Network (WiFi sync) yang stale, sehingga iPhone yang
    tertancap USB tetap "tidak bisa konek". Di sini daftar usbmux dibaca dulu,
    USB dicoba lebih dulu per serial, baru fallback ke perilaku default bila
    daftar gagal dibaca.
    """
    from pymobiledevice3 import usbmux
    from pymobiledevice3.lockdown import create_using_usbmux
    try:
        devs = await asyncio.wait_for(usbmux.list_devices(), 10)
    except Exception:
        devs = []
    ordered = sorted(list(devs or []), key=lambda d: (0 if getattr(d, "is_usb", False) else 1,
                                                     getattr(d, "devid", 0)))
    if ordered:
        last = None
        for md in ordered:
            try:
                return await asyncio.wait_for(
                    create_using_usbmux(serial=getattr(md, "serial", None)), timeout)
            except Exception as e:
                last = e
                continue
        if last is not None:
            raise last
    return await asyncio.wait_for(create_using_usbmux(), timeout)



@router.get("/iphone/devices")
async def iphone_devices():
    """List connected iPhones (USB didahulukan, error terkode untuk UI)."""
    if not await usbmuxd_reachable_async():
        if not await usbmuxd_reachable_fresh():
            return _apple_driver_error()
    mux = await _mux_devices_snapshot()
    if not mux:
        # usbmux jalan tapi tak ada device: bukan error driver, melainkan
        # kabel/belum trust/belum unlock. Kembalikan ok=True + devices kosong
        # supaya frontend menampilkan hint kabel, bukan panduan install driver.
        return {"ok": True, "devices": [], "code": "ERR_NO_DEVICE",
                "error": "tidak ada iPhone di usbmux",
                "hint": "Tidak ada iPhone terdeteksi: pakai kabel DATA USB, colok langsung ke PC, "
                        "buka kunci layar, lalu ketuk Trust."}
    devices = []
    last_code, last_err = "ERR_NO_DEVICE", "tidak ada device yang bisa dibuka"
    for md in mux:
        lockdown = None
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            lockdown = await asyncio.wait_for(
                create_using_usbmux(serial=getattr(md, "serial", None)), 60)
            info = {
                "name": lockdown.display_name,
                "ios": lockdown.product_version,
                "identifier": lockdown.identifier or "",
                "model": lockdown.product_type or "",
                "connection_type": getattr(md, "connection_type", ""),
                "serial": getattr(md, "serial", ""),
            }
            devices.append(info)
        except Exception as e:
            last_code, hint = _classify_iphone_error(e)
            last_err = str(e) or last_code
            log.warning("iphone device %s fail: %s", _mask_serial(getattr(md, "serial", "")), e)
        finally:
            if lockdown:
                try:
                    await lockdown.close()
                except Exception:
                    pass
    if devices:
        return {"ok": True, "devices": devices, "code": ""}
    _, hint = _classify_iphone_error(Exception(last_err))
    return {"ok": False, "code": last_code, "error": last_err, "hint": hint, "devices": [],
            "mux": [{"serial": _mask_serial(getattr(m, "serial", "")),
                     "connection_type": getattr(m, "connection_type", "")} for m in mux]}


@router.get("/iphone/diagnose")
async def iphone_diagnose():
    """Diagnostik koneksi iPhone untuk UI / salin-info (tanpa data sensitif)."""
    mux_ok = await usbmuxd_reachable_async()
    mux = await _mux_devices_snapshot() if mux_ok else []
    out = {
        "ok": True,
        "usbmux_reachable": mux_ok,
        "port": 27015,
        "mux_count": len(mux),
        "mux": [{"serial": _mask_serial(getattr(m, "serial", "")),
                 "connection_type": getattr(m, "connection_type", ""),
                 "usb": bool(getattr(m, "is_usb", False))} for m in mux],
        "code": "" if (mux_ok and mux) else ("ERR_APPLE_DRIVER_MISSING" if not mux_ok else "ERR_NO_DEVICE"),
        "hint": "",
    }
    if not mux_ok:
        out["hint"] = "Service Apple tidak merespons di 127.0.0.1:27015. Pasang iTunes/Apple Devices, " \
                      "jalankan VocaLyx sebagai administrator, pastikan Apple Mobile Device Service berjalan."
        return out
    if not mux:
        out["hint"] = "usbmux jalan tapi iPhone tak terlihat. Ganti kabel data USB, colok langsung ke PC, " \
                      "buka kunci layar, ketuk Trust."
        return out
    lockdown = None
    try:
        lockdown = await _open_lockdown(timeout=60)
        out["lockdown"] = {"name": lockdown.display_name, "ios": lockdown.product_version,
                           "model": lockdown.product_type or ""}
    except Exception as e:
        code, hint = _classify_iphone_error(e)
        out["code"], out["error"], out["hint"] = code, str(e) or code, hint
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass
    return out


@router.get("/iphone/driver")
async def iphone_driver():
    """Status prasyarat driver Apple (untuk UI menampilkan panduan)."""
    ready = await usbmuxd_reachable_async()
    return {
        "ok": True,
        "ready": ready,
        "code": "" if ready else "ERR_APPLE_DRIVER_MISSING",
        "port": 27015,
    }


@router.get("/iphone/library")
async def iphone_library():
    """Count iPhone music library."""
    res = await _get_iphone_library_count()
    return {"ok": True, **res}


@router.get("/iphone/library/tracks")
async def iphone_library_tracks(limit: int = 200, offset: int = 0):
    """List iPhone music tracks from MediaLibrary."""
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService
        lockdown = await _open_lockdown()
        async with AfcService(lockdown) as afc:
            data = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb')
            tmp = tempfile.mktemp(suffix='.db')
            open(tmp, 'wb').write(data)
            try:
                wal = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-wal')
                open(tmp + '-wal', 'wb').write(wal)
                shm = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-shm')
                open(tmp + '-shm', 'wb').write(shm)
            except Exception:
                pass
            conn = sqlite3.connect(tmp)
            cur = conn.cursor()
            cur.execute("""
                SELECT item.item_pid, item_extra.title, item_artist.item_artist, album.album,
                       item_extra.total_time_ms, item_extra.file_size, item_extra.location, base_location.path
                FROM item
                JOIN item_extra ON item.item_pid=item_extra.item_pid
                LEFT JOIN item_artist ON item.item_artist_pid=item_artist.item_artist_pid
                LEFT JOIN album ON item.album_pid=album.album_pid
                LEFT JOIN base_location ON item.base_location_id=base_location.base_location_id
                WHERE item.media_type=8
                ORDER BY item_extra.title COLLATE NOCASE
                LIMIT ? OFFSET ?
            """, (limit, offset))
            rows = cur.fetchall()
            tracks = []
            for r in rows:
                pid, title, artist, album, tms, fsize, loc, base = r
                full = f"/{base}/{loc}" if base and loc else ""
                tracks.append({
                    "item_pid": pid, "title": title, "artist": artist, "album": album,
                    "duration_ms": int(tms or 0), "file_size": int(fsize or 0),
                    "location": loc, "base_path": base, "full_path": full,
                })
            conn.close()
            try:
                os.remove(tmp)
                os.remove(tmp + '-wal')
                os.remove(tmp + '-shm')
            except Exception:
                pass
        return {"ok": True, "tracks": tracks, "total": len(tracks)}
    except Exception as e:
        log.error("library tracks fail: %s", e, exc_info=True)
        return {"ok": False, "error": str(e), "tracks": []}
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass


@router.get("/iphone/track/cover")
async def iphone_track_cover(item_pid: int = 0):
    """Embedded cover art for one iPhone track -> image bytes (Device UI thumbnail).

    AFC-fetches the audio file, extracts the largest embedded picture
    (mutagen), downscales to <=300px JPEG, and caches by item_pid +
    file_size so list lazy-loads stay cheap after the first hit.
    """
    if not item_pid:
        return JSONResponse({"ok": False, "error": "item_pid required"}, status_code=400)
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService
        lockdown = await _open_lockdown(timeout=90)
        async with AfcService(lockdown) as afc:
            tmp = await _pull_media_db(afc)
            conn = sqlite3.connect(tmp)
            cur = conn.cursor()
            cur.execute("""
                SELECT item_extra.location, base_location.path, item_extra.file_size
                FROM item_extra
                JOIN item ON item_extra.item_pid=item.item_pid
                JOIN base_location ON item.base_location_id=base_location.base_location_id
                WHERE item_extra.item_pid=?
            """, (item_pid,))
            row = cur.fetchone()
            conn.close()
            try:
                os.remove(tmp)
                os.remove(tmp + '-wal')
                os.remove(tmp + '-shm')
            except Exception:
                pass
            if not row or not row[0] or not row[1]:
                return JSONResponse({"ok": False, "error": "track file not found"}, status_code=404)
            loc, base, fsize = row
            full_path = f"/{base}/{loc}"
            ver = f"{int(fsize or 0)}"
            hit = _iph_cover_cache.get(item_pid)
            if hit and hit.get("ver") == ver:
                return Response(content=hit["data"], media_type=hit["mime"],
                                headers={"Cache-Control": "private, max-age=3600",
                                         "X-Item-Pid": str(item_pid)})
            ext = ('.' + loc.rsplit('.', 1)[-1].lower()) if '.' in loc else ''
            if ext not in ('.m4a', '.mp3', '.mp4', '.aac'):
                return JSONResponse({"ok": False, "error": "unsupported type"}, status_code=415)
            data = await asyncio.wait_for(afc.get_file_contents(full_path), 180)
            fd, tmp_audio = tempfile.mkstemp(suffix=ext)
            try:
                os.close(fd)
                open(tmp_audio, 'wb').write(data)
                found = _extract_embedded_cover(Path(tmp_audio))
            finally:
                try:
                    os.remove(tmp_audio)
                except Exception:
                    pass
            if not found:
                return JSONResponse({"ok": False, "error": "no cover"}, status_code=404)
            raw, mime = found
            thumb, tmime = _iph_cover_thumb(raw, mime)
            if len(_iph_cover_cache) > 256:
                _iph_cover_cache.clear()
            _iph_cover_cache[item_pid] = {"ver": ver, "mime": tmime, "data": thumb}
            return Response(content=thumb, media_type=tmime,
                            headers={"Cache-Control": "private, max-age=3600",
                                     "X-Item-Pid": str(item_pid)})
    except Exception as e:
        log.error("iphone track cover fail: %s", e, exc_info=True)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass


@router.get("/iphone/artwork/debug")
async def iphone_artwork_debug(item_pid: int = 0):
    """Compare artwork store rows for one track (or source_type census).

    Body/query: item_pid optional. Returns schema, source_type histogram,
    and for the given pid: item/album/best/token/artwork join + file exists.
    """
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService
        lockdown = await _open_lockdown(timeout=90)
        async with AfcService(lockdown) as afc:
            tmp = await _pull_media_db(afc)
            conn = sqlite3.connect(tmp)
            conn.row_factory = sqlite3.Row
            out = {"ok": True, "item_pid": item_pid}
            try:
                out["schema"] = {
                    "artwork": _table_cols(conn, "artwork"),
                    "artwork_token": _table_cols(conn, "artwork_token"),
                    "best_artwork_token": _table_cols(conn, "best_artwork_token"),
                }
                out["source_type_hist"] = [dict(r) for r in conn.execute(
                    "SELECT artwork_source_type, COUNT(*) AS n FROM artwork"
                    " GROUP BY 1").fetchall()]
                out["detected_source_type"] = _detect_artwork_source_type(conn)
                if item_pid:
                    def _rows(sql, args=()):
                        return [dict(r) for r in conn.execute(sql, args).fetchall()]
                    out["item"] = _rows(
                        "SELECT i.item_pid, i.album_pid, i.title, e.title AS xtitle,"
                        " a.representative_item_pid FROM item i"
                        " LEFT JOIN item_extra e USING (item_pid)"
                        " LEFT JOIN album a USING (album_pid)"
                        " WHERE i.item_pid=?", (item_pid,))
                    out["artwork_token"] = _rows(
                        "SELECT * FROM artwork_token WHERE entity_pid=?"
                        " OR entity_pid=(SELECT album_pid FROM item WHERE item_pid=?)",
                        (item_pid, item_pid))
                    out["best_artwork_token"] = _rows(
                        "SELECT * FROM best_artwork_token WHERE entity_pid=?"
                        " OR entity_pid=(SELECT album_pid FROM item WHERE item_pid=?)",
                        (item_pid, item_pid))
                    out["artwork"] = _rows(
                        "SELECT w.* FROM artwork w"
                        " JOIN artwork_token t ON t.artwork_token=w.artwork_token"
                        " WHERE t.entity_pid=?"
                        " OR t.entity_pid=(SELECT album_pid FROM item WHERE item_pid=?)",
                        (item_pid, item_pid))
                    files = []
                    for r in out["artwork"]:
                        rp = None
                        for k, v in r.items():
                            if isinstance(v, str) and "/" in v:
                                rp = v
                                break
                        if not rp:
                            continue
                        remote = f"/iTunes_Control/iTunes/Artwork/Originals/{rp}"
                        try:
                            ex = await asyncio.wait_for(afc.exists(remote), 20)
                        except Exception as e:
                            ex = f"err:{e}"
                        files.append({"relative_path": rp, "remote": remote, "exists": ex})
                    out["files"] = files
                try:
                    caches = await asyncio.wait_for(
                        afc.listdir("/iTunes_Control/iTunes/Artwork/Caches"), 20)
                    out["cache_count"] = len([c for c in caches if c not in (".", "..")])
                except Exception as e:
                    out["cache_count"] = f"err:{e}"
            finally:
                conn.close()
                try:
                    os.remove(tmp)
                    os.remove(tmp + '-wal')
                    os.remove(tmp + '-shm')
                except Exception:
                    pass
            return out
    except Exception as e:
        log.error("artwork debug fail: %s", e, exc_info=True)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass


@router.get("/iphone/export")
async def iphone_export(item_pid: int = 0):
    """Export a single iPhone track file via AFC. Streams file bytes."""
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService
        lockdown = await _open_lockdown()
        async with AfcService(lockdown) as afc:
            full_path = None
            title = "track"
            if item_pid:
                data = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb')
                tmp = tempfile.mktemp(suffix='.db')
                open(tmp, 'wb').write(data)
                try:
                    wal = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-wal')
                    open(tmp + '-wal', 'wb').write(wal)
                    shm = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-shm')
                    open(tmp + '-shm', 'wb').write(shm)
                except Exception:
                    pass
                conn = sqlite3.connect(tmp)
                cur = conn.cursor()
                cur.execute("""
                    SELECT item_extra.title, item_extra.location, base_location.path
                    FROM item_extra
                    JOIN item ON item_extra.item_pid=item.item_pid
                    JOIN base_location ON item.base_location_id=base_location.base_location_id
                    WHERE item_extra.item_pid=?
                """, (item_pid,))
                row = cur.fetchone()
                conn.close()
                try:
                    os.remove(tmp)
                    os.remove(tmp + '-wal')
                    os.remove(tmp + '-shm')
                except Exception:
                    pass
                if row:
                    title, loc, base = row
                    full_path = f"/{base}/{loc}" if base and loc else None
            if not full_path:
                return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
            file_data = await afc.get_file_contents(full_path)
        safe = _sanitize_filename(title or "track")
        ext = full_path.split(".")[-1] if "." in full_path else "m4a"
        filename = f"{safe}.{ext}"
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        return StreamingResponse(iter([file_data]), media_type="application/octet-stream", headers=headers)
    except Exception as e:
        log.error("export fail: %s", e, exc_info=True)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass



_iphone_export_jobs: dict = {}


@router.post("/iphone/export_batch")
async def iphone_export_batch(payload: dict):
    """Batch export tracks from iPhone to a local directory.
    Body: { "pids": [int, ...], "output_dir": "/path/to/dir" }
    """
    pids = payload.get("pids", [])
    output_dir = payload.get("output_dir", "")
    if not pids:
        return JSONResponse({"ok": False, "error": "no pids"}, status_code=400)
    if not output_dir:
        return JSONResponse({"ok": False, "error": "output_dir required"}, status_code=400)
    if not os.path.isdir(output_dir):
        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"cannot create dir: {e}"}, status_code=400)

    job_id = f"exp_{int(time.time() * 1000)}"
    _iphone_export_jobs[job_id] = {
        "status": "running", "total": len(pids), "done": 0,
        "current": "", "results": [], "output_dir": output_dir,
    }
    asyncio.create_task(_run_export_batch(job_id, pids, output_dir))
    return {"ok": True, "job_id": job_id}


async def _run_export_batch(job_id: str, pids: list, output_dir: str):
    """Background task: export each pid sequentially."""
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService

        lockdown = await _open_lockdown()
        async with AfcService(lockdown) as afc:
            data = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb')
            tmp = tempfile.mktemp(suffix='.db')
            open(tmp, 'wb').write(data)
            try:
                wal = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-wal')
                open(tmp + '-wal', 'wb').write(wal)
                shm = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb-shm')
                open(tmp + '-shm', 'wb').write(shm)
            except Exception:
                pass
            conn = sqlite3.connect(tmp)
            cur = conn.cursor()

            for i, pid in enumerate(pids):
                job = _iphone_export_jobs.get(job_id, {})
                if job.get("status") == "cancelled":
                    log.info("Export batch cancelled at %d/%d", i, len(pids))
                    break
                try:
                    cur.execute("""
                        SELECT item_extra.title, item_extra.location, base_location.path
                        FROM item_extra
                        JOIN item ON item_extra.item_pid=item.item_pid
                        JOIN base_location ON item.base_location_id=base_location.base_location_id
                        WHERE item_extra.item_pid=?
                    """, (pid,))
                    row = cur.fetchone()
                    if not row or not row[1] or not row[2]:
                        _iphone_export_jobs[job_id]["results"].append({"pid": pid, "ok": False, "error": "not found"})
                        _iphone_export_jobs[job_id]["done"] = i + 1
                        continue

                    title, loc, base = row
                    full_path = f"/{base}/{loc}"
                    _iphone_export_jobs[job_id]["current"] = title or f"pid={pid}"

                    file_data = await afc.get_file_contents(full_path)

                    safe = _sanitize_filename(title or f"track_{pid}")
                    ext = loc.split(".")[-1] if "." in loc else "m4a"
                    out_path = os.path.join(output_dir, f"{safe}.{ext}")

                    if os.path.exists(out_path):
                        for cnt in range(1, 100):
                            out_path = os.path.join(output_dir, f"{safe} ({cnt}).{ext}")
                            if not os.path.exists(out_path):
                                break

                    open(out_path, 'wb').write(file_data)
                    _iphone_export_jobs[job_id]["results"].append({
                        "pid": pid, "ok": True, "path": out_path, "size": len(file_data),
                    })
                except Exception as e:
                    log.error("export pid %s fail: %s", pid, e, exc_info=True)
                    _iphone_export_jobs[job_id]["results"].append({"pid": pid, "ok": False, "error": str(e)})

                _iphone_export_jobs[job_id]["done"] = i + 1

            conn.close()
            try:
                os.remove(tmp)
                os.remove(tmp + '-wal')
                os.remove(tmp + '-shm')
            except Exception:
                pass
    except Exception as e:
        log.error("batch export fail: %s", e, exc_info=True)
        _iphone_export_jobs[job_id]["status"] = "error"
        _iphone_export_jobs[job_id]["error"] = str(e)
        return
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass

    job = _iphone_export_jobs.get(job_id, {})
    if job.get("status") != "cancelled":
        job["status"] = "done"
    job["current"] = ""


@router.get("/iphone/export_progress")
async def iphone_export_progress(job_id: str = ""):
    """Get export progress."""
    if not job_id:
        return {"ok": False, "error": "job_id required"}
    job = _iphone_export_jobs.get(job_id)
    if not job:
        return {"ok": False, "error": "job not found"}
    total = job.get("total", 1)
    done = job.get("done", 0)
    pct = int(done / total * 100) if total else 0
    return {
        "ok": True, "status": job.get("status", "running"),
        "total": total, "done": done, "pct": pct,
        "current": job.get("current", ""),
        "results": job.get("results", []),
        "error": job.get("error", ""),
    }


@router.post("/iphone/export_cancel")
async def iphone_export_cancel(payload: dict):
    """Cancel a running export job."""
    job_id = payload.get("job_id", "")
    job = _iphone_export_jobs.get(job_id)
    if job:
        job["status"] = "cancelled"
    return {"ok": True}


@router.delete("/iphone/track")
async def iphone_delete(item_pid: int = 0):
    """Delete iPhone track by item_pid (file + DB)."""
    if not item_pid:
        return JSONResponse({"ok": False, "error": "item_pid required"}, status_code=400)
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService
        lockdown = await _open_lockdown()
        async with AfcService(lockdown) as afc:
            data = await afc.get_file_contents('/iTunes_Control/iTunes/MediaLibrary.sqlitedb')
            tmp = await _pull_media_db(afc)
            conn = sqlite3.connect(tmp)
            cur = conn.cursor()
            cur.execute("""
                SELECT location, base_location.path
                FROM item_extra
                JOIN item ON item_extra.item_pid=item.item_pid
                JOIN base_location ON item.base_location_id=base_location.base_location_id
                WHERE item_extra.item_pid=?
            """, (item_pid,))
            row = cur.fetchone()
            full = None
            if row:
                loc, base = row
                full = f"/{base}/{loc}" if base and loc else None

            cur.execute("DELETE FROM item_extra WHERE item_pid=?", (item_pid,))
            cur.execute("DELETE FROM item WHERE item_pid=?", (item_pid,))
            for tbl in ["item_stats", "item_playback", "item_search",
                        "item_video", "lyrics", "item_store", "item_state",
                        "container_item"]:
                try:
                    cur.execute(f"DELETE FROM {tbl} WHERE item_pid=?", (item_pid,))
                except Exception:
                    pass
            _clear_artwork_rows(conn, item_pid)
            conn.commit()
            try:
                cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
            conn.close()

            await _push_media_db(afc, tmp)
            try:
                os.remove(tmp)
                os.remove(tmp + '-wal')
                os.remove(tmp + '-shm')
            except Exception:
                pass

            if full:
                try:
                    await afc.rm(full)
                    log.info("Deleted file %s", full)
                except Exception as e:
                    log.warning("rm file fail %s: %s", full, e)
        _iph_cover_invalidate(item_pid)
        return {"ok": True}
    except Exception as e:
        log.error("delete fail: %s", e, exc_info=True)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass



@router.post("/iphone/track/cover")
async def iphone_track_cover(payload: dict):
    """Manage embedded cover art of a single iPhone track (device file).

    Body: { "item_pid": int, "mode": "auto" | "url" | "remove",
            "coverUrl": "..." (mode=url),
            "title"/"artist"/"album": overrides for auto-resolve }
    Only m4a/mp3. Nothing is uploaded unless the temp copy validates.
    On success item_extra.file_size/date_modified are synced.
    """
    from vx_cover import (_decode_cover_data, _embed_cover, _fetch_cover_bytes, _has_cover,
                          _resolve_cover_bytes)
    try:
        item_pid = int(payload.get("item_pid") or 0)
    except Exception:
        return JSONResponse({"ok": False, "error": "item_pid invalid"}, status_code=400)
    if not item_pid:
        return JSONResponse({"ok": False, "error": "item_pid required"}, status_code=400)
    mode = str(payload.get("mode") or "auto").lower()
    if mode not in ("auto", "url", "remove"):
        return JSONResponse({"ok": False, "error": "mode must be auto|url|remove"}, status_code=400)

    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService

        lockdown = await _open_lockdown(timeout=90)
        async with AfcService(lockdown) as afc:
            tmp = await _pull_media_db(afc)
            conn = sqlite3.connect(tmp)
            cur = conn.cursor()
            cur.execute("""
                SELECT item_extra.title, item_artist.item_artist,
                       album.album, item_extra.location, base_location.path
                FROM item_extra
                JOIN item ON item_extra.item_pid=item.item_pid
                JOIN base_location ON item.base_location_id=base_location.base_location_id
                LEFT JOIN item_artist ON item.item_artist_pid=item_artist.item_artist_pid
                LEFT JOIN album ON item.album_pid=album.album_pid
                WHERE item_extra.item_pid=?
            """, (item_pid,))
            row = cur.fetchone()
            conn.close()
            if not row or not row[3] or not row[4]:
                return JSONResponse({"ok": False, "error": "track file not found"}, status_code=404)
            db_title, db_artist, db_album, loc, base = row
            full_path = f"/{base}/{loc}"
            ext = ('.' + loc.rsplit('.', 1)[-1].lower()) if '.' in loc else ''
            if ext not in ('.m4a', '.mp3'):
                return JSONResponse({"ok": False, "error": "only m4a/mp3 supported"}, status_code=400)

            data = await asyncio.wait_for(afc.get_file_contents(full_path), 180)
            fd, tmp_audio = tempfile.mkstemp(suffix=ext)
            cover_bytes = None
            try:
                os.close(fd)
                open(tmp_audio, 'wb').write(data)
                if mode == "remove":
                    ok = _strip_cover_file(tmp_audio, ext)
                    has = False
                else:
                    if mode == "url":
                        cover_data = str(payload.get("coverData") or "").strip()
                        if cover_data:
                            cover_bytes = _decode_cover_data(cover_data)
                            if not cover_bytes:
                                return JSONResponse({"ok": False, "error": "File gambar tak valid (jpg/png/webp, maks 8MB)"}, status_code=400)
                        else:
                            cover_bytes = _fetch_cover_bytes(str(payload.get("coverUrl") or ""))
                            if not cover_bytes:
                                return JSONResponse({"ok": False, "error": "fetch URL cover gagal"}, status_code=400)
                    else:
                        info = {"artist": str(payload.get("artist") or db_artist or ""),
                                "title": str(payload.get("title") or db_title or ""),
                                "album": str(payload.get("album") or db_album or ""),
                                "coverUrl": "",
                                "spotifyClientId": str(payload.get("spotifyClientId") or ""),
                                "spotifyClientSecret": str(payload.get("spotifyClientSecret") or "")}
                        cover_bytes = _resolve_cover_bytes(info)
                        if not cover_bytes:
                            return JSONResponse({"ok": False, "error": "auto-resolve gagal (coba URL manual)"}, status_code=404)
                    ok = _embed_cover(Path(tmp_audio), db_title or "", db_artist or "",
                                      db_album or "", cover_bytes)
                    has = _has_cover(Path(tmp_audio)) if ok else False
                if not ok:
                    return JSONResponse({"ok": False, "error": "gagal memproses cover"}, status_code=500)
                new_bytes = open(tmp_audio, 'rb').read()
                await asyncio.wait_for(afc.set_file_contents(full_path, new_bytes), 300)
                now_ms = int((time.time() - 978307200) * 1000)
                conn2 = sqlite3.connect(tmp)
                conn2.execute("UPDATE item_extra SET file_size=?, date_modified=?, integrity=NULL WHERE item_pid=?",
                              (len(new_bytes), now_ms, item_pid))
                conn2.commit()
                conn2.close()
                try:
                    await _apply_track_artwork(
                        afc, tmp, item_pid,
                        cover_bytes if has else None, None,
                        remove=not has)
                except Exception as ae:
                    log.warning("artwork sync pid=%s: %s", item_pid, ae)
                await _push_media_db(afc, tmp)
                await _clear_artwork_caches(afc)
            finally:
                try:
                    os.remove(tmp_audio)
                except Exception:
                    pass
            try:
                os.remove(tmp)
            except Exception:
                pass
        _iph_cover_invalidate(item_pid)
        return {"ok": True, "item_pid": item_pid, "file_size": len(new_bytes), "has_cover": bool(has)}
    except Exception as e:
        log.error("iphone cover fail: %s", e, exc_info=True)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass


def _strip_cover_file(tmp_audio: str, ext: str) -> bool:
    """Strip embedded cover art from a temp audio copy. Never raises."""
    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3
            try:
                tags = ID3(tmp_audio)
            except Exception:
                return True
            tags.delall("APIC")
            tags.save(tmp_audio)
            return True
        if ext == ".m4a":
            from mutagen.mp4 import MP4
            tags = MP4(tmp_audio)
            if tags.tags and "covr" in tags.tags:
                del tags.tags["covr"]
                tags.save()
            return True
    except Exception as e:
        log.warning("strip cover failed: %s", e)
    return False


@router.post("/iphone/track/edit")
async def iphone_track_edit(payload: dict):
    """Edit title/artist/album of a single iPhone track.

    Body: { "item_pid": int, "title"?: str, "artist"?: str, "album"?: str }
    Missing/empty fields keep current values; title must stay non-empty.
    Rewrites file tags on a temp copy (mutagen), uploads it, then syncs
    DB text columns + sort orders + search + a fresh entity_revision.
    Artist/album entity rows update in place when used by this track
    only, else fresh uid rows are created and the item repointed.
    """
    import random
    from vx_cover import _write_tags
    try:
        item_pid = int(payload.get("item_pid") or 0)
    except Exception:
        return JSONResponse({"ok": False, "error": "item_pid invalid"}, status_code=400)
    if not item_pid:
        return JSONResponse({"ok": False, "error": "item_pid required"}, status_code=400)
    want_title = str(payload.get("title") or "").strip()
    want_artist = str(payload.get("artist") or "").strip()
    want_album = str(payload.get("album") or "").strip()

    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService

        lockdown = await _open_lockdown(timeout=90)
        async with AfcService(lockdown) as afc:
            tmp = await _pull_media_db(afc)
            conn = sqlite3.connect(tmp)
            cur = conn.cursor()
            cur.execute("""
                SELECT item_extra.title, item_artist.item_artist, album.album,
                       item_extra.location, base_location.path,
                       item.item_artist_pid, item.album_pid, album.album_artist_pid
                FROM item_extra
                JOIN item ON item_extra.item_pid=item.item_pid
                JOIN base_location ON item.base_location_id=base_location.base_location_id
                LEFT JOIN item_artist ON item.item_artist_pid=item_artist.item_artist_pid
                LEFT JOIN album ON item.album_pid=album.album_pid
                WHERE item_extra.item_pid=?
            """, (item_pid,))
            row = cur.fetchone()
            if not row:
                conn.close()
                return JSONResponse({"ok": False, "error": "track not found"}, status_code=404)
            cur_title, cur_artist, cur_album, loc, base = row[0], row[1], row[2], row[3], row[4]
            cur_artist_pid, cur_album_pid, cur_album_artist_pid = row[5], row[6], row[7]
            new_title = want_title or (cur_title or "")
            new_artist = want_artist or (cur_artist or "")
            new_album = want_album or (cur_album or "")
            if not new_title:
                conn.close()
                return JSONResponse({"ok": False, "error": "title must stay non-empty"}, status_code=400)
            if (new_title == (cur_title or "") and new_artist == (cur_artist or "")
                    and new_album == (cur_album or "")):
                conn.close()
                return {"ok": True, "changed": False, "item_pid": item_pid,
                        "title": new_title, "artist": new_artist, "album": new_album}
            if not loc or not base:
                conn.close()
                return JSONResponse({"ok": False, "error": "track file not found"}, status_code=404)
            full_path = f"/{base}/{loc}"
            ext = ('.' + loc.rsplit('.', 1)[-1].lower()) if '.' in loc else ''
            if ext not in ('.m4a', '.mp3'):
                conn.close()
                return JSONResponse({"ok": False, "error": "only m4a/mp3 supported"}, status_code=400)

            data = await asyncio.wait_for(afc.get_file_contents(full_path), 180)
            fd, tmp_audio = tempfile.mkstemp(suffix=ext)
            try:
                os.close(fd)
                open(tmp_audio, 'wb').write(data)
                if not _write_tags(Path(tmp_audio), new_title, new_artist, new_album):
                    return JSONResponse({"ok": False, "error": "gagal menulis tag"}, status_code=500)
                new_bytes = open(tmp_audio, 'rb').read()
                await asyncio.wait_for(afc.set_file_contents(full_path, new_bytes), 300)
            finally:
                try:
                    os.remove(tmp_audio)
                except Exception:
                    pass

            now_ms = int((time.time() - 978307200) * 1000)
            title_ord, title_sec = _title_hash(new_title), _section_index(new_title)
            artist_ord, artist_sec = _title_hash(new_artist), _section_index(new_artist)
            album_ord, album_sec = _title_hash(new_album), _section_index(new_album)

            def _uid():
                return 200000000 + random.randint(0, 99999999) * 256

            if new_artist != (cur_artist or ""):
                uses = cur.execute("SELECT COUNT(*) FROM item WHERE item_artist_pid=?",
                                   (cur_artist_pid,)).fetchone()[0] if cur_artist_pid else 0
                if cur_artist_pid and uses <= 1:
                    cur.execute("UPDATE item_artist SET item_artist=?, sort_item_artist=? WHERE item_artist_pid=?",
                                (new_artist, new_artist, cur_artist_pid))
                    new_artist_pid = cur_artist_pid
                else:
                    new_artist_pid = _uid()
                    cur.execute("INSERT INTO item_artist (item_artist_pid, item_artist, sort_item_artist, representative_item_pid) VALUES (?, ?, ?, ?)",
                                (new_artist_pid, new_artist, new_artist, item_pid))
                if cur_album_artist_pid:
                    aa_uses = cur.execute("""SELECT COUNT(*) FROM item JOIN album ON item.album_pid=album.album_pid
                                             WHERE album.album_artist_pid=?""", (cur_album_artist_pid,)).fetchone()[0]
                    if aa_uses <= 1:
                        cur.execute("UPDATE album_artist SET album_artist=?, sort_album_artist=? WHERE album_artist_pid=?",
                                    (new_artist, new_artist, cur_album_artist_pid))
                        new_album_artist_pid = cur_album_artist_pid
                    else:
                        new_album_artist_pid = _uid()
                        cur.execute("INSERT INTO album_artist (album_artist_pid, album_artist, sort_album_artist, representative_item_pid) VALUES (?, ?, ?, ?)",
                                    (new_album_artist_pid, new_artist, new_artist, item_pid))
                else:
                    new_album_artist_pid = _uid()
                    cur.execute("INSERT INTO album_artist (album_artist_pid, album_artist, sort_album_artist, representative_item_pid) VALUES (?, ?, ?, ?)",
                                (new_album_artist_pid, new_artist, new_artist, item_pid))
            else:
                cur.execute("SELECT item.item_artist_pid, album.album_artist_pid FROM item JOIN album ON item.album_pid=album.album_pid WHERE item.item_pid=?",
                            (item_pid,))
                _ids = cur.fetchone()
                new_artist_pid, new_album_artist_pid = (_ids[0], _ids[1]) if _ids else (cur_artist_pid, cur_album_artist_pid)

            if new_album != (cur_album or ""):
                uses = cur.execute("SELECT COUNT(*) FROM item WHERE album_pid=?",
                                   (cur_album_pid,)).fetchone()[0] if cur_album_pid else 0
                if cur_album_pid and uses <= 1:
                    cur.execute("UPDATE album SET album=?, sort_album=? WHERE album_pid=?",
                                (new_album, new_album, cur_album_pid))
                    new_album_pid = cur_album_pid
                else:
                    new_album_pid = _uid()
                    cur.execute("INSERT INTO album (album_pid, album, sort_album, album_artist_pid, representative_item_pid) VALUES (?, ?, ?, ?, ?)",
                                (new_album_pid, new_album, new_album, new_album_artist_pid, item_pid))
            else:
                new_album_pid = cur_album_pid

            cur.execute("""UPDATE item SET title_order=?, title_order_section=?,
                           item_artist_pid=?, item_artist_order=?, item_artist_order_section=?,
                           album_pid=?, album_order=?, album_order_section=?,
                           album_artist_pid=?, album_artist_order=?, album_artist_order_section=?
                           WHERE item_pid=?""",
                        (title_ord, title_sec, new_artist_pid, artist_ord, artist_sec,
                         new_album_pid, album_ord, album_sec,
                         new_album_artist_pid, artist_ord, artist_sec, item_pid))
            cur.execute("""UPDATE item_extra SET title=?, sort_title=?, file_size=?, date_modified=?, integrity=NULL
                           WHERE item_pid=?""",
                        (new_title, new_title, len(new_bytes), now_ms, item_pid))
            cur.execute("UPDATE item_state SET title=? WHERE item_pid=?", (new_title, item_pid))
            cur.execute("UPDATE item_search SET search_title=?, search_album=?, search_artist=?, search_album_artist=? WHERE item_pid=?",
                        (title_ord, album_ord, artist_ord, artist_ord, item_pid))
            cur.execute("SELECT max(revision) FROM entity_revision")
            max_rev = cur.fetchone()[0] or 0
            cur.execute("SELECT 1 FROM entity_revision WHERE entity_pid=? AND class=0 AND revision_type=0",
                        (item_pid,))
            if cur.fetchone():
                cur.execute("UPDATE entity_revision SET revision=?, deleted=0 WHERE entity_pid=? AND class=0 AND revision_type=0",
                            (max_rev + 1, item_pid))
            else:
                cur.execute("INSERT INTO entity_revision (revision, entity_pid, deleted, class, revision_type) VALUES (?, ?, 0, 0, 0)",
                            (max_rev + 1, item_pid))
            conn.commit()
            conn.close()
            await _push_media_db(afc, tmp)
            try:
                os.remove(tmp)
            except Exception:
                pass
        return {"ok": True, "changed": True, "item_pid": item_pid,
                "title": new_title, "artist": new_artist, "album": new_album,
                "file_size": len(new_bytes)}
    except Exception as e:
        log.error("iphone edit fail: %s", e, exc_info=True)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass



def _random_name(length=4):
    import random, string
    return ''.join(random.choices(string.ascii_uppercase, k=length))


def _title_hash(title):
    h = 0
    for c in title.lower():
        h = (h * 31 + ord(c)) & 0x7FFFFFFFFFFFFFFF
    return h


def _section_index(name):
    """Sort-section bucket: 0-25 for a-z by first letter, 27 for non-alpha/none.

    Matches MediaLibrary daemon convention observed on-device
    (e.g. 'Bukan Pujangga'->1, 'Ti3a'->19, 'Pop'->15, empty->27).
    """
    for c in (name or '').lower():
        if 'a' <= c <= 'z':
            return ord(c) - ord('a')
        if c.isalpha():
            return 27
    return 27


def _audio_meta(file_path):
    """Read duration/bitrate/sample_rate/channels + tags. Never raises.

    Also extracts title/artist/album from embedded tags so imports use
    real metadata instead of filename guesses (which often degrade to
    "Unknown" when the filename carries no "Artist - Title" pattern).
    """
    meta = {'duration_ms': 0, 'bit_rate': 0, 'sample_rate': 0, 'channels': 0,
            'year': 0, 'genre': '', 'track_number': 0,
            'title': '', 'artist': '', 'album': ''}
    try:
        ext = file_path.lower().rsplit('.', 1)[-1] if '.' in file_path else ''
        if ext in ('m4a', 'm4p', 'mp4'):
            from mutagen.mp4 import MP4
            a = MP4(file_path)
            meta['duration_ms'] = int(a.info.length * 1000)
            meta['bit_rate'] = int((a.info.bitrate or 0) // 1000)
            meta['sample_rate'] = int(a.info.sample_rate or 0)
            meta['channels'] = int(a.info.channels or 0)
            tags = dict(a.tags) if a.tags else {}

            def _t(k):
                v = tags.get(k)
                try:
                    return str(v[0]).strip() if v and v[0] else ''
                except Exception:
                    return ''
            meta['title'] = _t('\xa9nam')
            meta['artist'] = _t('\xa9ART')
            meta['album'] = _t('\xa9alb')
            meta['genre'] = _t('\xa9gen')
            try:
                meta['year'] = int(str(_t('\xa9day'))[:4])
            except Exception:
                pass
            try:
                trkn = tags.get('trkn')
                if trkn and trkn[0][0]:
                    meta['track_number'] = int(trkn[0][0])
            except Exception:
                pass
        elif ext == 'mp3':
            from mutagen.mp3 import MP3
            a = MP3(file_path)
            meta['duration_ms'] = int(a.info.length * 1000)
            meta['bit_rate'] = int((a.info.bitrate or 0) // 1000)
            meta['sample_rate'] = int(a.info.sample_rate or 0)
            meta['channels'] = 2 if str(getattr(a.info, 'mode', '')).endswith('STEREO') else 1
            if a.tags:
                def _id3(k):
                    try:
                        fr = a.tags.get(k)
                        return str(fr.text[0]).strip() if fr and fr.text else ''
                    except Exception:
                        return ''
                meta['title'] = _id3('TIT2')
                meta['artist'] = _id3('TPE1')
                meta['album'] = _id3('TALB')
    except Exception:
        pass
    return meta



def _table_cols(conn, table: str) -> list:
    try:
        return [r[1] for r in conn.execute(f"PRAGMA table_info([{table}])")]
    except Exception:
        return []


def _pick_col(cols: list, *candidates: str):
    lower = {c.lower(): c for c in cols}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


def _guess_path_col(conn, table: str, cols: list):
    """Column that stores relative artwork path (device: relative_path)."""
    try:
        row = conn.execute(f"SELECT * FROM [{table}] LIMIT 1").fetchone()
        if row:
            for c, v in zip(cols, row):
                if isinstance(v, str) and ("/" in v or v.lower().endswith((".jpg", ".jpeg", ".png"))):
                    return c
    except Exception:
        pass
    return _pick_col(cols, "relative_path", "file_name", "filename", "file_path",
                     "filepath", "path", "artwork_path", "image_path",
                     "name", "artwork_file")


def _detect_artwork_source_type(conn) -> int:
    """What THIS device uses for local Artwork/Originals rows: 300 (modern) or 400."""
    try:
        rows = conn.execute(
            "SELECT artwork_source_type, COUNT(*) FROM artwork"
            " WHERE artwork_source_type IN (300, 400, 1)"
            " GROUP BY 1 ORDER BY 2 DESC").fetchall()
        if rows:
            return int(rows[0][0])
    except Exception:
        pass
    return 300


def _insert_dynamic(conn, table: str, preferred: dict) -> bool:
    """INSERT using PRAGMA columns; fill NOT NULL gaps; omit the rest.

    Only INTEGER PRIMARY KEY (rowid alias) is omitted when not provided —
    composite/text PKs like artwork_token must still be inserted.
    """
    try:
        info = list(conn.execute(f"PRAGMA table_info([{table}])"))
    except Exception:
        return False
    if not info:
        return False
    pref_lower = {k.lower(): v for k, v in preferred.items()}
    values = {}
    for _cid, name, typ, notnull, dflt, pk in info:
        if name.lower() in pref_lower:
            values[name] = pref_lower[name.lower()]
            continue
        t = (typ or "").upper()
        if pk == 1 and "INT" in t:
            continue
        if dflt is not None:
            continue
        if notnull or pk:
            if "INT" in t or not t:
                values[name] = 0
            elif "BLOB" in t:
                values[name] = b""
            else:
                values[name] = ""
    if not values:
        return False
    cols = list(values.keys())
    ph = ",".join("?" * len(cols))
    names = ",".join(f"[{c}]" for c in cols)
    conn.execute(f"INSERT INTO [{table}] ({names}) VALUES ({ph})",
                 [values[c] for c in cols])
    return True


def _artwork_jpeg(data: bytes, max_side: int = 1400) -> bytes | None:
    """Full(er)-size JPEG for the on-device Artwork store (not the UI thumb)."""
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        if img.mode in ("RGBA", "LA", "PA"):
            bg = Image.new("RGB", img.size, (0, 0, 0))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception as e:
        log.warning("artwork jpeg fail: %s", e)
        return None


def _artwork_token_for(item_pid: int) -> str:
    """Stable token string (SHA1 of this is the on-device relative_path)."""
    import hashlib
    return hashlib.sha1(f"vx-{int(item_pid)}".encode()).hexdigest()


def _artwork_rel_path(token: str) -> str:
    """Device path: SHA1(token) -> 'xx/' + remaining 38 hex, no extension."""
    import hashlib
    h = hashlib.sha1(token.encode("utf-8")).hexdigest()
    return f"{h[:2]}/{h[2:]}"


def _import_cover_payload(file_path: str, title: str, artist: str, album: str):
    """Cover bytes for import + audio bytes (embed if source had none).

    Returns (cover_bytes|None, cover_mime|None, audio_bytes, file_size).
    """
    from vx_cover import _cover_mime, _embed_cover, _resolve_cover_bytes
    path = Path(file_path)
    audio = open(file_path, 'rb').read()
    found = _extract_embedded_cover(path)
    if found:
        raw, mime = found
        return raw, mime or "image/jpeg", audio, len(audio)
    cover = _resolve_cover_bytes({
        "artist": artist or "", "title": title or "", "album": album or "",
        "coverUrl": "", "spotifyClientId": "", "spotifyClientSecret": "",
    })
    if not cover:
        return None, None, audio, len(audio)
    mime = _cover_mime(cover[:16]) or "image/jpeg"
    if path.suffix.lower() in ('.m4a', '.mp3', '.mp4', '.aac'):
        fd, tmp = tempfile.mkstemp(suffix=path.suffix)
        try:
            os.close(fd)
            open(tmp, 'wb').write(audio)
            if _embed_cover(Path(tmp), title or "", artist or "", album or "", cover):
                audio = open(tmp, 'rb').read()
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass
    return cover, mime, audio, len(audio)


async def _upload_artwork_file(afc, token: str, jpeg: bytes) -> str | None:
    """PUT image at Artwork/Originals/<sha1[:2]>/<sha1[2:]> (no extension).

    Returns relative_path for the artwork table, or None.
    """
    rel = _artwork_rel_path(token)
    sub = rel.split("/", 1)[0]
    base = "/iTunes_Control/iTunes/Artwork/Originals"
    try:
        try:
            await asyncio.wait_for(afc.makedirs(f"{base}/{sub}"), 60)
        except Exception:
            try:
                await asyncio.wait_for(afc.makedirs(base), 60)
                await asyncio.wait_for(afc.makedirs(f"{base}/{sub}"), 60)
            except Exception as e:
                log.debug("artwork makedirs: %s", e)
        await asyncio.wait_for(afc.set_file_contents(f"{base}/{rel}", jpeg), 90)
        return rel
    except Exception as e:
        log.warning("upload artwork file fail: %s", e)
        return None


async def _clear_artwork_caches(afc) -> None:
    """Stale derived thumbs in Artwork/Caches mask new originals — wipe them."""
    try:
        for name in await asyncio.wait_for(
                afc.listdir("/iTunes_Control/iTunes/Artwork/Caches"), 30):
            if name in (".", ".."):
                continue
            try:
                await asyncio.wait_for(
                    afc.rm(f"/iTunes_Control/iTunes/Artwork/Caches/{name}"), 30)
            except Exception:
                pass
    except Exception as e:
        log.debug("clear Artwork/Caches: %s", e)


def _register_artwork_rows(conn, item_pid: int, rel_path: str,
                           token: str | None = None) -> bool:
    """Write artwork + artwork_token (item+album) + best_artwork_token.

    Music.app primarily reads best_artwork_token; album grid needs
    entity_type=4 on the album_pid. Schema columns are picked via PRAGMA.
    """
    if not token:
        token = _artwork_token_for(item_pid)
    src = _detect_artwork_source_type(conn)
    at_cols = _table_cols(conn, "artwork_token")
    aw_cols = _table_cols(conn, "artwork")
    if not at_cols or not aw_cols:
        log.warning("artwork schema missing: token=%s artwork=%s", at_cols, aw_cols)
        return False
    token_key = _pick_col(at_cols, "artwork_token", "token")
    entity_key = _pick_col(at_cols, "entity_pid", "item_pid", "owner_pid")
    src_key = _pick_col(at_cols, "artwork_source_type", "source_type")
    type_key = _pick_col(at_cols, "artwork_type")
    ent_type_key = _pick_col(at_cols, "entity_type")
    var_key = _pick_col(at_cols, "artwork_variant_type")
    if not token_key or not entity_key:
        log.warning("artwork_token missing key cols: %s", at_cols)
        return False
    aw_token_key = _pick_col(aw_cols, "artwork_token", "token")
    aw_src_key = _pick_col(aw_cols, "artwork_source_type", "source_type")
    path_key = _guess_path_col(conn, "artwork", aw_cols)
    aw_type_key = _pick_col(aw_cols, "artwork_type")
    aw_var_key = _pick_col(aw_cols, "artwork_variant_type")
    if not aw_token_key or not path_key:
        log.warning("artwork missing key cols: %s (path=%s)", aw_cols, path_key)
        return False

    try:
        conn.execute(f"DELETE FROM [artwork] WHERE [{aw_token_key}]=?", (token,))
    except Exception:
        pass
    try:
        if entity_key:
            for pid in (int(item_pid),):
                conn.execute(
                    f"DELETE FROM [artwork_token] WHERE [{entity_key}]=?", (pid,))
    except Exception:
        pass

    ok_aw = _insert_dynamic(conn, "artwork", {
        aw_token_key: token, path_key: rel_path,
        **({aw_src_key: src} if aw_src_key else {}),
        **({aw_type_key: 1} if aw_type_key else {}),
        **({aw_var_key: 0} if aw_var_key else {}),
    })

    ok_at = _insert_dynamic(conn, "artwork_token", {
        token_key: token, entity_key: int(item_pid),
        **({src_key: src} if src_key else {}),
        **({type_key: 1} if type_key else {}),
        **({ent_type_key: 0} if ent_type_key else {}),
        **({var_key: 0} if var_key else {}),
    })

    album_pid = None
    try:
        row = conn.execute(
            "SELECT album_pid, representative_item_pid FROM item "
            "LEFT JOIN album USING (album_pid) WHERE item.item_pid=?",
            (int(item_pid),)).fetchone()
        if row:
            album_pid = row[0]
            if row[1] and int(row[1]) != int(item_pid):
                conn.execute(
                    "UPDATE album SET representative_item_pid=? WHERE album_pid=?",
                    (int(item_pid), album_pid))
    except Exception as e:
        log.debug("album lookup: %s", e)
    if album_pid:
        _insert_dynamic(conn, "artwork_token", {
            token_key: token, entity_key: int(album_pid),
            **({src_key: src} if src_key else {}),
            **({type_key: 6} if type_key else {}),
            **({ent_type_key: 4} if ent_type_key else {}),
            **({var_key: 0} if var_key else {}),
        })

    ok_best = True
    best_cols = _table_cols(conn, "best_artwork_token")
    if best_cols:
        b_ent = _pick_col(best_cols, "entity_pid")
        b_ent_t = _pick_col(best_cols, "entity_type")
        b_art_t = _pick_col(best_cols, "artwork_type")
        b_avail = _pick_col(best_cols, "available_artwork_token")
        b_fetch = _pick_col(best_cols, "fetchable_artwork_token")
        b_fetch_src = _pick_col(best_cols, "fetchable_artwork_source_type")
        b_var = _pick_col(best_cols, "artwork_variant_type")
        if b_ent and b_avail:
            for e_pid, e_type in ((int(item_pid), 0),
                                  (int(album_pid), 4) if album_pid else (None, None)):
                if e_pid is None:
                    continue
                try:
                    cols_del = [b_ent]
                    cond = f"[{b_ent}]=?"
                    args = [e_pid]
                    if b_ent_t:
                        cols_del.append(b_ent_t)
                        cond += f" AND [{b_ent_t}]=?"
                        args.append(e_type)
                    if b_art_t:
                        cond += f" AND [{b_art_t}]=?"
                        args.append(1 if e_type == 0 else 6)
                    conn.execute(
                        f"DELETE FROM [best_artwork_token] WHERE {cond}", args)
                except Exception:
                    pass
                pref = {
                    b_ent: e_pid, b_avail: token,
                    **({b_ent_t: e_type} if b_ent_t else {}),
                    **({b_art_t: 1 if e_type == 0 else 6} if b_art_t else {}),
                    **({b_fetch: ""} if b_fetch else {}),
                    **({b_fetch_src: 0} if b_fetch_src else {}),
                    **({b_var: 0} if b_var else {}),
                }
                if not _insert_dynamic(conn, "best_artwork_token", pref):
                    ok_best = False
    else:
        log.debug("best_artwork_token table absent (older iOS?)")

    try:
        if album_pid:
            alb_cols = _table_cols(conn, "album")
            alb_tok = _pick_col(alb_cols, "artwork_token", "token",
                                "album_artwork_token")
            if alb_tok:
                conn.execute(
                    f"UPDATE album SET [{alb_tok}]=? WHERE album_pid=?",
                    (token, album_pid))
    except Exception as e:
        log.debug("album artwork col skip: %s", e)

    ok = bool(ok_at and ok_aw and ok_best)
    if not ok:
        log.warning("artwork insert incomplete: token=%s art=%s best=%s",
                    ok_at, ok_aw, ok_best)
    return ok


def _clear_artwork_rows(conn, item_pid: int) -> None:
    """Drop artwork_token / best_artwork_token links for item and its album."""
    try:
        album_pid = None
        try:
            row = conn.execute(
                "SELECT album_pid FROM item WHERE item_pid=?",
                (int(item_pid),)).fetchone()
            album_pid = row[0] if row else None
        except Exception:
            pass
        at_cols = _table_cols(conn, "artwork_token")
        entity_key = _pick_col(at_cols, "entity_pid", "item_pid", "owner_pid")
        if entity_key:
            for pid in (int(item_pid), album_pid):
                if pid is None:
                    continue
                conn.execute(
                    f"DELETE FROM [artwork_token] WHERE [{entity_key}]=?",
                    (int(pid),))
        best_cols = _table_cols(conn, "best_artwork_token")
        b_ent = _pick_col(best_cols, "entity_pid") if best_cols else None
        if b_ent:
            for pid in (int(item_pid), album_pid):
                if pid is None:
                    continue
                conn.execute(
                    f"DELETE FROM [best_artwork_token] WHERE [{b_ent}]=?",
                    (int(pid),))
    except Exception as e:
        log.debug("clear artwork_token skip: %s", e)


async def _apply_track_artwork(afc, db_path: str, item_pid: int,
                               cover_bytes: bytes | None, cover_mime: str | None,
                               remove: bool = False) -> bool:
    """Upload cover to Artwork/Originals + write artwork/best token rows."""
    conn = sqlite3.connect(db_path)
    try:
        if remove or not cover_bytes:
            _clear_artwork_rows(conn, item_pid)
            conn.commit()
            await _clear_artwork_caches(afc)
            return True
        jpeg = _artwork_jpeg(cover_bytes)
        if not jpeg:
            return False
        token = _artwork_token_for(item_pid)
        rel = await _upload_artwork_file(afc, token, jpeg)
        if not rel:
            return False
        _clear_artwork_rows(conn, item_pid)
        ok = _register_artwork_rows(conn, item_pid, rel, token=token)
        conn.commit()
        await _clear_artwork_caches(afc)
        return ok
    finally:
        conn.close()


_DB_MAIN = '/iTunes_Control/iTunes/MediaLibrary.sqlitedb'


async def _pull_media_db(afc, timeout=180):
    """Download MediaLibrary main+WAL+SHM to a temp file.

    Raises RuntimeError if the on-device WAL exists but cannot be
    downloaded: uploading a stale snapshot would roll back the live
    MediaLibrary daemon state and get our rows tombstoned.

    The whole pull is bounded by `timeout` seconds so a dropped USB
    link fails fast instead of hanging the job forever.
    """
    data = await asyncio.wait_for(afc.get_file_contents(_DB_MAIN), timeout)
    tmp = tempfile.mktemp(suffix='.db')
    with open(tmp, 'wb') as f:
        f.write(data)
    for suffix in ('-wal', '-shm'):
        try:
            blob = await asyncio.wait_for(
                afc.get_file_contents(_DB_MAIN + suffix), timeout)
            with open(tmp + suffix, 'wb') as f:
                f.write(blob)
        except Exception as e:
            try:
                still_there = await asyncio.wait_for(
                    afc.exists(_DB_MAIN + suffix), 30)
            except Exception:
                still_there = False
            if still_there:
                raise RuntimeError(f"cannot fetch live journal {suffix}: {e}")
    return tmp


async def _push_media_db(afc, tmp):
    """Checkpoint local copy, upload it, then clear device WAL/SHM.

    NOTE (verified 2026-09-22): an earlier version uploaded the
    main+WAL+SHM triple intact so the live daemon would replay our
    transactions. That made the daemon notice foreign rows and respond
    with a full library purge (all music rows deleted). The
    checkpoint-and-clear approach keeps pushes invisible to the daemon:
    rows list and play fine in the Music app (verified over days) while
    the daemon never audits them. Do NOT "fix" this back to triple
    upload without a backup and a full stability test.
    """
    conn = sqlite3.connect(tmp)
    try:
        ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if ok != "ok":
            raise RuntimeError(f"integrity_check failed: {ok}")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
    finally:
        conn.close()
    with open(tmp, 'rb') as f:
        await asyncio.wait_for(afc.set_file_contents(_DB_MAIN, f.read()), 240)
    for suffix in ('-wal', '-shm'):
        try:
            await asyncio.wait_for(
                afc.set_file_contents(_DB_MAIN + suffix, b''), 60)
        except Exception:
            pass


def _add_track_to_db(db_path, loc_filename, title, artist, album, file_size, meta=None):
    """Insert a new track into all required MediaLibrary tables.

    meta: optional dict from _audio_meta() (duration_ms, bit_rate,
    sample_rate, channels, year, genre, track_number). Field values mirror
    what the on-device MediaLibrary daemon writes for real tracks
    (sort sections = first-letter index, millisecond-based dates,
    item_search kept consistent with item sort orders; sort_map is left
    for the daemon to generate).

    Visibility recipe (matches 3uTools): item_store.sync_id is a random
    nonzero 64-bit id with sync_in_my_library=1, so the built-in
    on_insert/on_update_item_setInMyLibraryColumn triggers compute
    item.in_my_library=1 automatically.

    WARNING: item_extra.integrity must stay NULL. A fabricated token
    (b'\\x04\\x00' + random bytes, imitating 3uTools) was proven to make
    the track unplayable ("cannot play" error); removing it restored
    playback. Do not re-add without the real algorithm.
    """
    import random
    meta = meta or {}
    duration_ms = int(meta.get('duration_ms') or 0)
    bit_rate = int(meta.get('bit_rate') or 0)
    sample_rate = int(meta.get('sample_rate') or 0)
    channels = int(meta.get('channels') or 2)
    year = int(meta.get('year') or 0)
    genre_name = meta.get('genre') or 'Music'
    track_number = int(meta.get('track_number') or 1)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    cur = conn.cursor()

    cur.execute("SELECT max(item_pid) FROM item")
    new_pid = (cur.fetchone()[0] or 0) + 1

    for _t in ['item_extra', 'item_stats', 'item_playback', 'item_search',
               'item_video', 'lyrics', 'item_store', 'item_state',
               'container_item']:
        cur.execute(f"DELETE FROM [{_t}] WHERE item_pid=?", (new_pid,))
    cur.execute("DELETE FROM entity_revision WHERE entity_pid=? AND class=0"
                " AND revision_type=0", (new_pid,))

    uid = 200000000 + random.randint(0, 99999999) * 256
    item_artist_pid = uid + 1
    album_pid = uid + 2
    album_artist_pid = uid + 3
    genre_id = uid + 4

    cur.execute("SELECT base_location_id FROM base_location WHERE path='iTunes_Control/Music/F00'")
    row = cur.fetchone()
    if row:
        base_location_id = row[0]
    else:
        base_location_id = 3840
        cur.execute("INSERT OR IGNORE INTO base_location (base_location_id, path) VALUES (?, ?)",
                    (base_location_id, 'iTunes_Control/Music/F00'))

    apple_epoch = 978307200
    now = int((time.time() - apple_epoch) * 1000)
    title_ord = _title_hash(title)
    artist_ord = _title_hash(artist)
    album_ord = _title_hash(album)
    title_sec = _section_index(title)
    artist_sec = _section_index(artist)
    album_sec = _section_index(album)

    cur.execute("INSERT INTO genre (genre_id, genre) VALUES (?, ?)", (genre_id, genre_name))
    cur.execute("INSERT INTO album_artist (album_artist_pid, album_artist, sort_album_artist, representative_item_pid) VALUES (?, ?, ?, ?)",
                (album_artist_pid, artist, artist, new_pid))
    cur.execute("INSERT INTO item_artist (item_artist_pid, item_artist, sort_item_artist, representative_item_pid) VALUES (?, ?, ?, ?)",
                (item_artist_pid, artist, artist, new_pid))
    cur.execute("INSERT INTO album (album_pid, album, sort_album, album_artist_pid, representative_item_pid) VALUES (?, ?, ?, ?, ?)",
                (album_pid, album, album, album_artist_pid, new_pid))

    cur.execute("""INSERT INTO item (
        item_pid, media_type, title_order, title_order_section,
        item_artist_pid, item_artist_order, item_artist_order_section,
        album_pid, album_order, album_order_section,
        album_artist_pid, album_artist_order, album_artist_order_section,
        genre_id, base_location_id, in_my_library, keep_local, keep_local_status,
        is_compilation, date_added, date_downloaded, disc_number, track_number
    ) VALUES (?, 8, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 2, 0, ?, ?, 0, ?)""",
                (new_pid, title_ord, title_sec, item_artist_pid, artist_ord, artist_sec,
                 album_pid, album_ord, album_sec, album_artist_pid, artist_ord, artist_sec,
                 genre_id, base_location_id, now, now, track_number))

    sync_id = random.getrandbits(62)
    cur.execute("""INSERT INTO item_extra (
        item_pid, title, sort_title, total_time_ms, location, file_size,
        date_modified, media_kind, location_kind_id, year
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)""",
                (new_pid, title, title, duration_ms, loc_filename, file_size, now, year))

    for table in ['item_stats', 'item_playback', 'item_search', 'item_video', 'lyrics', 'item_store']:
        cur.execute(f"INSERT INTO {table} (item_pid) VALUES (?)", (new_pid,))

    ext = loc_filename.rsplit('.', 1)[-1].lower() if '.' in loc_filename else ''
    audio_format = 256 if ext in ('m4a', 'm4p', 'mp4', 'aac') else (301 if ext == 'mp3' else 0)
    cur.execute("UPDATE item_playback SET audio_format=?, bit_rate=?, codec_type=1836069985, "
                "codec_subtype=2, duration=?, sample_rate=?, format=?, has_video=0 "
                "WHERE item_pid=?",
                (audio_format, bit_rate, duration_ms, float(sample_rate),
                 'm4a' if ext in ('m4a', 'm4p', 'mp4') else ext, new_pid))

    cur.execute("UPDATE item_state SET is_library_added=1, has_non_purgeable_asset=1, is_valid_content_type=1, media_type=8, title=?, location=?, playback_endpoint_type=3 WHERE item_pid=?",
                (title, loc_filename, new_pid))
    cur.execute("UPDATE item_store SET sync_id=?, sync_in_my_library=1,"
                " playback_endpoint_type=3 WHERE item_pid=?",
                (sync_id, new_pid))

    cur.execute("SELECT container_pid FROM container WHERE distinguished_kind=1")
    lib = cur.fetchone()
    if lib:
        lib_pid = lib[0]
        cur.execute("SELECT max(position) FROM container_item WHERE container_pid=?", (lib_pid,))
        max_pos = cur.fetchone()[0]
        pos = (max_pos or -1) + 1
        cur.execute("INSERT INTO container_item (container_item_pid, container_pid, item_pid, position) VALUES (?, ?, ?, ?)",
                    (new_pid, lib_pid, new_pid, pos))

    cur.execute("SELECT max(revision) FROM entity_revision")
    max_rev = cur.fetchone()[0] or 0
    cur.execute("INSERT INTO entity_revision (revision, entity_pid, deleted, class, revision_type) VALUES (?, ?, 0, 0, 0)",
                (max_rev + 1, new_pid))

    cur.execute("UPDATE item_search SET search_title=?, search_album=?, search_artist=?, "
                "search_composer=0, search_album_artist=? WHERE item_pid=?",
                (title_ord, album_ord, artist_ord, artist_ord, new_pid))

    conn.commit()
    conn.close()
    return new_pid



_import_jobs: dict = {}


@router.post("/iphone/import")
async def iphone_import(payload: dict):
    """Import a single music file to iPhone.
    Body: { "file_path": "/path/to/song.m4a", "title": "...", "artist": "...", "album": "..." }
    """
    file_path = payload.get("file_path", "")
    title = payload.get("title", "")
    artist = payload.get("artist", "Unknown")
    album = payload.get("album", "Unknown")

    if not file_path or not os.path.isfile(file_path):
        return JSONResponse({"ok": False, "error": "file_path not found"}, status_code=400)

    ext = Path(file_path).suffix.lower() or ".m4a"
    loc_filename = _random_name(4) + ext
    meta = _audio_meta(file_path)
    title = meta.get('title') or title or Path(file_path).stem
    artist = meta.get('artist') or artist or 'Unknown'
    album = meta.get('album') or album or 'Unknown'

    try:
        cover_bytes, cover_mime, audio_data, file_size = \
            _import_cover_payload(file_path, title, artist, album)
    except Exception as ce:
        log.warning("cover payload %s: %s", file_path, ce)
        cover_bytes, cover_mime = None, None
        audio_data = open(file_path, 'rb').read()
        file_size = len(audio_data)

    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService

        lockdown = await _open_lockdown()
        async with AfcService(lockdown) as afc:
            tmp = await _pull_media_db(afc)

            pid = _add_track_to_db(tmp, loc_filename, title, artist, album, file_size, meta)

            try:
                await _apply_track_artwork(afc, tmp, pid, cover_bytes, cover_mime)
            except Exception as ae:
                log.warning("artwork register pid=%s: %s", pid, ae)

            await _push_media_db(afc, tmp)
            await _clear_artwork_caches(afc)

            await asyncio.wait_for(
                afc.set_file_contents(
                    f'/iTunes_Control/Music/F00/{loc_filename}', audio_data),
                300)

            try:
                os.remove(tmp)
            except Exception:
                pass

        return {"ok": True, "pid": pid, "location": loc_filename, "message": "Track added."}
    except Exception as e:
        log.error("import fail: %s", e, exc_info=True)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass


@router.post("/iphone/import_batch")
async def iphone_import_batch(payload: dict):
    """Batch import music files to iPhone.
    Body: { "files": [{"path": "...", "title": "...", "artist": "...", "album": "..."}, ...],
            "delete_pids": [item_pid, ...] (optional, deleted first in the
            same DB session to avoid extra pull/push rounds) }
    """
    files = payload.get("files", [])
    delete_pids = payload.get("delete_pids", []) or []
    if not files and not delete_pids:
        return JSONResponse({"ok": False, "error": "no files"}, status_code=400)

    job_id = f"imp_{int(time.time() * 1000)}"
    _import_jobs[job_id] = {
        "status": "running", "total": len(files), "done": 0,
        "current": "", "results": [],
        "snapshot": "", "deleted": [],
        "delete_total": len(delete_pids or []),
    }
    asyncio.create_task(_run_import_batch(job_id, files, delete_pids))
    return {"ok": True, "job_id": job_id}


async def _run_import_batch(job_id: str, files: list, delete_pids=None):
    """Background task: delete listed pids, then import each file."""
    lockdown = None
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService

        lockdown = await _open_lockdown(timeout=90)
        async with AfcService(lockdown) as afc:
            tmp = await _pull_media_db(afc)
            try:
                _del = sqlite3.connect(tmp)
                _dcur = _del.cursor()
                _del_total = len(delete_pids or [])
                for _i, _pid in enumerate(delete_pids or []):
                    try:
                        _pid = int(_pid)
                    except Exception:
                        continue
                    job = _import_jobs.get(job_id, {})
                    if job.get("status") == "cancelled":
                        break
                    _dcur.execute("""
                        SELECT location, base_location.path
                        FROM item_extra
                        JOIN item ON item_extra.item_pid=item.item_pid
                        JOIN base_location ON item.base_location_id=
                            base_location.base_location_id
                        WHERE item_extra.item_pid=?
                    """, (_pid,))
                    _row = _dcur.fetchone()
                    _loc = (_row[0] if _row and _row[0] else None)
                    _full = (f"/{_row[1]}/{_row[0]}"
                             if _row and _row[0] and _row[1] else None)
                    _name = Path(_loc).name if _loc else f"pid={_pid}"
                    _import_jobs[job_id]["current"] = (
                        f"Menghapus {_i + 1}/{_del_total} — {_name}")
                    for _tbl in ["item_extra", "item", "item_stats",
                                 "item_playback", "item_search",
                                 "item_video", "lyrics", "item_store",
                                 "item_state", "container_item"]:
                        _dcur.execute(f"DELETE FROM [{_tbl}] WHERE"
                                      " item_pid=?", (_pid,))
                    _clear_artwork_rows(_del, _pid)
                    _del.commit()
                    _import_jobs[job_id]["deleted"].append(_pid)
                    if _full:
                        try:
                            await asyncio.wait_for(afc.rm(_full), 60)
                        except Exception as _e:
                            log.warning("rm file fail %s: %s", _full, _e)
                _del.close()
                if _import_jobs.get(job_id, {}).get("status") != "cancelled":
                    _import_jobs[job_id]["current"] = ""
            except Exception as _e:
                log.error("batch delete fail: %s", _e, exc_info=True)
                _import_jobs[job_id]["status"] = "error"
                _import_jobs[job_id]["error"] = f"delete fail: {_e}"
                return
            try:
                _dbg = sqlite3.connect(tmp)
                _dbg_rev = _dbg.execute(
                    "SELECT max(revision) FROM entity_revision").fetchone()[0]
                _dbg_pid = _dbg.execute(
                    "SELECT max(item_pid) FROM item").fetchone()[0]
                _dbg.close()
            except Exception as _e:
                _dbg_rev = f"ERR {_e}"
                _dbg_pid = None
            try:
                _st = await asyncio.wait_for(afc.stat(_DB_MAIN), 60)
                _dev_size = _st.get("st_size")
            except Exception:
                _dev_size = None
            _import_jobs[job_id]["snapshot"] = (
                f"tmp_max_rev={_dbg_rev} tmp_max_pid={_dbg_pid}"
                f" dev_size={_dev_size}")

            pids = []

            for i, f in enumerate(files):
                job = _import_jobs.get(job_id, {})
                if job.get("status") == "cancelled":
                    break

                file_path = f.get("path", "")
                title = f.get("title", "") or (Path(file_path).stem if file_path else "Unknown")
                artist = f.get("artist", "Unknown")
                album = f.get("album", "Unknown")

                try:
                    if not os.path.isfile(file_path):
                        _import_jobs[job_id]["results"].append({"path": file_path, "ok": False, "error": "file not found"})
                        _import_jobs[job_id]["done"] = i + 1
                        continue

                    file_size = os.path.getsize(file_path)
                    ext = Path(file_path).suffix.lower() or ".m4a"
                    loc_filename = _random_name(4) + ext
                    fname = Path(file_path).name

                    _import_jobs[job_id]["current"] = fname

                    meta = _audio_meta(file_path)
                    title = meta.get('title') or title or Path(file_path).stem
                    artist = meta.get('artist') or artist or 'Unknown'
                    album = meta.get('album') or album or 'Unknown'
                    _import_jobs[job_id]["current"] = fname

                    try:
                        cover_bytes, cover_mime, audio_data, file_size = \
                            _import_cover_payload(file_path, title, artist, album)
                    except Exception as ce:
                        log.warning("cover payload %s: %s", file_path, ce)
                        cover_bytes, cover_mime = None, None
                        audio_data = open(file_path, 'rb').read()
                        file_size = len(audio_data)

                    pid = _add_track_to_db(tmp, loc_filename, title, artist, album, file_size, meta)
                    pids.append(pid)

                    await asyncio.wait_for(
                        afc.set_file_contents(
                            f'/iTunes_Control/Music/F00/{loc_filename}',
                            audio_data),
                        300)

                    try:
                        await _apply_track_artwork(afc, tmp, pid, cover_bytes, cover_mime)
                    except Exception as ae:
                        log.warning("artwork register pid=%s: %s", pid, ae)

                    _import_jobs[job_id]["results"].append({
                        "path": file_path, "ok": True, "pid": pid, "location": loc_filename, "size": file_size,
                    })
                except Exception as e:
                    log.error("import file %s fail: %s", file_path, e, exc_info=True)
                    _import_jobs[job_id]["results"].append({"path": file_path, "ok": False, "error": str(e)})

                _import_jobs[job_id]["done"] = i + 1

            try:
                await _push_media_db(afc, tmp)
                await _clear_artwork_caches(afc)
            except Exception as e:
                _import_jobs[job_id]["status"] = "error"
                _import_jobs[job_id]["error"] = f"DB upload fail: {e}"
                return

            try:
                os.remove(tmp)
            except Exception:
                pass

    except Exception as e:
        log.error("import batch fail: %s", e, exc_info=True)
        _import_jobs[job_id]["status"] = "error"
        _import_jobs[job_id]["error"] = str(e)
        return
    finally:
        if lockdown:
            try:
                await lockdown.close()
            except Exception:
                pass

    job = _import_jobs.get(job_id, {})
    if job.get("status") != "cancelled":
        job["status"] = "done"
        job["current"] = f"{len(pids)} tracks imported."


@router.get("/iphone/import_progress")
async def iphone_import_progress(job_id: str = ""):
    """Get import progress."""
    if not job_id:
        return {"ok": False, "error": "job_id required"}
    job = _import_jobs.get(job_id)
    if not job:
        return {"ok": False, "error": "job not found"}
    total = job.get("total", 1)
    done = job.get("done", 0)
    delete_total = job.get("delete_total", 0) or 0
    delete_done = len(job.get("deleted") or [])
    work_total = total + delete_total
    work_done = done + delete_done
    pct = int(work_done / work_total * 100) if work_total else 0
    if pct > 100:
        pct = 100
    phase = "delete" if (delete_total and delete_done < delete_total) else "import"
    return {
        "ok": True, "status": job.get("status", "running"),
        "total": total, "done": done, "pct": pct,
        "phase": phase,
        "delete_total": delete_total, "delete_done": delete_done,
        "current": job.get("current", ""),
        "results": job.get("results", []),
        "error": job.get("error", ""),
        "snapshot": job.get("snapshot", ""),
        "deleted": job.get("deleted", []),
    }


@router.post("/iphone/import_cancel")
async def iphone_import_cancel(payload: dict):
    """Cancel a running import job."""
    job_id = payload.get("job_id", "")
    job = _import_jobs.get(job_id)
    if job:
        job["status"] = "cancelled"
    return {"ok": True}


