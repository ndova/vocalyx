"""Token auth engine: tanpa side effect saat impor (aman di-test cepat)."""
import os
import secrets
import stat
from pathlib import Path

TOKEN_HEADER = "X-VX-Token"
TOKEN_ENV = "VX_ENGINE_TOKEN"
OPEN_ENV = "VX_ENGINE_OPEN"
OPEN_PATHS = frozenset({"/health", "/peaks", "/iphone/track/cover"})  # cover = thumbnail GET read-only; tag <img> tak bisa kirim header token sehingga tanpa ini semua cover Device 401 selamanya (/iphone/library/* tetap wajib token)

ALLOW_ORIGINS = ["tauri://localhost", "http://tauri.localhost",
                 "https://tauri.localhost", "http://localhost:1420",
                 "http://127.0.0.1:1420"]
ALLOW_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
ALLOW_HEADERS = ["Content-Type", "Range", TOKEN_HEADER]


def token_file() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "VocaLyx" / "engine-token"
    return Path.home() / ".vocalyx" / "engine-token"


def issue_engine_token() -> str:
    """Token sesi engine, DIPAKAI ULANG antar restart.

    Dulu token baru dibuat tiap start (`secrets.token_hex(32)` selalu dipanggil).
    Itu berarti setiap restart engine - ganti device CPU/CUDA, restart manual
    dari UI, atau ambil-alih engine yatim - menimpa file token dengan nilai
    baru. Frontend meanwhile menyimpan token lama di cache, jadi setiap
    request sesudah restart membalas 401; retry-nya membaca file sebelum
    engine sempat menulis token baru, lalu 401 lagi. Frontend dan engine saling
    kejar-kejaran dengan token yang terus berganti dan tidak pernah menang.

    Sekarang token hanya dibuat kalau file belum ada (atau kosong/rusak).
    Akibatnya restart engine jadi transparen bagi frontend: cache token tidak
    pernah basi, dan restart tidak lagi memicu 401 massal. Kalau memang perlu
    mengrotasi token, hapus file `engine-token` (atau set `VX_ENGINE_TOKEN`,
    yang tetap menang atas file).
    """
    env = (os.environ.get(TOKEN_ENV) or "").strip()
    p = token_file()
    if env:
        tok = env
    else:
        tok = ""
        try:
            existing = p.read_text(encoding="ascii", errors="ignore").strip()
            if len(existing) >= 16:
                tok = existing
        except Exception:
            tok = ""
        if not tok:
            tok = secrets.token_hex(32)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(tok + "\n", encoding="ascii")
    try:
        os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass
    return tok