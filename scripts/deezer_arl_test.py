#!/usr/bin/env python3
"""Test login ARL Deezer + deteksi tier (tanpa download apa pun).

ARL HANYA via env var DEEZER_ARL (tidak pernah argv/log/output).
Cetak SATU baris JSON ke stdout:
  {"ok": true, "tier": "free|premium|premium-flac", "maxQuality": "MP3_128|MP3_320|FLAC", "username": "..."}
  {"ok": false, "error": "ARL_KOSONG|ARL_INVALID|JARINGAN|..."}
Exit 0 selalu bila JSON tercetak (caller baca stdout); exit 2 bila gagal total.
"""
import json
import os
import sys
import traceback


def out(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def main():
    arl = str(os.environ.get("DEEZER_ARL", "") or "").strip()
    if not arl:
        out({"ok": False, "error": "ARL_KOSONG"})
        return 0
    if len(arl) < 32 or len(arl) > 512 or any(c in arl for c in ("\0", "\n", "\r")):
        out({"ok": False, "error": "ARL_INVALID"})
        return 0
    try:
        from deezer import Deezer
    except Exception as e:
        out({"ok": False, "error": "LIB_MISSING: " + str(e)[:120]})
        return 0
    try:
        client = Deezer()
        ok = client.login_via_arl(arl)
    except Exception as e:
        msg = str(e)[:160]
        out({"ok": False, "error": "JARINGAN: " + msg if msg else "JARINGAN"})
        return 0
    if not ok:
        out({"ok": False, "error": "ARL_INVALID"})
        return 0
    try:
        user = client.current_user or {}
        name = str(user.get("BLOG_NAME") or user.get("USER_NAME") or "").strip()
        if user.get("can_stream_lossless"):
            tier, q = "premium-flac", "FLAC"
        elif user.get("can_stream_hq"):
            tier, q = "premium", "MP3_320"
        else:
            tier, q = "free", "MP3_128"
        out({"ok": True, "tier": tier, "maxQuality": q, "username": name})
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        out({"ok": False, "error": "PARSE_GAGAL"})
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        try:
            out({"ok": False, "error": "FATAL"})
        except Exception:
            pass
        sys.exit(2)
