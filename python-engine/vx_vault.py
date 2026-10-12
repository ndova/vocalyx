#!/usr/bin/env python3
# VocaLyx vault loader - buka bytecode terenkripsi (.pyv) di memori.
#
# File ini SENGAJA tanpa docstring (komentar hilang saat kompilasi, docstring
# tidak) dan TIDAK PERNAH di-vault: ia yang membuka vault. Dikirim sebagai
# .pyc hardened biasa (lihat scripts/_pyc_hardening.py).
#
# Dua mode:
#   impor : `import vx_vault; vx_vault.install()` -> `import vx_download`
#           transparan bila vx_download.pyv ada di folder yang sama.
#           Tanpa .pyv (dev): no-op total.
#   skrip : `python vx_vault.pyc <modul.pyv> [args...]` atau dengan env
#           VX_VAULT_TARGET=<modul.pyv> (dipakai _premium_backend supaya
#           call-site subprocess tidak berubah).
#
# Format .pyv (v1):
#   magic 8B "VXVAULT1" | ver 1B (1) | salt 16B | shareB 32B |
#   arclen 2B BE | arcname (utf-8, mis. "vx_download.py") |
#   ctlen 4B BE | ct | tag HMAC-SHA256 32B atas semua header+ct.
# arcname disimpan di header supaya modul nested (scripts/karaoke_best.py)
# memakai KDF yang sama saat enkrip dan dekrip, apa pun nama filenya.
# Kunci master M = shareA XOR shareB. shareA ditanam ke file INI saat staging
# (placeholder di bawah diganti secret acak per build -> setiap installer unik,
# kebocoran bisa dilacak ke build). shareB acak per file.
# Kunci per modul: SHA256(domain || M || arcname); keystream CTR dari
# SHA256(enckey || salt || counter_BE8). Stdlib only (hashlib/hmac).
#
# JUJUR: ini obfuscation-grade, bukan enkripsi anti-forensik - kunci A ada di
# mesin user (di .pyc loader hardened). Yang ditutup: `strings`/pycdc sekali
# klik atas logika protokol. Format berversi supaya shareA nanti bisa pindah
# ke pemegang kunci native (.pyd) tanpa mengubah format file.
import hashlib
import hmac
import importlib.abc
import marshal
import os
import sys

VERSION = 1
MAGIC = b"VXVAULT1"
# Diganti secret acak per build saat staging (64 hex). Nol = belum dikunci.
VAULT_SHARE_A_HEX = "00" * 32
ENV_TARGET = "VX_VAULT_TARGET"


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def _kdf(domain: bytes, master: bytes, arcname: str) -> bytes:
    return hashlib.sha256(domain + master + arcname.encode("utf-8")).digest()


def _keystream(enckey: bytes, salt: bytes, n: int) -> bytes:
    out = bytearray()
    ctr = 0
    while len(out) < n:
        out += hashlib.sha256(enckey + salt + ctr.to_bytes(8, "big")).digest()
        ctr += 1
    return bytes(out[:n])


def _master(arcname: str, share_a: bytes, share_b: bytes) -> tuple[bytes, bytes]:
    m = _xor(share_a, share_b)
    return (_kdf(b"VXVAULT1-enc", m, arcname),
            _kdf(b"VXVAULT1-mac", m, arcname))


def encrypt_pyc(pyc: bytes, arcname: str, share_a_hex: str) -> bytes:
    share_a = bytes.fromhex(share_a_hex)
    if len(share_a) != 32 or not any(share_a):
        raise ValueError("shareA kosong (belum dikunci saat staging?)")
    arc = arcname.encode("utf-8")
    if not arc or len(arc) > 512:
        raise ValueError("arcname tak valid")
    salt = os.urandom(16)
    share_b = os.urandom(32)
    enckey, mackey = _master(arcname, share_a, share_b)
    ct = _xor(pyc, _keystream(enckey, salt, len(pyc)))
    head = (MAGIC + bytes((VERSION,)) + salt + share_b
            + len(arc).to_bytes(2, "big") + arc
            + len(ct).to_bytes(4, "big"))
    tag = hmac.new(mackey, head + ct, hashlib.sha256).digest()
    return head + ct + tag


def decrypt_vault(blob: bytes, share_a_hex: str) -> bytes:
    share_a = bytes.fromhex(share_a_hex)
    if len(share_a) != 32 or not any(share_a):
        raise ValueError("loader belum dikunci (shareA nol)")
    if len(blob) < 8 + 1 + 16 + 32 + 2 + 4 + 32 or blob[:8] != MAGIC:
        raise ValueError("bukan vault VocaLyx")
    if blob[8] != VERSION:
        raise ValueError("versi vault %d tak didukung (loader v%d)" % (blob[8], VERSION))
    salt = blob[9:25]
    share_b = blob[25:57]
    (arclen,) = (int.from_bytes(blob[57:59], "big"),)
    if arclen < 1 or arclen > 512 or len(blob) < 59 + arclen + 4 + 32:
        raise ValueError("vault terpotong")
    arcname = blob[59:59 + arclen].decode("utf-8")
    off = 59 + arclen
    (ctlen,) = (int.from_bytes(blob[off:off + 4], "big"),)
    ct = blob[off + 4:off + 4 + ctlen]
    tag = blob[off + 4 + ctlen:off + 4 + ctlen + 32]
    if len(ct) != ctlen or len(tag) != 32:
        raise ValueError("vault terpotong")
    enckey, mackey = _master(arcname, share_a, share_b)
    want = hmac.new(mackey, blob[:off + 4 + ctlen], hashlib.sha256).digest()
    if not hmac.compare_digest(want, tag):
        raise ValueError("tag vault tidak cocok (kunci salah / file rusak)")
    return _xor(ct, _keystream(enckey, salt, ctlen))


def _share_a() -> str:
    return VAULT_SHARE_A_HEX


class _VaultFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, vault_dir: str):
        self.dir = vault_dir
        self.stems: dict[str, str] = {}
        try:
            for p in os.listdir(vault_dir):
                if p.endswith(".pyv") and "/" not in p and "\\" not in p:
                    self.stems[p[:-4]] = os.path.join(vault_dir, p)
        except OSError:
            pass

    def find_spec(self, fullname, path=None, target=None):
        p = self.stems.get(fullname)
        if p is None or "." in fullname:
            return None
        import importlib.machinery
        return importlib.machinery.ModuleSpec(fullname, self, origin=p)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        p = self.stems[module.__name__]
        with open(p, "rb") as f:
            blob = f.read()
        pyc = decrypt_vault(blob, _share_a())
        code = marshal.loads(pyc[16:])
        module.__file__ = p
        exec(code, module.__dict__)


_installed: set[str] = set()


def install(vault_dir: str | None = None) -> bool:
    # Pasang hook impor untuk *.pyv di folder loader (default). No-op bila
    # tidak ada .pyv (mode dev) atau folder sudah terpasang. Return True bila
    # hook aktif dengan sedikitnya satu vault.
    if vault_dir is None:
        vault_dir = os.path.dirname(os.path.abspath(__file__))
    vault_dir = os.path.abspath(vault_dir)
    if vault_dir in _installed:
        return any(isinstance(f, _VaultFinder) and f.dir == vault_dir and f.stems
                   for f in sys.meta_path)
    finder = _VaultFinder(vault_dir)
    sys.meta_path.insert(0, finder)
    _installed.add(vault_dir)
    return bool(finder.stems)


def run_vault(vault_path: str, args: list[str]) -> int:
    # Jalankan satu .pyv sebagai __main__ (mode skrip glue premium / karaoke).
    vault_path = os.path.abspath(vault_path)
    with open(vault_path, "rb") as f:
        blob = f.read()
    try:
        pyc = decrypt_vault(blob, _share_a())
        code = marshal.loads(pyc[16:])
    except Exception as e:
        try:
            sys.stdout.write('{"ok": false, "error": "VAULT_GAGAL: %s"}\n'
                             % (str(e)[:120],))
            sys.stdout.flush()
        except Exception:
            pass
        return 2
    sys.argv = [vault_path[:-4] + ".py"] + args
    # Skrip vault umumnya diletakkan di `<engine>/scripts/` (karaoke_best.pyv),
    # sedangkan modul yang diimpornya (`win_nowindow`, `vx_karaoke_sep`, ...)
    # berada di `<engine>/`. Jadi DUA folder harus masuk sys.path: folder
    # skrip DAN folder induknya.
    base = os.path.dirname(vault_path)
    engine_dir = os.path.dirname(base)
    for d in (base, engine_dir):
        if d and os.path.isdir(d) and d not in sys.path:
            sys.path.insert(0, d)
    # WAJIB: hook impor .pyv harus aktif sebelum skrip diexec, kalau tidak
    # modul ter-vault tidak bisa diimpor sama sekali dan skrip mati dengan
    #     ModuleNotFoundError: No module named 'win_nowindow'
    # (bukan karena paketnya hilang, tapi karena tidak ada yang mengaktifkannya).
    install(engine_dir)
    if base != engine_dir:
        install(base)
    g = {"__name__": "__main__", "__file__": vault_path,
         "__loader__": None, "__package__": None, "__spec__": None}
    exec(code, g)
    return 0


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1].endswith(".pyv"):
        return run_vault(argv[1], argv[2:])
    target = os.environ.get(ENV_TARGET, "")
    if target.endswith(".pyv") and os.path.isfile(target):
        return run_vault(target, argv[1:])
    sys.stderr.write("vx_vault: butuh <modul.pyv> atau env %s\n" % ENV_TARGET)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
