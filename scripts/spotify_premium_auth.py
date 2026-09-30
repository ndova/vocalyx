#!/usr/bin/env python3
"""Otorisasi Spotify Premium sekali-pakai via Spotify Connect (tanpa password).

Alur: server Zeroconf bernama "Tokek" disiarkan di jaringan lokal ->
user memilihnya di aplikasi Spotify (HP satu WiFi / desktop) -> Spotify
mengirim blob kredensial -> librespot membuat session -> kredensial reusable
ditulis ke file --out (BUKAN password).

Dipakai HANYA oleh src/lib/spotifyPremium.ts (connect-start). Protokol stdout:
baris JSON; baris terakhir SELALU hasil akhir:
  {"ok": true, "path": "<credentials.json>", "username": "..."}
  {"ok": false, "error": "..."}

Contoh:
  python spotify_premium_auth.py --out ".spotify-premium\\credentials.json" --timeout 120
"""
import argparse
import json
import logging
import os
import shutil
import sys
import tempfile
import time

logging.basicConfig(level=logging.CRITICAL)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def fail(msg):
    emit({"ok": False, "error": str(msg)[:500]})
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Path credentials.json tujuan")
    ap.add_argument("--timeout", type=int, default=120, help="Detik menunggu user")
    ap.add_argument("--device-name", default="Tokek")
    args = ap.parse_args()

    timeout = max(15, min(300, args.timeout))

    try:
        from librespot.core import Session
        from librespot.zeroconf import ZeroconfServer
    except Exception as e:
        fail("Paket librespot belum terinstall di spotify-venv: " + str(e)[:200])

    tmpdir = tempfile.mkdtemp(prefix="sp-auth-")
    tmp_creds = os.path.join(tmpdir, "creds.json")
    try:
        conf = (
            Session.Configuration.Builder()
            .set_cache_dir(os.path.join(tmpdir, "cache"))
            .set_store_credentials(True)
            .set_stored_credential_file(tmp_creds)
            .build()
        )
        try:
            server = (
                ZeroconfServer.Builder(conf)
                .set_device_name(args.device_name)
                .create()
            )
        except Exception as e:
            fail("Gagal menyiarkan device (cek firewall/WiFi lokal): " + str(e)[:250])

        emit({"progress": 1, "stage": "waiting"})
        deadline = time.time() + timeout
        authed = False
        try:
            while time.time() < deadline:
                try:
                    if server.has_valid_session():
                        authed = True
                        break
                except Exception:
                    pass
                time.sleep(1)
        finally:
            try:
                server.close()
            except Exception:
                pass

        if not authed:
            fail("Waktu habis — pilih device di aplikasi Spotify lalu coba lagi")

        if not os.path.exists(tmp_creds):
            fail("Otorisasi diterima tapi file kredensial tidak tertulis")

        with open(tmp_creds, "r", encoding="utf-8") as f:
            stored = json.load(f)
        username = str(stored.get("username", "") or "")

        out = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tmp_out = out + ".part"
        with open(tmp_out, "w", encoding="utf-8") as f:
            json.dump(stored, f)
        if os.path.exists(out):
            os.remove(out)
        os.rename(tmp_out, out)
        # Batasi akses file (Windows: atribut bacaan pemilik saja diusahakan best-effort)
        try:
            os.chmod(out, 0o600)
        except Exception:
            pass
        emit({"ok": True, "path": out, "username": username})
        # Pastikan baris JSONสุดท้าย sampai ke pipe Node sebelum proses exit
        # (stdout piped bisa ter-buffer; tanpa flush+sleep Node kadang hanya dapat 'close' kosong)
        try:
            sys.stdout.flush()
        except Exception:
            pass
        try:
            time.sleep(0.8)
        except Exception:
            pass
        return 0
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
