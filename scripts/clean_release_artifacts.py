
"""Buang artefak build rilis yang membocorkan peta simbol tapi tak pernah masuk installer.

`tauri build` mengisi `src-tauri/target/release/` dengan lebih dari yang benar-benar
dipakai user. Hasil audit: isi NSIS 695 MB hanya `vocalyx.exe`, resource
(`assets/`, `python-engine/*.pyc`), dan `runtime-bundle.zip`. Sementara sisanya
tinggal di disk build:

    vocalyx_lib.lib      247 MB   `spawn_ensure_and_start` 85 hit
    libvocalyx_lib.rlib  108 MB   `detect_pythons` 619 hit, `scan_music` 132
    vocalyx.pdb          3.7 MB   path developer + command line linker
    vocalyx_lib.pdb      2.6 MB   path developer
    *.d                  29 KB    dependency file, path absolut

Artefak ini intermediate, bisa dibangun ulang, dan tidak pernah dibaca runtime
atau installer. Menghapusnya menghemat ~360 MB sekaligus menutup celah decompile
yang tidak bisa ditutup dari dalam binary.

BEDA dari `clean_release_stage.py`: yang itu menyalin ulang resource engine
(Tauri MERGE, bukan replace, jadi `.py` basi ikut terbawa). Yang ini menyingkirkan
output library yang memang tidak pernah dibundel.

Tidak ada `afterBuildCommand` di Tauri, jadi skrip ini TIDAK bisa dijalankan
otomatis lewat `beforeBuildCommand` - file-nya belum ada saat itu. Jalankan
manual sesudah `npm run tauri build` lewat `npm run protect:release`.

Pemakaian:
    python scripts/clean_release_artifacts.py            # bersihkan
    python scripts/clean_release_artifacts.py --check    # verifikasi saja, exit 1 bila bocor
    python scripts/clean_release_artifacts.py --dry-run  # tampilkan rencana
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / "src-tauri" / "target" / "release"
DEPS = RELEASE / "deps"









TARGETS = [
    ("", "vocalyx_lib.lib", "import lib cdylib (bocor nama fungsi)"),
    ("", "libvocalyx_lib.rlib", "intermediate rlib (bocor nama fungsi)"),
    ("", "vocalyx.pdb", "debug info binary (bocor path developer)"),
    ("", "vocalyx_lib.pdb", "debug info library (bocor path developer)"),
    ("", "vocalyx_lib.dll", "output cdylib, tidak dipakai desktop"),
    ("", "vocalyx_lib.dll.exp", "export table cdylib"),
    ("", "vocalyx_lib.dll.lib", "import lib cdylib"),
    ("", "*.d", "dependency file (bocor path absolut)"),
    ("deps", "libvocalyx_lib-*.rlib", "intermediate rlib di deps/ (bocor nama fungsi)"),
    ("deps", "libvocalyx_lib-*.rmeta", "metadata crate di deps/ (bocor nama fungsi)"),
    ("deps", "vocalyx.pdb", "debug info binary di deps/ (bocor path developer)"),
    ("deps", "vocalyx.exe", "duplicate pre-link binary di deps/"),
    ("deps", "vocalyx*.d", "dependency file VocaLyx di deps/ (bocor path absolut)"),
]




KEEP = {"vocalyx.exe"}



_DEBUG_DIR_FMT = "<IIHHIIII"
_DEBUG_DIR_SIZE = struct.calcsize(_DEBUG_DIR_FMT)
_IMAGE_DEBUG_TYPE_CODEVIEW = 2

_DEBUG_DIR_INDEX = 6


def log(msg: str) -> None:
    print(f"[clean-artifacts] {msg}", flush=True)


def _pe_sections(d: bytes, opt: int, optsz: int, nsec: int) -> list[tuple[int, int, int, int]]:
    """Baca header section jadi [(va, vsize, ra, rsize)] untuk RVA -> file offset."""
    secs: list[tuple[int, int, int, int]] = []
    table = opt + optsz
    for i in range(nsec):
        off = table + i * 40
        vsize, va, rsize, ra = struct.unpack_from("<IIII", d, off + 8)
        secs.append((va, vsize, ra, rsize))
    return secs


def _rva_to_offset(rva: int, secs: list[tuple[int, int, int, int]]) -> int | None:
    for va, vsize, ra, rsize in secs:
        if va and va <= rva < va + max(vsize, rsize):
            return ra + (rva - va)
    return None


def strip_codeview(exe: Path, dry: bool = False) -> int:
    """Nolkan entri debug CodeView (RSDS) pada exe PE.

    `strip = "symbols"` di Cargo.toml sudah membuang nama fungsi, tapi entri
    debug directory tipe 2 (CodeView) masih menunjuk `vocalyx.pdb`. Setelah
    .pdb dihapus, pointer itu jadi sia-sia - tapi namanya sendiri masih
    terbaca dari binary.

    `llvm-strip` tidak tersedia di toolchain ini dan `rust-objcopy` ternyata
    tidak menyentuh debug directory pada PE (diverifikasi: --strip-all,
    --strip-debug, --strip-unneeded, -S, -g semuanya menyisakan RSDS utuh),
    jadi penulisan dilakukan langsung ke header PE.

    Entri_codeview ditulis ulang dengan Type=0 dan SizeOfData=0 supaya loader
    Windows mengabaikannya; byte RSDS-nya sendiri ikut dinolkan.
    """
    if not exe.is_file():
        return 0
    data = bytearray(exe.read_bytes())
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\x00\x00":
        log(f"lewati {exe.name}: bukan file PE")
        return 0
    coff = pe + 4
    nsec = struct.unpack_from("<H", data, coff + 2)[0]
    optsz = struct.unpack_from("<H", data, coff + 16)[0]
    opt = coff + 20
    magic = struct.unpack_from("<H", data, opt)[0]
    dd = opt + (112 if magic == 0x20B else 96)
    rva, size = struct.unpack_from("<II", data, dd + _DEBUG_DIR_INDEX * 8)
    if not rva or not size:
        return 0
    secs = _pe_sections(bytes(data), opt, optsz, nsec)
    base = _rva_to_offset(rva, secs)
    if base is None:
        log(f"lewati {exe.name}: debug directory tidak terpetakan")
        return 0

    patched = 0
    for i in range(size // _DEBUG_DIR_SIZE):
        off = base + i * _DEBUG_DIR_SIZE
        _, _, _, _, typ, dsize, _, raw = struct.unpack_from(_DEBUG_DIR_FMT, data, off)
        if typ != _IMAGE_DEBUG_TYPE_CODEVIEW or not dsize:
            continue
        if data[raw:raw + 4] != b"RSDS":
            continue
        patched += 1
        if dry:
            continue
        struct.pack_into(_DEBUG_DIR_FMT, data, off, 0, 0, 0, 0, 0, 0, 0, 0)
        data[raw:raw + dsize] = b"\x00" * dsize

    if not patched:
        return 0
    if dry:
        log(f"[dry-run] {patched} entri CodeView (RSDS) akan dinolkan di {exe.name}")
        return patched
    exe.write_bytes(bytes(data))
    log(f"nolkan {patched} entri CodeView (RSDS) di {exe.name}")
    return patched


def find() -> list[tuple[Path, str, int]]:
    """Kembalikan [(path, keterangan, ukuran)] untuk target yang ada."""
    hits: list[tuple[Path, str, int]] = []
    seen: set[Path] = set()
    for sub, pattern, why in TARGETS:
        base = RELEASE / sub if sub else RELEASE
        if not base.is_dir():
            continue
        keep = KEEP if not sub else set()
        for p in sorted(base.glob(pattern)):
            if not p.is_file() or p.name in keep or p in seen:
                continue
            seen.add(p)
            hits.append((p, why, p.stat().st_size))
    return hits


def clean(dry: bool = False) -> int:
    hits = find()
    if hits:
        for path, why, size in hits:
            mb = size / 1048576
            where = "deps/" if path.parent == DEPS else ""
            if dry:
                log(f"[dry-run] hapus {where}{path.name} ({mb:.1f} MB) - {why}")
                continue
            path.unlink()
            log(f"hapus {where}{path.name} ({mb:.1f} MB) - {why}")
        total = sum(s for _, _, s in hits) / 1048576
        if not dry:
            log(f"total dibersihkan: {total:.1f} MB")
    else:
        log("tidak ada artefak library untuk dibersihkan")
    strip_codeview(RELEASE / "vocalyx.exe", dry)
    return 0


def check() -> int:
    rc = 0
    hits = find()
    if hits:
        log(f"GAGAL: {len(hits)} artefak pembocor masih ada di target/release/:")
        for path, why, size in hits:
            where = "deps/" if path.parent == DEPS else ""
            log(f"  - {where}{path.name} ({size / 1048576:.1f} MB) - {why}")
        log("jalankan `npm run protect:release` setelah `npm run tauri build`")
        rc = 1
    elif RELEASE.is_dir():
        log(f"OK {RELEASE.relative_to(ROOT).as_posix()}: tidak ada artefak library bocor")

    exe = RELEASE / "vocalyx.exe"
    if exe.is_file():
        raw = exe.read_bytes()
        leaked = [s for s in (b"RSDS", b"vocalyx.pdb") if s in raw]
        if leaked:
            log(f"GAGAL: exe masih punya entri debug {[s.decode() for s in leaked]}")
            rc = 1
        else:
            log("OK vocalyx.exe: entri debug CodeView sudah dinolkan")
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(description="Bersihkan artefak library/debug dari target/release")
    ap.add_argument("--check", action="store_true", help="hanya verifikasi, jangan hapus")
    ap.add_argument("--dry-run", action="store_true", help="tampilkan rencana tanpa menghapus")
    args = ap.parse_args()
    if args.check:
        return check()
    clean(args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())