"""Auth engine tanpa impor torch: helper token + grep sumber server."""
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import vx_auth as va


def _check(label, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + label
          + ((" :: " + str(detail)) if detail and not cond else ""))
    if not cond:
        _check.failed += 1
_check.failed = 0


tmp = Path(tempfile.mkdtemp(prefix="vx-auth-test-"))
old_appdata, old_tok = os.environ.get("APPDATA"), os.environ.get(va.TOKEN_ENV)
os.environ["APPDATA"] = str(tmp)
os.environ.pop(va.TOKEN_ENV, None)
try:
    t1 = va.issue_engine_token()
    _check("token 64 hex acak", len(t1) == 64 and all(c in "0123456789abcdef" for c in t1))
    _check("token tertulis ke file user-private",
           (tmp / "VocaLyx" / "engine-token").read_text(encoding="ascii").strip() == t1)
    t2 = va.issue_engine_token()
    
    
    
    _check("token dipakai ulang antar restart", t2 == t1 and len(t2) == 64)
    (tmp / "VocaLyx" / "engine-token").unlink()
    t3 = va.issue_engine_token()
    _check("token dirotasi bila file dihapus", t3 != t1 and len(t3) == 64)
    os.environ[va.TOKEN_ENV] = "kunci-manual"
    _check("override env dihormati", va.issue_engine_token() == "kunci-manual")
finally:
    if old_appdata is None:
        os.environ.pop("APPDATA", None)
    else:
        os.environ["APPDATA"] = old_appdata
    if old_tok is None:
        os.environ.pop(va.TOKEN_ENV, None)
    else:
        os.environ[va.TOKEN_ENV] = old_tok

_check("health+peaks tetap terbuka (probe Rust tanpa header)",
       "/health" in va.OPEN_PATHS and "/peaks" in va.OPEN_PATHS)
_check("cover iPhone terbuka tanpa token (tag img tak bisa kirim header)",
       "/iphone/track/cover" in va.OPEN_PATHS
       and "/iphone/library/tracks" not in va.OPEN_PATHS)
_check("CORS tanpa wildcard", "*" not in va.ALLOW_ORIGINS
       and any("tauri" in o for o in va.ALLOW_ORIGINS))
_check("header token diizinkan CORS", va.TOKEN_HEADER in va.ALLOW_HEADERS)

src = (HERE.parent / "server.py").read_text(encoding="utf-8")
_check("server pakai compare_digest (anti timing leak)",
       "compare_digest" in src and "TOKEN_HEADER" in src)
_check("server tanpa allow_origins wildcard", 'allow_origins=["*"]' not in src)
_check("OPTIONS lolos (preflight browser)", '"OPTIONS"' in src or "'OPTIONS'" in src)

if _check.failed:
    print(f"\n{_check.failed} GAGAL")
    sys.exit(1)
print("\nsemua ok")
