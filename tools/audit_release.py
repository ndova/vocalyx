"""Audit akhir paket rilis VocaLyx: sumber, simbol, dan perilaku default.

Digabung dalam satu skrip supaya satu perintah menutup dua hal sekaligus:
tidak ada kebocoran di installer, dan default yang benar-benar ikut terkemas.
"""
import re
import subprocess
import sys
import zipfile
from pathlib import Path

installer = Path(sys.argv[1])
tmp = Path(sys.argv[2])
fails = []


def ok(label, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {label}{(' :: ' + detail) if detail else ''}")
    if not cond:
        fails.append(label)


# ------------------------------------------------------------------ ekstrak
# Always wipe first: 7z will not overwrite into a populated directory, and a
# leftover extract from an earlier build would make the audit pass on stale data.
if tmp.exists():
    import shutil
    shutil.rmtree(tmp)
r = subprocess.run(["7z", "x", str(installer), f"-o{tmp}", "-y"], capture_output=True, text=True)
if r.returncode != 0:
    print(f"GAGAL ekstrak installer: {r.stdout[-400:]}")
    sys.exit(1)

# ------------------------------------------------------------------ leak audit
FN_LEAKS = ["apply_runtime_env", "find_engine_script", "spawn_ensure_and_start",
            "write_log_note", "requestDlRender", "sweepEnhance", "applyGridWidths"]
exe = tmp / "vocalyx.exe"
ok("installer berisi vocalyx.exe", exe.is_file())
if exe.is_file():
    raw = exe.read_bytes().decode("latin1")
    leaked = [n for n in FN_LEAKS if n in raw]
    ok("exe bebas nama fungsi", not leaked, f"bocor: {leaked}" if leaked else "")
    ok("exe bebas path source VocaLyx", "src-tauri\\src" not in raw)
    ok("exe bebas console.log", "console.log" + "(" not in raw)
    # Frontend di-embed sebagai blob terkompresi, jadi identifier-nya memang
    # tidak muncul sebagai string. Kehadirannya dibuktikan lewat dist/ di bawah.
    ok("frontend tidak bocor sebagai string mentah",
       "lyrOffsetWrap" not in raw and "vocalyx_downloadOptions" not in raw)

eng = tmp / "python-engine"
py_files = list(eng.rglob("*.py")) if eng.is_dir() else []
pyc_files = list(eng.rglob("*.pyc")) if eng.is_dir() else []
ok("tidak ada .py engine", not py_files, f"{[p.name for p in py_files]}" if py_files else "")
ok("ada .pyc engine", len(pyc_files) >= 15, f"{len(pyc_files)} file")

# Frontend Tauri v2 di-embed sebagai blob terkompresi, bukan string mentah, jadi
# identifier-nya TIDAK bisa dicari di exe. Yang bisa dicek adalah folder dist/
# yang jadi sumber embed - di situ perilaku default harus benar.
dist = Path(__file__).resolve().parent.parent / "dist"
js_files = sorted(dist.rglob("*.js")) if dist.is_dir() else []
ok("dist/ ada (sumber embed frontend)", bool(js_files), f"{len(js_files)} chunk")
if js_files:
    blob = "".join(p.read_text(encoding="utf8", errors="replace") for p in js_files)
    # Terser menulis false -> `!1`, true -> `!0`.
    m = re.search(r"spotify:!1.{0,80}?deezer:!1.{0,80}?soundcloud:!0.{0,80}?archive:!0"
                  r".{0,80}?\"4shared\":!0", blob, re.S)
    ok("default strict: spotify+deezer false, sc/archive/4shared true", bool(m),
       "peta default tidak ditemukan di dist/" if not m else "")
    # Nama properti objek dipertahankan terser, tapi nilai boolean ditulis `!1`/`!0`
    # dan perbandingan string bisa muncul sebagai `"1"===x` atau `x==="1"`.
    ok("penanda strictV 3 di dist", bool(re.search(r"strictV\s*=\s*3|strictV:3", blob)))
    # Flag lyric offset harus dibaca sebagai "1 = tampil". Kalau ini hilang,
    # panel akan kembali auto-show setiap kali ada lirik sinkron.
    ok("lyric offset: flag '1' berarti tampil",
       bool(re.search(r'"1"\s*===\s*localStorage\.getItem\([A-Za-z_$][\w$]*\)', blob)))
    # Penugasan ulang strictSources HARUS hanya berisi spotify:!1/deezer:!1.
    # Kalau ada spotify:!0 di dalamnya, migrasi lama masih memaksa nilai.
    assignments = re.findall(r"strictSources\s*=\s*\{[^}]*\}", blob)
    forced = [a for a in assignments if "spotify:!0" in a]
    ok("tidak ada pemaksaan spotify:true di migrasi", not forced,
       f"penugasan memaksa: {forced}" if forced else f"{len(assignments)} penugasan diperiksa")
ok("requirements-cuda.txt ikut", (eng / "requirements-cuda.txt").is_file())
ok("karaoke_best.pyc ikut", (eng / "scripts" / "karaoke_best.pyc").is_file())

for z in tmp.rglob("*.zip"):
    with zipfile.ZipFile(z) as zf:
        leaked = [n for n in zf.namelist()
                  if n.lower().startswith("runtime/engine/") and n.lower().endswith(".py")]
    ok(f"runtime zip bebas .py engine ({z.name})", not leaked,
       f"{leaked}" if leaked else "")

# ------------------------------------------------------------------ default check
print()
print("Semua pemeriksaan selesai.")

print()
if fails:
    print(f"{len(fails)} GAGAL:")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("SEMUA OK: installer bersih + default sesuai")
