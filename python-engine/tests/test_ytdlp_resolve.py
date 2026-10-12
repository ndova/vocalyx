"""Resolver yt-dlp milik interpreter engine (bukan tebak PATH sistem)."""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from vx_core import yt_dlp_cmd


fails = 0


def check(label, cond, detail=""):
    global fails
    print(("PASS  " if cond else "FAIL  ") + label
          + ((" :: " + str(detail)) if detail and not cond else ""))
    if not cond:
        fails += 1


cmd = yt_dlp_cmd()
check("yt-dlp ketemu", bool(cmd), "pastikan runtime dilengkapi (requirements)")
if cmd:
    check("argv list", isinstance(cmd, list) and len(cmd) >= 1, repr(cmd)[:80])
    try:
        r = subprocess.run(cmd + ["--version"], capture_output=True, text=True, timeout=30)
        check("bisa --version", r.returncode == 0, (r.stderr or r.stdout or "")[:120])
    except Exception as e:
        check("bisa --version", False, str(e)[:120])
    if len(cmd) == 3 and cmd[1] == "-m":
        check("modul milik interpreter sendiri (-m)", cmd[0] == sys.executable, repr(cmd)[:80])
    else:
        home = Path(sys.executable).resolve().parent
        check("launcher dari Scripts interpreter sendiri (bukan kebetulan PATH)",
              Path(cmd[0]).resolve().parent in (home, home / "Scripts"), cmd[0])

print()
if fails:
    print(f"{fails} GAGAL")
    sys.exit(1)
print("semua ok")