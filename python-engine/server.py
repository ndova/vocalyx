"""VocaLyx Python engine: FastAPI + BS-RoFormer/RoFormer (GPU) + m4a/mp3 handling."""
import torch
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from vx_core import device_pick, log, cleanup_orphan_tmp
from vx_cover import router as cover_router
from vx_download import router as download_router
from vx_misc import router as misc_router
from vx_preview import router as preview_router
from vx_search import router as search_router
from vx_separate import router as separate_router
from vx_iphone import router as iphone_router

cleanup_orphan_tmp()



app = FastAPI(title="VocaLyx Engine")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
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
