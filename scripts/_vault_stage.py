
"""Sisi build untuk vault .pyv (dipakai build_runtime.py + stage_premium.py).

Loader (python-engine/vx_vault.py) adalah satu-satunya sumber kebenaran
format; modul ini hanya orkestrasi staging: tanam shareA acak per build ke
salinan loader, enkripsi .pyc hardened -> .pyv, lalu verifikasi roundtrip
dengan interpreter runtime yang sama persis.
"""
from __future__ import annotations

import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python-engine"))
import vx_vault  

PLACEHOLDER_LINE = 'VAULT_SHARE_A_HEX = "00" * 32'


def fresh_share() -> str:
    return secrets.token_hex(32)


def key_loader_text(text: str, share_hex: str) -> str:
    """Tanam shareA ke salinan source loader. Gagal keras bila tak terganti."""
    if len(share_hex) != 64:
        raise ValueError("shareA harus 64 hex")
    new_line = f'VAULT_SHARE_A_HEX = "{share_hex}"'
    if PLACEHOLDER_LINE not in text:
        raise ValueError("placeholder shareA tidak ditemukan (sudah dikunci?)")
    out = text.replace(PLACEHOLDER_LINE, new_line)
    if PLACEHOLDER_LINE in out or new_line not in out:
        raise ValueError("penanaman shareA gagal")
    return out


def vault_stems(root: Path, stems: list[str], share_hex: str) -> tuple[int, list[str]]:
    """Enkripsi <stem>.pyc -> <stem>.pyv lalu buang .pyc. Return (n, masalah)."""
    done = 0
    issues: list[str] = []
    for stem in stems:
        pyc = root / f"{stem}.pyc"
        if not pyc.is_file():
            issues.append(f"{stem}: {pyc.name} tidak ada (belum hardening?)")
            continue
        try:
            blob = vx_vault.encrypt_pyc(pyc.read_bytes(), f"{stem}.py", share_hex)
            (root / f"{stem}.pyv").write_bytes(blob)
            pyc.unlink()
            done += 1
        except Exception as e:
            issues.append(f"{stem}: {e}")
    return done, issues


def roundtrip_script(python: str, loader_pyc: Path, vault: Path,
                     args: list[str]) -> tuple[int, str, str]:
    """Jalankan vault via loader persis seperti runtime akan melakukannya."""
    proc = subprocess.run(
        [python, str(loader_pyc), str(vault), *args],
        capture_output=True, text=True, timeout=300,
        cwd=str(vault.parent),
    )
    return proc.returncode, proc.stdout, proc.stderr


def trial_import(python: str, engine_dir: Path, modules: list[str]) -> tuple[bool, str]:
    """Impor modul bervault via hook dalam proses interpreter runtime."""
    code = ("import sys; sys.path.insert(0, %r); import vx_vault;"
            " assert vx_vault.install(), 'hook tak aktif';"
            % str(engine_dir))
    for m in modules:
        code += f"import {m};"
    code += "print('vault-import-ok')"
    proc = subprocess.run([python, "-c", code],
                          capture_output=True, text=True, timeout=300)
    ok = proc.returncode == 0 and "vault-import-ok" in proc.stdout
    detail = (proc.stderr or proc.stdout).strip()[-600:]
    return ok, detail
