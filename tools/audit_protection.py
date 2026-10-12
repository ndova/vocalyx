"""Audit proteksi binary VocaLyx - satu sumber kebenaran untuk tiga target.

Dulu pemeriksaannya tersebar di `check_symbols.py` (exe) dan `audit_release.py`
(installer), masing-masing dengan daftar probe sendiri yang tidak identik. Skrip
ini menggabungkan keduanya plus target baru (`--release-dir`) supaya satu
perintah menutup seluruh permukaan bocor dan Daftar probe tidak bisa lagi
berdiverensi diam-diam.

Tiga target:

  --exe <path>       Binary rilis. Yang paling penting: nama fungsi & path source.
  --release-dir <d>  Folder hasil build. Artefak library/debug di sini tidak
                     pernah masuk installer tapi bocorkan peta simbol.
  --installer <f>    Installer sungguhan (NSIS/MSI). Sumber yang benar-benar
                     dikirim ke user.

Dua kelas temuan, dibedakan karena severity-nya tidak sama:

  KRITIS  nama fungsi/method milik VocaLyx sendiri, atau path `src-tauri/src`.
          Ini yang bikin Ghidra langsung menampilkan `vocalyx_lib::engine::start`
          alih-alih `FUN_0000012345`, dan yang ditutup oleh `strip = "symbols"`.

  MINOR   (a) path absolut crate pihak ketiga + versinya, dari string lokasi
          panic (`Location::caller()` milik `unwrap`/`expect` di dependency).
          Tidak memuat source VocaLyx, tapi membocorkan versi dependency persis
          yang dipakai - enak untuk fingerprinting cari CVE. Menghilangkannya
          butuh `-Z location-detail=none` yang hanya ada di nightly Rust.
          (b) nama command Tauri. String ini wajib ada untuk IPC dan tidak
          bisa dihapus tanpa obfuscation Rust tambahan, jadi ditandai supaya
          terlihat saat review, bukan diperlakukan sebagai kegagalan.

Pemakaian:
    python tools/audit_protection.py --exe src-tauri/target/release/vocalyx.exe
    python tools/audit_protection.py --release-dir src-tauri/target/release
    python tools/audit_protection.py --installer <installer> <tmp>
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (pola bytes, keterangan, kritis?)
# Nama fungsi Rust milik VocaLyx + path source. KRITIS.
PROBES_CRITICAL = [
    (rb"apply_runtime_env", "nama fungsi engine.rs", True),
    (rb"find_engine_script", "nama fungsi engine.rs", True),
    (rb"spawn_ensure_and_start", "nama fungsi runtime.rs", True),
    (rb"write_log_note", "nama fungsi engine.rs", True),
    (rb"src-tauri[/\\]src", "path source VocaLyx", True),
    (rb"vocalyx_lib::engine::(start|restart|gpu)", "nama fungsi crate sendiri", True),
]

# Path absolut dependency + entri CodeView. MINOR, alasannya di docstring.
PROBES_MINOR = [
    (rb"RSDS", "entri debug directory CodeView", False),
    (rb"\.cargo[/\\]registry", "path + versi crate pihak ketiga", False),
    (rb"vocalyx\.pdb", "nama PDB di debug directory", False),
]

# Nama command Tauri. String wajib untuk IPC - MINOR, bukan gagal.
TAURI_COMMANDS = [
    b"get_engine_config",
    b"set_engine_config",
    b"detect_pythons",
    b"gpu_probe_cached",
    b"cuda_setup_start",
    b"runtime_extract_bundled",
    b"scan_music",
    b"smtc_set_metadata",
]

# Artefak di target/release/ yang tidak pernah masuk installer tapi bocor.
# Root saja sudah bersih setelah crate-type disederhanakan ke rlib; sisanya
# pindah ke deps/ dengan nama ber-hash, jadi harus dicek terpisah.
RELEASE_DIR_JUNK = [
    "vocalyx_lib.lib",
    "libvocalyx_lib.rlib",
    "vocalyx.pdb",
    "vocalyx_lib.pdb",
    "vocalyx_lib.dll",
    "vocalyx_lib.dll.exp",
    "vocalyx_lib.dll.lib",
]

# Di deps/: intermediate milik VocaLyx saja. Artefak dependency milik orang lain
# dibiarkan - isinya cuma path registry + versi crate (minor), dan menghapusnya
# akan memaksa compile ulang seluruh graph.
DEPS_JUNK_GLOBS = [
    "libvocalyx_lib-*.rlib",
    "libvocalyx_lib-*.rmeta",
    "vocalyx.pdb",
    "vocalyx.exe",
    "vocalyx*.d",
]

fails: list[str] = []


def ok(label: str, cond: bool, detail: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{(' :: ' + detail) if detail else ''}", flush=True)
    if not cond:
        fails.append(label)


def _scan(data: bytes, probes, show_ctx: bool = True) -> None:
    """Jalankan probe atas data; uptick ke fails kalau ada yang kritis kena."""
    for pat, why, is_krit in probes:
        m = re.search(pat, data, re.IGNORECASE)
        if not m:
            print(f"  aman   {why}")
            continue
        label = "KRITIS " if is_krit else "minor  "
        print(f"  {label} {why}")
        if show_ctx:
            s = max(0, m.start() - 60)
            ctx = data[s:m.end() + 60]
            shown = "".join(chr(c) if 32 <= c < 127 else "." for c in ctx)
            print(f"          ...{shown}...")
        if is_krit:
            fails.append(f"probe: {why}")


# ------------------------------------------------------------------ --exe
def audit_exe(exe: Path) -> int:
    if not exe.is_file():
        print(f"tidak ada: {exe}")
        return 2
    data = exe.read_bytes()
    print(f"EXE  : {exe}")
    print(f"ukuran: {len(data):,} byte ({len(data) / 1048576:.2f} MB)\n")

    _scan(data, PROBES_CRITICAL)
    _scan(data, PROBES_MINOR)

    found_cmds = [c.decode() for c in TAURI_COMMANDS if c in data]
    print(f"  minor   {len(found_cmds)} nama command Tauri sebagai string "
          f"(wajib untuk IPC, tidak bisa dihapus tanpa obfuscation Rust)")
    if found_cmds:
        print(f"          {', '.join(found_cmds)}")

    # Frontend Tauri v2 di-embed sebagai blob terkompresi, jadi identifier-nya
    # tidak muncul sebagai string mentah di exe. Yang bisa dicek adalah dist/.
    ok("frontend tidak bocor sebagai string mentah",
       b"lyrOffsetWrap" not in data and b"vocalyx_downloadOptions" not in data)
    ok("exe bebas console.log", b"console.log(" not in data)

    return 1 if any(f.startswith("probe:") for f in fails) else 0


# --------------------------------------------------------- --release-dir
def audit_release_dir(release: Path) -> int:
    if not release.is_dir():
        print(f"OK {release}: belum dibangun (lewati)")
        return 0
    print(f"RELEASE DIR: {release}\n")

    junk = [(n, (release / n).stat().st_size) for n in RELEASE_DIR_JUNK if (release / n).is_file()]
    ok("tidak ada artefak library bocor (.rlib/.lib/.dll/.pdb)", not junk,
       ", ".join(f"{n} {s / 1048576:.1f} MB" for n, s in junk) if junk else "")

    dotd = sorted(p.name for p in release.glob("*.d"))
    ok("tidak ada dependency file .d (bocor path absolut)", not dotd, ", ".join(dotd))

    deps = release / "deps"
    if deps.is_dir():
        djunk: list[tuple[str, int]] = []
        for pattern in DEPS_JUNK_GLOBS:
            for p in sorted(deps.glob(pattern)):
                if p.is_file():
                    djunk.append((p.name, p.stat().st_size))
        ok("tidak ada artefak VocaLyx bocor di deps/ (rlib/rmeta/pdb/exe)", not djunk,
           ", ".join(f"{n} {s / 1048576:.1f} MB" for n, s in djunk) if djunk else "")
    else:
        print("INFO deps/ belum ada (lewati)")

    exe = release / "vocalyx.exe"
    if exe.is_file():
        raw = exe.read_bytes()
        leaked = [s.decode() for s in (b"RSDS", b"vocalyx.pdb") if s in raw]
        ok("exe tanpa entri debug CodeView", not leaked, ", ".join(leaked))
    else:
        print("INFO vocalyx.exe belum dibangun (lewati cek CodeView)")

    print()
    print("Jalankan `npm run protect:release` setelah `npm run tauri build`")
    print("untuk membersihkan artefak di atas.")
    return 0


# ---------------------------------------------------------- --installer
FN_LEAKS = [n.encode() for n in
            ["apply_runtime_env", "find_engine_script", "spawn_ensure_and_start",
             "write_log_note", "requestDlRender", "sweepEnhance", "applyGridWidths"]]


def _extract(installer: Path, tmp: Path) -> bool:
    """Bentangkan installer ke folder datar, sesuai formatnya.

    NSIS itu arsip biasa, jadi `7z x` menghasilkan pohon folder apa adanya.
    MSI itu database: `7z x` mencabut file CAB-nya sebagai stream datar bernama
    `PathFile_I<hash>`, TIDAK pernah menghasilkan `vocalyx.exe` atau
    `python-engine/`. Versi lama audit_release.py selalu pakai `7z x`, jadi MSI
    lolos dengan 4 kegagalan membingungkan (bukan kelewatan diam-diam - tetap
    exit 1, tapi penyebabnya salah).

    MSI dibentangkan lewat administrative install, yang tidak meregistrasikan
    produk ke sistem: hanya men-copy payload ke folder tujuan.
    """
    if installer.suffix.lower() == ".msi":
        tmp.mkdir(parents=True, exist_ok=True)
        # HARUS satu string via shell: msiexec menolak argv list hasil
        # list2cmdline Python (1639 invalid command line), tapi menerima
        # string perintah yang sama persis.
        cmd = (f'msiexec /a "{installer}" /qb TARGETDIR="{tmp}" '
               f'/l*v "{tmp / "msi.log"}"')
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=1800, shell=True)
        # msiexec sering balik non-nol meski sukses; yangdicek hasil kerjanya.
        exe = tmp / "vocalyx.exe"
        if not exe.is_file():
            found = list(tmp.rglob("vocalyx.exe"))
            if not found:
                print(f"GAGAL bentangkan MSI (rc={r.returncode}): {r.stdout[-300:]}")
                return False
            found[0].replace(exe)
        return True
    r = subprocess.run(["7z", "x", str(installer), f"-o{tmp}", "-y"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"GAGAL ekstrak installer: {r.stdout[-400:]}")
        return False
    return True


def audit_installer(installer: Path, tmp: Path) -> int:
    if not installer.is_file():
        print(f"tidak ada: {installer}")
        return 2
    # Always wipe first: 7z will not overwrite into a populated directory, and a
    # leftover extract from an earlier build would make the audit pass on stale data.
    if tmp.exists():
        shutil.rmtree(tmp)
    if not _extract(installer, tmp):
        return 1
    print(f"INSTALLER: {installer}\n")

    exe = tmp / "vocalyx.exe"
    ok("installer berisi vocalyx.exe", exe.is_file())
    if exe.is_file():
        _scan(exe.read_bytes(), [(p, w, True) for p, w, _ in PROBES_CRITICAL[:5]])
        raw = exe.read_bytes().decode("latin1")
        leaked = [n.decode() for n in FN_LEAKS if n in exe.read_bytes()]
        ok("exe bebas nama fungsi", not leaked, f"bocor: {leaked}" if leaked else "")
        ok("exe bebas path source VocaLyx", "src-tauri\\src" not in raw)
        ok("exe bebas console.log", "console.log(" not in raw)
        ok("frontend tidak bocor sebagai string mentah",
           "lyrOffsetWrap" not in raw and "vocalyx_downloadOptions" not in raw)

    # Prasyarat MSVC runtime untuk engine (torch/onnxruntime).
    # `bundle.resources` memetakan SELURUH folder `assets` ke `assets`, jadi
    # file rilis duduk di `assets/vcredist/vc_redist.x64.exe` - dan Rust mencari
    # path itu persis (lihat VC_RESOURCE di src-tauri/src/runtime.rs). Kalau
    # layout ini berubah tanpa Updating Rust, auto-install kembali gagal
    # diam-diam: ini bug yang pernah terjadi, jadi jalurnya ikut diawasi.
    vc_exes = [p for p in tmp.rglob("vc_redist.x64.exe") if p.is_file()]
    ok("installer membawa VC Redistributable", bool(vc_exes),
       ", ".join(p.relative_to(tmp).as_posix() for p in vc_exes) or "tidak ditemukan")
    if vc_exes:
        ok("layout VC Redist sesuai yang dicari Rust (assets/vcredist)",
           all("assets/vcredist" in p.relative_to(tmp).as_posix() for p in vc_exes),
           ", ".join(p.relative_to(tmp).as_posix() for p in vc_exes))
        ok("VC Redist x64 utuh (±25 MB)", vc_exes[0].stat().st_size > 10_000_000,
           f"{vc_exes[0].stat().st_size / 1e6:.1f} MB")

    # NSIS menaruh payload di root folder ekstrak; MSI memakai
    # PFiles/VocaLyx/. Cari foldernya, jangan andalkan path tetap.
    eng_dirs = [p for p in tmp.rglob("python-engine") if p.is_dir()]
    ok("installer punya folder python-engine", bool(eng_dirs),
       ", ".join(str(p.relative_to(tmp)) for p in eng_dirs))
    eng = eng_dirs[0] if eng_dirs else None
    py_files = list(eng.rglob("*.py")) if eng else []
    pyc_files = list(eng.rglob("*.pyc")) if eng else []
    ok("tidak ada .py engine", not py_files,
       f"{[p.name for p in py_files]}" if py_files else "")
    ok("entry+loader clear (server, vx_vault)", bool(eng) and all(
        (eng / f"{s}.pyc").is_file() for s in ("server", "vx_vault")))
    ok("requirements-cuda.txt ikut", bool(eng and (eng / "requirements-cuda.txt").is_file()))
    ok("karaoke_best.pyv ikut",
       bool(eng and (eng / "scripts" / "karaoke_best.pyv").is_file()))
    # Vault engine (lihat python-engine/vx_vault.py): semua modul proprietary
    # dikirim sebagai .pyv terenkripsi; hanya server+loader yang clear .pyc.
    eng_vault = [p for p in (eng.rglob("*.pyv") if eng else [])]
    ok("vault engine ikut", len(eng_vault) >= 10, f"{len(eng_vault)} file")
    if eng is not None:
        stray = sorted(p.relative_to(eng).as_posix() for p in eng.rglob("*.pyc")
                       if p.stem not in ("server", "vx_vault"))
        ok("tidak ada .pyc proprietary sisa", not stray,
           f"bocor: {stray[:5]}" if stray else "")
        bad_vault = [p.name for p in eng_vault
                     if p.read_bytes()[:8] != b"VXVAULT1"]
        ok("vault engine berformat valid", not bad_vault,
           f"rusak: {bad_vault}" if bad_vault else "")
    if pyc_files:
        path_leaks = [p for p in pyc_files
                      if b"D:\\Folder Baru" in p.read_bytes()
                      or b"D:/Folder Baru" in p.read_bytes()
                      or b"vocalyx\\build" in p.read_bytes()
                      or b"vocalyx/build" in p.read_bytes()]
        ok("engine .pyc bebas path absolut builder", not path_leaks,
           f"bocor: {[p.name for p in path_leaks][:5]}" if path_leaks else "")
        doc_leaks = [p for p in pyc_files if p.stem != "server"
                     and b"VocaLyx Python engine: FastAPI" in p.read_bytes()]
        ok("engine .pyc bebas docstring modul", not doc_leaks,
           f"bocor: {[p.name for p in doc_leaks][:5]}" if doc_leaks else "")

    # Paket premium (librespot/deemix) ikut terbundel sebagai bytecode.
    # Tanpa ini, Test Login / Connect Spotify & ARL Deezer gagal di mesin
    # pengguna karena scripts/*-venv memang tidak pernah ikut installer.
    prem = eng.parent / "premium" if eng else None
    ok("installer punya folder premium", bool(prem and prem.is_dir()),
       str(prem) if prem else "")
    if prem and prem.is_dir():
        ppy = [p for p in prem.rglob("*.py")]
        ok("premium bebas .py", not ppy,
           f"bocor: {[str(p.relative_to(prem)) for p in ppy][:5]}" if ppy else "")
        for svc, glues in (("spotify", ("spotify_premium_download", "spotify_premium_auth")),
                           ("deezer", ("deezer_download", "deezer_arl_test"))):
            d = prem / svc
            ok(f"paket {svc} ada", d.is_dir(), str(d))
            for stem in glues:
                vok = bool(d and (d / f"{stem}.pyv").is_file())
                ok(f"vault {svc}/{stem}.pyv ikut", vok)
                if vok and (d / f"{stem}.pyv").read_bytes()[:8] != b"VXVAULT1":
                    ok(f"vault {svc}/{stem}.pyv valid", False, "magic salah")
                if d and (d / f"{stem}.pyc").is_file():
                    ok(f"plaintext {svc}/{stem}.pyc terbuang", False, "masih ada")
            ok(f"loader {svc}/vx_vault.pyc ikut",
               bool(d and (d / "vx_vault.pyc").is_file()))
        ok("librespot ikut (backend Spotify)",
           (prem / "spotify" / "librespot").is_dir())
        ok("deemix+deezer ikut (backend Deezer)",
           (prem / "deezer" / "deemix").is_dir() and (prem / "deezer" / "deezer").is_dir())
        ok("manifest premium ikut", (prem / "manifest.json").is_file())
        # Vault harus opak: docstring glue tak boleh terbaca mentah.
        glue_doc = {
            "spotify/spotify_premium_auth.pyv":
                b"Otorisasi Spotify Premium sekali-pakai",
            "spotify/spotify_premium_download.pyv":
                b"librespot, venv terisolasi",
            "deezer/deezer_arl_test.pyv":
                b"Test login ARL Deezer",
            "deezer/deezer_download.pyv":
                b"kualitas TERBAIK yang diizinkan akun",
        }
        for rel, marker in glue_doc.items():
            gp = prem / Path(rel)
            if gp.is_file():
                ok(f"vault {rel} opak", marker not in gp.read_bytes())
        if eng is not None:
            for stem, proto in (("vx_download", b"_premium_backend"),
                                ("vx_search", b"_ytsearch_url")):
                eng_v = eng / f"{stem}.pyv"
                if eng_v.is_file() and proto in eng_v.read_bytes():
                    ok(f"vault engine {stem}.pyv opak", False,
                       "simbol protokol terbaca mentah")

    for z in tmp.rglob("*.zip"):
        with zipfile.ZipFile(z) as zf:
            leaked = [n for n in zf.namelist()
                      if n.lower().startswith("runtime/engine/") and n.lower().endswith(".py")]
        ok(f"runtime zip bebas .py engine ({z.name})", not leaked, f"{leaked}" if leaked else "")

    # Frontend Tauri v2 di-embed sebagai blob terkompresi, jadi identifier-nya
    # tidak bisa dicari di installer. Yang dicek adalah dist/ sebagai sumber
    # embed - di situ perilaku default harus benar.
    dist = ROOT / "dist"
    js_files = sorted(dist.rglob("*.js")) if dist.is_dir() else []
    ok("dist/ ada (sumber embed frontend)", bool(js_files), f"{len(js_files)} chunk")
    if js_files:
        blob = "".join(p.read_text(encoding="utf8", errors="replace") for p in js_files)
        # Terser menulis false -> `!1`, true -> `!0`.
        m = re.search(r"spotify:!1.{0,80}?deezer:!1.{0,80}?soundcloud:!0.{0,80}?archive:!0"
                      r".{0,80}?\"4shared\":!0", blob, re.S)
        ok("default strict: spotify+deezer false, sc/archive/4shared true", bool(m),
           "peta default tidak ditemukan di dist/" if not m else "")
        ok("penanda strictV 3 di dist", bool(re.search(r"strictV\s*=\s*3|strictV:3", blob)))
        # Flag lyric offset harus dibaca sebagai "1 = tampil". Kalau ini hilang,
        # panel akan kembali auto-show setiap kali ada lirik sinkron.
        ok("lyric offset: flag '1' berarti tampil",
           bool(re.search(r'"1"\s*===\s*localStorage\.getItem\([A-Za-z_$][\w$]*\)', blob)))
        assignments = re.findall(r"strictSources\s*=\s*\{[^}]*\}", blob)
        forced = [a for a in assignments if "spotify:!0" in a]
        ok("tidak ada pemaksaan spotify:true di migrasi", not forced,
           f"penugasan memaksa: {forced}" if forced else f"{len(assignments)} penugasan diperiksa")
    return 0


# ------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser(description="Audit proteksi binary VocaLyx")
    ap.add_argument("--exe", type=Path, help="binary rilis untuk diperiksa")
    ap.add_argument("--release-dir", type=Path, help="folder target/release")
    ap.add_argument("--installer", type=Path, help="installer (NSIS/MSI)")
    ap.add_argument("tmp", nargs="?", type=Path, help="folder ekstrak sementara (untuk --installer)")
    args = ap.parse_args()

    did = False
    rc = 0
    if args.exe:
        did = True
        rc |= audit_exe(args.exe)
    if args.release_dir:
        did = True
        rc |= audit_release_dir(args.release_dir)
    if args.installer:
        did = True
        # Ekstrak gagal (mis. msiexec non-nol) TIDAK boleh lolos sebagai OK:
        # audit_installer mengembalikan non-nol bila tak ada yang diperiksa.
        rc |= audit_installer(args.installer, args.tmp or (ROOT / ".audit-tmp"))
    if not did:
        ap.print_help()
        return 2

    print()
    if fails:
        print(f"{len(fails)} GAGAL:")
        for f in fails:
            print(f"  - {f}")
        return 1
    if rc:
        print(f"GAGAL: audit tak lengkap (rc={rc})")
        return 1
    print("SEMUA OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())