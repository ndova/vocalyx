
"""Static check: nama yang dibaca tapi tidak pernah didefinisikan.

Melengkapi test runtime. Ini menangkap NameError yang tersembunyi di badan
fungsi sebelum ada yang memanggilnya -- termasuk di file yang tidak di-import
test mana pun.

Dulu ada build terpasang dengan ``KAROKE_DSP_VERSION`` (tanpa huruf A) di 5
tempat: ``/separate/caps`` balas 500 dan tiap karaoke job gagal di
``_persist_signature``. Grep string tidak menangkapnya, dan ``import`` tidak
menjalankan badan fungsi.

Yang diabaikan: nama bawaan interpreter (``__file__``, ``__name__``, dll).

Jalankan:  python tests/check_undefined_names.py
"""
import ast
import builtins
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


IMPLICIT = {
    "__file__", "__name__", "__doc__", "__package__", "__spec__",
    "__loader__", "__builtins__", "__debug__", "__path__", "__cached__",
    "__annotations__", "__class__",
}


SKIP_DIRS = {"__pycache__", ".venv", "venv", "node_modules"}


def analyse(path: Path):
    """Kembalikan daftar (lineno, nama) untuk satu file."""
    src = path.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(src, filename=str(path))
    except SyntaxError as e:
        return [("SYNTAX", e.lineno, f"{path.relative_to(ROOT)}: SyntaxError baris {e.lineno}: {e.msg}")]

    defined = set(IMPLICIT) | set(dir(builtins))
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                defined.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, ast.ImportFrom):
            for a in n.names:
                defined.add(a.asname or a.name)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(n.name)
            args = getattr(n, "args", None)
            if args is not None:
                for a in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
                    defined.add(a.arg)
                if args.vararg:
                    defined.add(args.vararg.arg)
                if args.kwarg:
                    defined.add(args.kwarg.arg)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            defined.add(n.id)
        elif isinstance(n, ast.Lambda):
            
            for a in list(n.args.posonlyargs) + list(n.args.args) + list(n.args.kwonlyargs):
                defined.add(a.arg)
            if n.args.vararg:
                defined.add(n.args.vararg.arg)
            if n.args.kwarg:
                defined.add(n.args.kwarg.arg)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            defined.add(n.name)
        elif isinstance(n, ast.Global):
            defined.update(n.names)
        elif isinstance(n, ast.MatchAs) and n.name:
            defined.add(n.name)

    bad = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
            if n.id not in defined:
                bad.append((path.relative_to(ROOT), n.lineno, n.id))
    return bad


def main():
    files = sorted(
        p for p in ROOT.rglob("*.py")
        if not (SKIP_DIRS & set(p.relative_to(ROOT).parts))
    )
    if not files:
        print("tidak ada file .py ditemukan", file=sys.stderr)
        return 1

    problems = []
    for p in files:
        problems.extend(analyse(p))

    print(f"static check: {len(files)} file .py diperiksa")
    for rel, line, name in problems:
        print(f"  {rel}:{line}: nama tak terdefinisi '{name}'")

    if problems:
        print(f"\n{len(problems)} masalah. Nama ini akan jadi NameError saat "
              f"fungsi dipanggil -- mungkin belum ketahuan karena tidak ada test "
              f"yang memanggilnya.")
        return 1
    print("semua nama terdefinisi")
    return 0


if __name__ == "__main__":
    sys.exit(main())