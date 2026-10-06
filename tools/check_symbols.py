"""Verifikasi hardening binary rilis VocaLyx.

Dibedakan dua kelas temuan, karena keduanya tidak samaseverity:

  KRITIS  nama fungsi/metode milik VocaLyx sendiri, atau path `src-tauri/src`.
          Ini yang bikin Ghidra langsung menampilkan `vocalyx_lib::engine::start`
          alih-alih `FUN_0000012345`, dan yang menutup `strip = "symbols"`.

  MINOR   path absolut crate pihak ketiga + versinya, dari string lokasi panic
          (`Location::caller()` milik `unwrap`/`expect` di dependency). Tidak
          memuat source VocaLyx, tapi membocorkan versi dependency persis yang
          dipakai - enak untuk fingerprinting cari CVE. Menghilangkannya butuh
          `-Z location-detail=none` yang hanya ada di nightly Rust, jadi tidak
          dilakukan di sini.

Pemakaian:
  python tools/check_symbols.py src-tauri/target/release/vocalyx.exe
"""
import re
import sys
from pathlib import Path

# (pola, keterangan, kritis?)
PROBES = [
    (rb"apply_runtime_env", "nama fungsi engine.rs", True),
    (rb"find_engine_script", "nama fungsi engine.rs", True),
    (rb"spawn_ensure_and_start", "nama fungsi runtime.rs", True),
    (rb"write_log_note", "nama fungsi engine.rs", True),
    (rb"src-tauri[/\\]src", "path source VocaLyx", True),
    (rb"vocalyx_lib::engine::(start|restart|gpu)", "nama fungsi crate sendiri", True),
    (rb"RSDS", "entri debug directory CodeView", False),
    (rb"\.cargo[/\\]registry", "path + versi crate pihak ketiga", False),
]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    exe = Path(sys.argv[1])
    if not exe.is_file():
        print(f"tidak ada: {exe}")
        return 2

    data = exe.read_bytes()
    print(f"EXE  : {exe}")
    print(f"ukuran: {len(data):,} byte ({len(data) / 1048576:.2f} MB)\n")

    kritis = minor = 0
    for pat, why, is_krit in PROBES:
        m = re.search(pat, data, re.IGNORECASE)
        if not m:
            print(f"  aman   {why}")
            continue
        if is_krit:
            kritis += 1
            label = "KRITIS "
        else:
            minor += 1
            label = "minor  "
        s = max(0, m.start() - 60)
        ctx = data[s:m.end() + 60]
        shown = "".join(chr(c) if 32 <= c < 127 else "." for c in ctx)
        print(f"  {label} {why}")
        print(f"          ...{shown}...")

    print()
    if kritis:
        print(f"GAGAL: {kritis} kebocoran simbol kritis - [profile.release] belum aktif?")
        return 1
    print(
        f"OK: tidak ada nama fungsi/path source VocaLyx di binary."
        + (f" ({minor} temuan minor: path dependency, lihat docstring)" if minor else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
