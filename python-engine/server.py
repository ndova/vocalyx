"""VocaLyx Python engine: FastAPI + BS-RoFormer/RoFormer (GPU) + m4a/mp3 handling."""
# Folder engine harus ada di sys.path SEBELUM `import vx_vault` di bawah.
#
# Interpreter normal menambahkan folder script ke sys.path secara otomatis,
# tapi runtime embeddable yang kita bundle punya `python*._pth` yang menimpa
# sys.path sepenuhnya: isinya saja yang dipakai, `PYTHONPATH` diabaikan, dan
# folder script tidak pernah ditambahkan. Akibatnya `import vx_vault` (dan
# semua `vx_*` lain) gagal dengan:
#
#     ModuleNotFoundError: No module named 'vx_vault'
#
# Engine lalu mati seketika, port 8001 tidak pernah listen, dan endpoint
# premium (Connect / Verify / Test) gagal fetch sehingga UI hanya
# menampilkan error generik. Bootstrap di bawah membuat lokasi engine tidak
# bergantung pada `._pth` maupun PYTHONPATH, jadi folder resource, repo dev,
# dan runtime/engine semuanya bisa dipakai apa adanya.
import os as _os
import sys as _sys

_vx_engine_dir = _os.path.dirname(_os.path.abspath(__file__))
if _vx_engine_dir and _vx_engine_dir not in _sys.path:
    _sys.path.insert(0, _vx_engine_dir)

import vx_vault as _vx_vault
_vx_vault.install()
del _vx_vault, _vx_engine_dir, _os, _sys
import hmac
import os
import torch
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from vx_auth import (ALLOW_HEADERS, ALLOW_METHODS, ALLOW_ORIGINS, OPEN_ENV,
                     OPEN_PATHS, TOKEN_HEADER, issue_engine_token)

from vx_core import device_pick, log, cleanup_orphan_tmp
from vx_cover import router as cover_router
from vx_download import router as download_router
from vx_misc import router as misc_router
from vx_preview import router as preview_router
from vx_search import router as search_router
from vx_separate import router as separate_router
from vx_iphone import router as iphone_router

cleanup_orphan_tmp()

try:
    ENGINE_TOKEN = issue_engine_token()
except Exception as e:
    log.warning("token engine tak bisa ditulis (%s)", e)
    ENGINE_TOKEN = ""


app = FastAPI(title="VocaLyx Engine")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_methods=ALLOW_METHODS,
    allow_headers=ALLOW_HEADERS,
    max_age=600,
)


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path in OPEN_PATHS:
        return await call_next(request)
    if os.environ.get(OPEN_ENV) == "1" or not ENGINE_TOKEN:
        return await call_next(request)
    provided = request.headers.get(TOKEN_HEADER, "")
    if provided and hmac.compare_digest(provided, ENGINE_TOKEN):
        return await call_next(request)
    return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
app.include_router(cover_router)
app.include_router(search_router)
app.include_router(preview_router)
app.include_router(download_router)
app.include_router(separate_router)
app.include_router(iphone_router)
app.include_router(misc_router)


@app.get("/health")
def health():
    cuda = torch.cuda.is_available()
    name = torch.cuda.get_device_name(0) if cuda else "cpu"
    bs_available = False
    try:
        import audio_separator
        bs_available = True
    except Exception:
        bs_available = False
    return {
        "ok": True,
        "cuda": cuda,
        "device": name,
        "bs_roformer": "Kim_Vocal_2 (+ensemble)" if bs_available else None,
        "bs_available": bs_available,
        "torch": torch.__version__,
        "cover_upload": True,
        # Penanda protokol: engine LAMA (sebelum resolver backend premium)
        # tidak punya field ini, jadi frontend/Rust bisa mendeteksi engine yatim
        # basi di 8001 dan mengambil alihnya. Jangan dibuat dinamis.
        "premium_backend": True,
    }


@app.get("/peaks")
def peaks_stub():
    return {"ok": True, "note": "peaks dihitung di frontend via AnalyserNode"}


if __name__ == "__main__":
    import uvicorn
    log.info("Device: %s %s", device_pick(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
    uvicorn.run(app, host="127.0.0.1", port=8001)
