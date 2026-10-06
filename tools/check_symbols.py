"""Wrapper: verifikasi hardening binary rilis VocaLyx.

Pemeriksaan sebenarnya pindah ke `tools/audit_protection.py --exe` supaya daftar
probe tidak lagi berbeda dari audit installer. Skrip ini tetap ada karena
`npm run protect:release` dan dokumentasi sudah merujuk ke nama ini.

Pemakaian:
    python tools/check_symbols.py src-tauri/target/release/vocalyx.exe
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit_protection import audit_exe  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    exe = Path(sys.argv[1])
    rc = audit_exe(exe)
    print()
    if rc:
        print("GAGAL: ada kebocoran simbol kritis - [profile.release] belum aktif?")
    else:
        print("OK: tidak ada nama fungsi/path source VocaLyx di binary.")
        print("(temuan minor: path dependency & nama command Tauri, lihat docstring)")
    return rc


if __name__ == "__main__":
    sys.exit(main())