#!/usr/bin/env python3
"""Download 1 track Spotify via akun Premium (librespot, venv terisolasi).

Dipakai HANYA oleh python-engine/vx_download.py. WAJIB memakai file
kredensial reusable (hasil spotify_premium_auth.py / Connect) — login
username/password sudah dimatikan Spotify untuk app pihak ketiga, jadi
TIDAK ada jalur env kredensial user/pass lagi:
  python spotify_premium_download.py --stored-creds ".spotify-premium\\credentials.json" \
    --track ... --out ...

Protokol stdout: baris JSON. Baris terakhir SELALU hasil akhir:
  {"ok": true, "path": "<file ogg>"}
  {"ok": false, "error": "<pesan tanpa kredensial>"}
Baris {"progress": n} opsional di tengah (heartbeat agar pemanggil tahu hidup).

Contoh:
  python spotify_premium_download.py --stored-creds ".spotify-premium\\credentials.json" \
    --track 4uLU6hMCjMI75M1A2tKUQ --out "C:\\dl\\x.ogg" --quality very_high
  ... --test-login   (validasi sesi stored, lalu keluar)
"""
import argparse
import json
import logging
import os
import sys
import tempfile

# Self-bootstrap: lihat spotify_premium_auth.py (isolated interpreter
# mengabaikan PYTHONPATH; paket staging ada di direktori file ini).
def _vx_bootstrap():
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        for cand in (os.environ.get("VX_PREMIUM_PKG") or "", here):
            if cand and os.path.isdir(cand) and cand not in sys.path:
                sys.path.insert(0, cand)
    except Exception:
        pass


_vx_bootstrap()
del _vx_bootstrap

# Matikan log librespot yang berisik (tetap ke stderr, tak pernah ke stdout JSON)
logging.basicConfig(level=logging.CRITICAL)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(msg):
    emit({"ok": False, "error": str(msg)[:500]})
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", default="", help="Spotify track ID base62 / URI / URL")
    ap.add_argument("--out", default="", help="Path file .ogg tujuan")
    ap.add_argument("--quality", default="very_high", choices=["very_high", "high", "normal"])
    ap.add_argument("--test-login", action="store_true")
    ap.add_argument("--stored-creds", default="", help="Path credentials.json reusable (tanpa password)")
    ap.add_argument("--cache-dir", default="", help="Cache librespot persist (anti re-auth tiap track, TTL 24h)")
    ap.add_argument("--device-id", default="", help="Device ID persist per-install (anti fingerprint)")
    args = ap.parse_args()

    stored_creds = args.stored_creds.strip()
    if not stored_creds:
        fail("Sesi Premium belum ada — hubungkan via Spotify Connect dulu (login password sudah dimatikan Spotify)")
    if not args.test_login and not args.track:
        fail("Track ID kosong")

    try:
        from librespot.core import Session
        from librespot.audio.decoders import AudioQuality, VorbisOnlyAudioQuality
        from librespot.metadata import TrackId
    except Exception as e:
        fail("Paket librespot belum terinstall di paket premium: " + str(e)[:200])

    # Anti-banned: cache persist 24h (hemat auth) — hanya tmp download yang per-invocation.
    # tmpdir = session temp (dibersihkan), cache_dir = persist bila --cache-dir diberikan.
    import time as _time
    tmpdir = tempfile.mkdtemp(prefix="sp-prem-")
    cache_dir = args.cache_dir.strip() if hasattr(args, "cache_dir") else ""
    if cache_dir:
        try:
            os.makedirs(cache_dir, exist_ok=True)
            # TTL 24h: jika cache lebih tua, bersihkan agar token segar (hindari expired reuse)
            try:
                marker = os.path.join(cache_dir, ".cache_at")
                now = _time.time()
                if os.path.exists(marker):
                    try:
                        at = float(open(marker, "r").read().strip() or "0")
                    except Exception:
                        at = 0
                    if now - at > 24 * 3600:
                        import shutil as _sh
                        for _n in os.listdir(cache_dir):
                            _p = os.path.join(cache_dir, _n)
                            try:
                                if os.path.isdir(_p):
                                    _sh.rmtree(_p, ignore_errors=True)
                                else:
                                    os.remove(_p)
                            except Exception:
                                pass
                        open(marker, "w").write(str(now))
                else:
                    open(marker, "w").write(str(now))
            except Exception:
                pass
        except Exception:
            cache_dir = ""
    eff_cache = cache_dir if cache_dir else os.path.join(tmpdir, "cache")
    conf_builder = (
        Session.Configuration.Builder()
        .set_cache_dir(eff_cache)
        .set_stored_credential_file(os.path.join(tmpdir, "creds.json"))
    )
    # Device ID per-install (anti fingerprint statis) — librespot pakai device_id bila didukung
    try:
        _dev = (args.device_id.strip() if hasattr(args, "device_id") else "")[:64]
        if _dev:
            try:
                conf_builder.set_device_id(_dev)
            except Exception:
                pass
    except Exception:
        pass
    conf = conf_builder.build()
    if not os.path.exists(stored_creds):
        fail("File kredensial tidak ditemukan — hubungkan ulang via Spotify Connect")
    try:
        session = Session.Builder(conf).stored_file(stored_creds).create()
    except Exception as e:
        fail("Kredensial tersimpan kedaluwarsa/ditolak — hubungkan ulang: " + str(e)[:200])

    try:
        if args.test_login:
            _user = ""
            try:
                with open(stored_creds, "r", encoding="utf-8") as f:
                    _user = str(json.load(f).get("username") or "")
            except Exception:
                pass
            emit({"ok": True, "path": "", "username": _user})
            return 0

        raw = args.track.strip()
        try:
            if raw.startswith("spotify:track:") or "open.spotify.com" in raw:
                track_id = TrackId.from_uri(
                    raw if raw.startswith("spotify:") else "spotify:track:" + raw.rstrip("/").split("/")[-1].split("?")[0]
                )
            else:
                track_id = TrackId.from_base62(raw.split("?")[0])
        except Exception:
            fail("Track ID Spotify tidak valid")

        quality = {
            "very_high": AudioQuality.VERY_HIGH,
            "high": AudioQuality.HIGH,
            "normal": AudioQuality.NORMAL,
        }[args.quality]

        try:
            stream = session.content_feeder().load(
                track_id, VorbisOnlyAudioQuality(quality), False, None
            )
        except Exception as e:
            _msg = str(e)[:500]
            _low = _msg.lower()
            # Ban / throttle signal — bubble ke Node agar backoff, bukan retry buta
            if "429" in _low or "too many" in _low or "rate" in _low or "throttl" in _low:
                emit({"ok": False, "error": "rate_limited: CDN Spotify sibuk, jeda lalu retry", "retry_after": 60})
                sys.exit(2)
            if "premium" in _low and ("requir" in _low or "needed" in _low or "only" in _low):
                fail("premium_required: akun bukan Premium atau paket tidak mendukung streaming ini")
            if "disabled" in _low or "banned" in _low or "suspend" in _low or "deactivat" in _low:
                fail("account_disabled: akun dibatasi Spotify — ganti akun & hubungkan ulang")
            if "country" in _low or "region" in _low or "unavailable" in _low or "restrict" in _low:
                fail("Tidak ada file audio untuk track ini di Spotify (mungkin region-restricted): " + _msg[:200])
            fail("Tidak ada file audio untuk track ini di Spotify (mungkin region-restricted): " + _msg[:200])

        out = args.out
        if not out:
            fail("Path output kosong")
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        tmp_out = out + ".part"

        inp = stream.input_stream.stream()
        total = 0
        last_tick = 0
        with open(tmp_out, "wb") as f:
            while True:
                chunk = inp.read(128 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
                # heartbeat tiap ~2MB agar pemanggil tahu masih hidup
                if total - last_tick >= 2 * 1024 * 1024:
                    last_tick = total
                    emit({"progress": 0, "bytes": total})

        try:
            stream.input_stream.close()
        except Exception:
            pass

        if total < 1024 or not os.path.exists(tmp_out):
            fail("File audio Spotify kosong")
        # retry rename untuk WinError 32 (file terkunci Defender/antivirus sesaat)
        for _attempt in range(4):
            try:
                if os.path.exists(out):
                    os.remove(out)
                os.rename(tmp_out, out)
                break
            except Exception as e:
                msg = str(e)
                if "WinError 32" in msg or "being used by another process" in msg or "PermissionError" in msg:
                    import time as _t
                    _t.sleep(0.35)
                    continue
                fail("Gagal menyimpan file: " + msg[:200])
        else:
            fail("Gagal menyimpan file: WinError 32 setelah 4x retry")
        emit({"ok": True, "path": out, "bytes": total})
        return 0
    finally:
        try:
            session.close()
        except Exception:
            pass
        # Bersihkan cache temp (berisi potongan cache + kredensial tersimpan)
        try:
            import shutil

            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
