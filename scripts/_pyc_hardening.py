#!/usr/bin/env python3
"""Hardening bytecode .pyc VocaLyx (satu sumber kebenaran).

Masalah yang ditutup:
  1. `co_filename` absolut (`D:\\Folder Baru\\vocalyx\\build\\engine\\server.py`)
     ikut di setiap code object -> membocorkan struktur mesin builder.
  2. Docstring modul/fungsi/kelas ikut sebagai konstanta string pertama ->
     `strings file.pyc` langsung menampilkan protokol (ARL, Connect, dsb).

Yang TIDAK dilakukan di sini (sengaja):
  - Tidak pakai `optimize=1/2` (menghapus `assert`; `vx_sep_run.py:132` dan
    `vx_karaoke_sep.py:803` mengandalkannya sebagai invariant).
  - Tidak mengenkripsi/mengobfusikasi nama (runtime menjalankan `.pyc`
    langsung via `subprocess [sys.executable, script.pyc]` dan impor `vx_*`
    normal; enkripsi butuh custom importer = risiko rusak `deemix/librespot`).
  - Tidak menghapus string runtime yang memang dibutuhkan
    (`"ARL_KOSONG"`, `"dz_progress"`, ...) - itu akan merusak fungsi.

Cara pakai:
  from _pyc_hardening import compile_tree_hardened, check_tree_hardened
  n = compile_tree_hardened(STAGE_ENGINE)   # .py -> .pyc, lalu .py dibuang
"""
from __future__ import annotations

import ast
import importlib.util
import marshal
import sys
from pathlib import Path


def _strip_docstrings(tree: ast.Module) -> bool:
    """Buang docstring modul/kelas/fungsi/async. Return True bila berubah."""
    changed = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef,
                             ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", None)
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                if len(body) == 1:
                    # `class X: """doc"""` -> body kosong = ValueError
                    # saat compile; ganti dengan `pass`.
                    body[0] = ast.copy_location(ast.Pass(), body[0])
                else:
                    del body[0]
                changed = True
    return changed


def _sanitize_code(code, filename: str):
    """Ganti co_filename rekursif (termasuk nested code di co_consts)."""
    consts = tuple(
        _sanitize_code(c, filename) if isinstance(c, type(code)) else c
        for c in code.co_consts
    )
    if code.co_filename == filename and code.co_consts == consts:
        return code
    return code.replace(co_filename=filename, co_consts=consts)


def _read_source(src: Path) -> str | None:
    """Baca source seperti compileall (hormati coding cookie, bukan utf-8 mentah)."""
    import tokenize
    try:
        with tokenize.open(src) as f:
            return f.read()
    except Exception:
        return None


def compile_file_hardened(src: Path, dst: Path, arcname: str) -> bool:
    """Kompilasi satu .py -> .pyc hardened. Return True bila .pyc tertulis."""
    text = _read_source(src)
    if text is None:
        return False
    try:
        tree = ast.parse(text, filename=arcname)
    except SyntaxError:
        return False
    _strip_docstrings(tree)
    try:
        code = compile(tree, arcname, "exec", dont_inherit=True)
    except Exception:
        return False
    code = _sanitize_code(code, arcname)
    try:
        st = src.stat()
        data = importlib.util.MAGIC_NUMBER
        data += (0).to_bytes(4, "little")  # flags=0: timestamp-based, spt compileall
        data += int(st.st_mtime).to_bytes(4, "little")
        data += st.st_size.to_bytes(4, "little")
        data += marshal.dumps(code)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        return True
    except Exception:
        return False


def compile_tree_hardened(root: Path, keep_source: bool = False) -> tuple[int, list[str]]:
    """Kompilasi semua .py di bawah root -> .pyc di sampingnya (legacy -b).

    arcname = path relatif posix terhadap root (`server.py`,
    `scripts/karaoke_best.py`) supaya traceback tidak bocor path absolut.
    Bila keep_source=False, .py yang sukses dikompilasi dibuang.
    Return (jumlah .pyc tertulis, sisa .py yang gagal dikompilasi).
    """
    written = 0
    left: list[str] = []
    for src in sorted(root.rglob("*.py")):
        arcname = src.relative_to(root).as_posix()
        dst = src.with_suffix(".pyc")
        if compile_file_hardened(src, dst, arcname):
            written += 1
            if not keep_source:
                try:
                    src.unlink()
                except Exception:
                    pass
        else:
            left.append(arcname)
    for cache in sorted(root.rglob("__pycache__"), reverse=True):
        import shutil
        shutil.rmtree(cache, ignore_errors=True)
    return written, left


def check_tree_hardened(root: Path) -> list[str]:
    """Verifikasi .pyc di bawah root bebas path absolut + docstring modul.

    Return daftar temuan (kosong = OK).
    """
    issues: list[str] = []
    for pyc in sorted(root.rglob("*.pyc")):
        try:
            raw = pyc.read_bytes()
        except Exception:
            continue
        low = raw.decode("latin1").lower()
        # Path absolut mesin builder tidak boleh ada.
        for needle in ("d:\\folder baru", "d:/folder baru", "vocalyx\\build",
                       "vocalyx/build", "src-tauri\\src", "src-tauri/src"):
            if needle in low:
                issues.append(f"{pyc.name}: bocor path '{needle}'")
                break
        # Docstring modul = const string pertama code object top-level.
        try:
            code = marshal.loads(raw[16:])
            if code.co_consts and isinstance(code.co_consts[0], str):
                head = code.co_consts[0][:80]
                # Docstring khas VocaLyx panjang/deskriptif; string runtime
                # pendek seperti "ARL_KOSONG" tidak dihitung bocor.
                if len(code.co_consts[0]) > 40 or "\n" in head:
                    issues.append(
                        f"{pyc.name}: docstring modul masih ada "
                        f"({code.co_consts[0][:60]!r}...)")
        except Exception:
            pass
    return issues


if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    for issue in check_tree_hardened(root):
        print(f"LEAK: {issue}")
    sys.exit(1 if check_tree_hardened(root) else 0)
