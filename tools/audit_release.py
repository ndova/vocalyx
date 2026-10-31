"""Wrapper: audit akhir paket rilis VocaLyx.

Pemeriksaan sebenarnya pindah ke `tools/audit_protection.py --installer` supaya
daftar probe tidak lagi berbeda dari audit binary dan folder release.

Pemakaian:
    python tools/audit_release.py <installer> <tmp>
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audit_protection import audit_installer, fails  


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    installer = Path(sys.argv[1])
    tmp = Path(sys.argv[2])
    audit_installer(installer, tmp)

    print()
    print("Semua pemeriksaan selesai.")
    print()
    if fails:
        print(f"{len(fails)} GAGAL:")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("SEMUA OK: installer bersih + default sesuai")
    return 0


if __name__ == "__main__":
    sys.exit(main())