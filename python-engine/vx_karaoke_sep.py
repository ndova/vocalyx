"""VocaLyx engine - pemanggilan audio-separator untuk karaoke.

Stem "Instrumental" dari audio-separator sengaja TIDAK dipakai. Library itu
membentuk stem sekunder sebagai residual::

    primary   = demix(normalize(mix, thr)) * peak
    secondary = normalize(mix, thr) - compensate * primary

dengan default ``thr = 0.9`` dan compensate ~1.01, hanya ~0.91 vokal yang
dikurangi; kalau peak file di bawah 0.9 malah hanya ``compensate * peak``.
Sisa vokal jadi bergantung ke loudness file (antara -6 dB sampai -45 dB) —
itulah sebabnya karaoke lama masih kedengaran vokal, dan kenapa vocalnya
muncul-timbul di bagian yang volume vokalnya berubah-ubah.

Di sini kita set ``normalization_threshold = 1.0`` (jadi normalize() no-op dan
stem yang ditulis persis ``peak * estimasi``), baca HANYA stem primer, lalu
instrumental dibangun sendiri lewat ``vx_karaoke_dsp.build_instrumental``.
"""
from __future__ import annotations

import gc
import logging
import os
import shutil
import sys
import threading
import time
from pathlib import Path

import numpy as np

import vx_karaoke_dsp as dsp

_MODELS_OVERRIDE = (os.environ.get("VOCALYX_MODELS_DIR") or "").strip()
MODEL_DIR = Path(_MODELS_OVERRIDE) if _MODELS_OVERRIDE else (
    Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))) / "audio-separator-models"
)
PUBLIC_REPO = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models"
# Checkpoint RoFormer (.ckpt) tidak ada di PUBLIC_REPO (404); semuanya berikut
# config yaml-nya ada di repo audio-separator sendiri. Daftar ini terverifikasi
# ada (98 ckpt + semua yaml, dicek via API GitHub).
ROFORMER_REPO = "https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs"
# Pasangan ckpt -> yaml (dari models.json audio-separator 0.47.0).
ROFORMER_CONFIGS = {
    "bs_roformer_instrumental_resurrection_unwa.ckpt":
        "config_bs_roformer_instrumental_resurrection_unwa.yaml",
    "bs_roformer_karaoke_anvuew.ckpt":
        "config_bs_roformer_karaoke_anvuew.yaml",
    "mel_band_roformer_instrumental_fv7z_gabox.ckpt":
        "config_mel_band_roformer_instrumental_gabox.yaml",
    "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt":
        "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956_config.yaml",
    "mel_band_roformer_karaoke_gabox_v2.ckpt":
        "config_mel_band_roformer_karaoke_gabox.yaml",
    # Tahap-2 dereverb (v14): rantai preferensi, yang less-aggressive dulu
    # supaya room musik tidak ikut dikeringkan. Keduanya ada di
    # ROFORMER_REPO (release "model-configs" nomadkaraoke) dan terdaftar di
    # models.json audio-separator, jadi Separator bisa memuatnya.
    "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt":
        "dereverb_mel_band_roformer_anvuew.yaml",
    "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt":
        "dereverb_mel_band_roformer_anvuew.yaml",
}

# Rantai model dereverb tahap-2 untuk preset karaoke_aufr33 (CUDA saja).
# Less-aggressive pertama; kalau gagal/unduhan gagal, coba standar; kalau
# keduanya gagal, instrumental mentah dipakai (fallback, bukan failed).
DEREVERB_CHAIN = (
    "dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt",
    "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
)

MIN_MODEL_BYTES = 8 * 1024 * 1024

# Inferensi native float16. audio-separator 0.47.0 memverifikasi jalur ini untuk
# (cuda, bs_roformer) dan (cuda, mel_band_roformer) di
# separator/execution_policy.py::NATIVE_FP16_CAPABILITIES; model di luar daftar
# itu otomatis jalan fp32 (tidak ada error).
#
# Terukur di RTX 3050 Laptop (4 GB), model karaoke anvuew, 60 detik audio:
#   fp32 62,3 s  VRAM peak 1,52 GB
#   fp16 26,4 s  VRAM peak 1,02 GB   -> 2,4x lebih cepat, VRAM -33%
# Kualitas: SNR fp16 vs fp32 = +63 dB dan sisa vokal identik (-20,5 dB),
# jadi ini penghematan waktu dengan kerugian numerik yang tidak kedengaran.
NATIVE_FP16 = True


def eprint(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def emit_progress(pct: float, stage: str) -> None:
    dsp.emit_progress(pct, stage)


def free_vram(tag: str) -> None:
    try:
        gc.collect()
    except Exception:
        pass
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            eprint(f"[KaraokeSep] VRAM dibersihkan ({tag})")
    except Exception:
        pass


class Heartbeat(threading.Thread):
    """Emit progres pelan selama inferensi memblokir (sep.separate tanpa callback)."""

    def __init__(self, stage: str, lo: float = 10.0, hi: float = 68.0, step: float = 4.0,
                 every: float = 15.0):
        super().__init__(daemon=True)
        self.stage = stage
        self.lo = lo
        self.hi = hi
        self.step = step
        self.every = every
        self.pct = lo
        self.stop_ev = threading.Event()

    def run(self):
        while not self.stop_ev.wait(self.every):
            self.pct = min(self.hi, self.pct + self.step)
            emit_progress(self.pct, self.stage)

    def stop(self):
        self.stop_ev.set()


# --------------------------------------------------------------------------
# model files
# --------------------------------------------------------------------------

def model_path(model_file: str) -> Path:
    return MODEL_DIR / model_file


def have_model(model_file: str) -> bool:
    p = model_path(model_file)
    try:
        return p.is_file() and p.stat().st_size >= MIN_MODEL_BYTES
    except Exception:
        return False


def _download_one(url: str, dest: Path) -> bool:
    """Unduh satu file atomik (.part lalu rename). Kembalikan True bila OK.

    Ada progres MB + resume: kalau .part dari run sebelumnya masih ada,
    dilanjutkan via header Range (bukan dari nol). File .part yang gagal
    SENGAJA tidak dihapus supaya bisa dilanjutkan run berikutnya; file
    setengah jadi tidak pernah dipakai karena ``have_model`` menolaknya.
    """
    import urllib.request

    tmp = dest.with_suffix(dest.suffix + ".part")
    resume_from = 0
    try:
        if tmp.is_file():
            resume_from = tmp.stat().st_size
    except Exception:
        resume_from = 0
    headers = {"User-Agent": "VocaLyx/0.1"}
    if resume_from > 0:
        headers["Range"] = f"bytes={resume_from}-"
        eprint(f"[KaraokeSep] unduh {dest.name} ... (lanjut dari {resume_from/1e6:.1f} MB)")
    else:
        eprint(f"[KaraokeSep] unduh {dest.name} ...")
    try:
        started = time.time()
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = getattr(resp, "status", 200)
            if resume_from > 0 and status != 206:
                eprint(f"[KaraokeSep] server tidak dukung resume (HTTP {status}); mulai dari nol")
                resume_from = 0
                mode = "wb"
            else:
                mode = "ab" if resume_from > 0 else "wb"
            total = None
            try:
                if status == 206:
                    cr = resp.headers.get("Content-Range", "")
                    if "/" in cr:
                        total = int(cr.rsplit("/", 1)[-1])
                else:
                    total = int(resp.headers.get("Content-Length", "0") or 0) or None
            except Exception:
                total = None
            got = resume_from
            last_log = got
            chunk = 1 << 20
            with open(tmp, mode) as fh:
                while True:
                    buf = resp.read(chunk)
                    if not buf:
                        break
                    fh.write(buf)
                    got += len(buf)
                    if got - last_log >= 25 * (1 << 20):
                        last_log = got
                        el = time.time() - started
                        rate = (got - resume_from) / max(el, 1e-3) / 1e6
                        if total:
                            eprint(f"[KaraokeSep] {dest.name}: {got/1e6:.0f}/{total/1e6:.0f} MB "
                                   f"({100.0*got/max(total,1):.0f}%, {rate:.2f} MB/s)")
                        else:
                            eprint(f"[KaraokeSep] {dest.name}: {got/1e6:.0f} MB ({rate:.2f} MB/s)")
        size = tmp.stat().st_size
        if size < MIN_MODEL_BYTES and dest.suffix.lower() != ".yaml":
            eprint(f"[KaraokeSep] unduhan {dest.name} terpotong ({size} byte) — .part disimpan, bisa dilanjutkan")
            return False
        if size <= 0:
            eprint(f"[KaraokeSep] unduhan {dest.name} kosong")
            return False
        tmp.replace(dest)
        eprint(f"[KaraokeSep] {dest.name} siap ({size/1e6:.1f} MB, {time.time()-started:.0f}s)")
        return True
    except Exception as ex:
        kept = 0
        try:
            kept = tmp.stat().st_size if tmp.is_file() else 0
        except Exception:
            pass
        eprint(f"[KaraokeSep] gagal unduh {dest.name}: {ex} "
               f"(tersimpan {kept/1e6:.1f} MB, bisa dilanjutkan run berikutnya)")
        return False


def ensure_model(model_file: str, allow_download: bool = True) -> bool:
    """Pastikan file model ada; unduh sekali bila perlu.

    Model ONNX dari repo publik UVR (satu file). Model RoFormer (.ckpt)
    butuh pasangan config .yaml dari repo audio-separator — keduanya
    diunduh bila belum ada.
    """
    dest = model_path(model_file)
    if have_model(model_file):
        # Untuk ckpt, pastikan yaml pasangannya juga ada.
        cfg = ROFORMER_CONFIGS.get(model_file)
        if cfg and not model_path(cfg).is_file():
            if not allow_download:
                return False
            try:
                MODEL_DIR.mkdir(parents=True, exist_ok=True)
            except Exception as ex:
                eprint(f"[KaraokeSep] gagal buat {MODEL_DIR}: {ex}")
                return False
            return _download_one(f"{ROFORMER_REPO}/{cfg}", model_path(cfg))
        return True
    if not allow_download:
        return False
    try:
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as ex:
        eprint(f"[KaraokeSep] gagal buat {MODEL_DIR}: {ex}")
        return False
    if model_file.lower().endswith(".ckpt"):
        cfg = ROFORMER_CONFIGS.get(model_file)
        if not cfg:
            eprint(f"[KaraokeSep] {model_file}: config yaml tidak dikenal, lewati")
            return False
        ok_ckpt = _download_one(f"{ROFORMER_REPO}/{model_file}", dest)
        ok_yaml = _download_one(f"{ROFORMER_REPO}/{cfg}", model_path(cfg))
        return ok_ckpt and ok_yaml
    return _download_one(f"{PUBLIC_REPO}/{model_file}", dest)


def available_models(weights) -> list[tuple[str, float]]:
    return [(name, w) for name, w in weights if have_model(name)]


def missing_models(weights) -> list[str]:
    return [name for name, _ in weights if not have_model(name)]


def combine_instrumentals(mix: np.ndarray,
                          parts: list[tuple[np.ndarray, float]],
                          algorithm: str = "avg") -> np.ndarray:
    """Gabungkan beberapa stem instrumental menjadi satu.

    ``avg``: rata-rata tertimbang (weighted_sum) — cepat, deterministik.
    Algoritma lain (``uvr_max_spec``, ``avg_fft``, ...): via Ensembler bawaan
    audio-separator di CPU (tanpa VRAM). ``uvr_max_spec`` mengambil spektrum
    terbesar per bin — itulah yang membuat preset instrumental_clean minim
    bleed vokal, dan tidak bisa ditiru oleh rata-rata linier.

    Separasi tetap sequential (satu model satu waktu, VRAM aman); yang
    digabung di sini hanyalah stem WAV/numpy yang sudah tersimpan.
    """
    if not parts:
        raise RuntimeError("tidak ada stem instrumental untuk digabung")
    if len(parts) == 1:
        return dsp.to_stereo(dsp.fit_length(parts[0][0], mix.shape[-1])).astype(np.float32)
    algo = (algorithm or "avg").lower()
    if algo in ("avg", "avg_wave"):
        total = sum(w for _, w in parts)
        if total <= 0:
            total = float(len(parts))
            parts = [(a, 1.0) for a, _ in parts]
        return dsp.weighted_sum(mix, parts, total)
    # Ensembler library: CPU-only, tanpa VRAM.
    from audio_separator.separator.ensembler import Ensembler

    log = logging.getLogger("KaraokeSep")
    waves = []
    n = mix.shape[-1]
    for arr, _ in parts:
        a = dsp.to_stereo(dsp.fit_length(arr, n)).astype(np.float64)
        waves.append(a)
    ens = Ensembler(logger=log, algorithm=algo, weights=None)
    out = ens.ensemble(waves)
    if out is None:
        raise RuntimeError(f"Ensembler {algo} mengembalikan None")
    return dsp.to_stereo(dsp.fit_length(out, n)).astype(np.float32)


# --------------------------------------------------------------------------
# separator
# --------------------------------------------------------------------------

# Overlap inferensi MDXC/RoFormer (v15): yaml aufr33 memakai num_overlap=4;
# menaikkan ke 8 adalah praktik standar komunitas (UVR/MVSEP) untuk estimasi
# mask lebih halus di batas chunk -> transient/treble lebih utuh ("mendem"
# berkurang di sumbernya, bukan via EQ). Hanya berlaku untuk arch MDXC
# (termasuk MelBand RoFormer); model ONNX/MDX/VR mengabaikan mdxc_params.
# VOCALYX_OVERLAP memaksa nilai lain (mis. "4" untuk A/B vs perilaku lama).
SEP_OVERLAP = 8


def _cuda_total_gb() -> float | None:
    """Total VRAM GPU pertama (GB) atau None bila tak terdeteksi."""
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free_b, total_b = torch.cuda.mem_get_info()
        return float(total_b) / 1e9
    except Exception:
        return None


def _wanted_overlap() -> int | None:
    """Overlap inferensi: env menang; lalu otomatis berdasar total VRAM.

    Nasihat otomatis tier VRAM (sinkron dengan precheck Rust): < 6 GB -> 4
    (hemat memori di GPU 4 GB seperti RTX 3050), >= 6 GB -> 8. VOCALYX_OVERLAP
    memaksa nilai lain (mis. "4"/"8" untuk A/B).
    """
    import os as _os

    raw = (_os.environ.get("VOCALYX_OVERLAP") or "").strip()
    if raw:
        try:
            v = int(raw)
            return v if v > 0 else None
        except Exception:
            pass
    total = _cuda_total_gb()
    if total is not None and total < 6.0:
        eprint(f"[KaraokeSep] VRAM total {total:.1f} GB -> overlap otomatis 4 (hemat memori)")
        return 4
    return SEP_OVERLAP


def _new_separator(out_dir: Path, overlap: int | None = None):
    from audio_separator.separator import Separator

    return Separator(
        output_dir=str(out_dir),
        output_format="WAV",
        model_file_dir=str(MODEL_DIR),
        normalization_threshold=1.0,
        amplification_threshold=0.0,
        use_native_fp16=NATIVE_FP16,
        mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                     "batch_size": None, "overlap": overlap, "pitch_shift": 0},
    )


def _primary_name(sep) -> str:
    inst = getattr(sep, "model_instance", None)
    name = str(getattr(inst, "primary_stem_name", "") or "")
    if not name:
        try:
            data = getattr(inst, "model_data", None) or {}
            name = str(data.get("primary_stem", "") or "")
        except Exception:
            name = ""
    return name


def _pick_primary(outputs, out_dir: Path, primary: str) -> Path | None:
    """Stem PRIMER model (bukan hasil pengurangan), dengan fallback nama file."""
    primary_l = primary.strip().lower()
    cands: list[Path] = []
    for p in outputs or []:
        q = Path(p)
        cands.append(q if q.is_absolute() else out_dir / q.name)
    for want in (primary_l, "vocal", "instrumental"):
        if not want:
            continue
        for p in cands:
            if want in p.stem.lower() and p.is_file():
                return p
    cands += sorted(out_dir.glob("*.wav"))
    for want in (primary_l, "vocal", "instrumental"):
        if not want:
            continue
        for p in cands:
            if want in p.stem.lower() and p.is_file():
                return p
    for p in cands:
        if p.is_file():
            return p
    return None


def _pick_secondary(outputs, out_dir: Path, primary_path: Path | None) -> Path | None:
    """Stem SEKUNDER model (bukan primer) — untuk mask residual vokal.

    Berbasis "bukan primer", bukan hardcode nama: untuk Resurrection
    (primer ``other``) yang dikembalikan stem ``vocals``; untuk model
    vocal-primary yang dikembalikan pasangannya. Kalau tidak ada, None
    (mask center tetap kosong seperti sebelumnya).
    """
    prim = Path(primary_path).resolve() if primary_path else None
    cands: list[Path] = []
    for p in outputs or []:
        q = Path(p)
        q = q if q.is_absolute() else out_dir / q.name
        cands.append(q)
    cands += sorted(out_dir.glob("*.wav"))
    seen: set[str] = set()
    for p in cands:
        try:
            key = str(p.resolve())
        except Exception:
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        if prim is not None and key == str(prim):
            continue
        if p.is_file():
            return p
    return None


def separate_one(model_file: str, inp: Path, work_dir: Path, device: str
                 ) -> tuple[Path, str, Path | None]:
    """Jalankan satu model; kembalikan (stem primer, primary_stem, stem sekunder|None).

    Stem sekunder (pasangan primer) dipakai sebagai mask residual vokal di
    center-suppress. Tanpa ini, model instrumental-primary memberi mask nol
    dan tahap DSP tidak melakukan apa-apa.
    """
    out_dir = work_dir / model_path(model_file).stem
    out_dir.mkdir(parents=True, exist_ok=True)
    want_ov = _wanted_overlap()
    # Hanya model .ckpt (keluarga MDXC/RoFormer) yang memakai overlap; untuk
    # ONNX/VR, fallback tidak ada gunanya dan hanya menggandakan waktu.
    can_retry_ov = model_file.lower().endswith(".ckpt") and want_ov is not None
    attempts = [want_ov] + ([None] if can_retry_ov else [])
    last_ex: Exception | None = None
    for ov in attempts:
        sep = None
        try:
            sep = _new_separator(out_dir, overlap=ov)
            sep.load_model(model_filename=model_file)
            primary = _primary_name(sep)
            eprint(f"[KaraokeSep] {model_file} primary={primary or '?'} device={device} "
                   f"overlap={ov if ov is not None else 'yaml-default'}")
            hb = Heartbeat(f"separate:{model_path(model_file).stem}")
            hb.start()
            try:
                outputs = sep.separate(str(inp))
            finally:
                hb.stop()
            found = _pick_primary(outputs, out_dir, primary)
            if not found or not found.is_file():
                raise RuntimeError(f"{model_file}: tidak menghasilkan stem primer ({primary or '?'})")
            second = _pick_secondary(outputs, out_dir, found)
            if second is not None:
                eprint(f"[KaraokeSep] {model_file} secondary={second.name}")
            return found, primary, second
        except Exception as ex:
            last_ex = ex
            if ov is not None and can_retry_ov:
                eprint(f"[KaraokeSep] {model_file} overlap={ov} gagal ({ex}); coba overlap bawaan yaml")
                try:
                    for stale in out_dir.glob("*.wav"):
                        stale.unlink(missing_ok=True)
                except Exception:
                    pass
                continue
            raise
        finally:
            if sep is not None:
                try:
                    del sep
                except Exception:
                    pass
            free_vram(model_file)
    assert last_ex is not None
    raise last_ex


def _dereverb_enabled() -> bool:
    """Tahap-2 dereverb hanya bila eksplisit opt-in (default MATI sejak v15).

    Terbukti pada lagu padat malah menumpulkan mid/high (air -9 dB di
    "The Call"); masalah mendem bukan reverb. Aktifkan manual bila perlu:
    VOCALYX_DEREVERB=1 (VOCALYX_NO_DEREVERB=1 lama tetap dihormati sebagai off).
    """
    import os as _os

    env = (_os.environ.get("VOCALYX_DEREVERB") or "").strip().lower()
    no = (_os.environ.get("VOCALYX_NO_DEREVERB") or "").strip().lower()
    if no in ("1", "true", "on", "yes"):
        return False
    return env in ("1", "true", "on", "yes")


def dereverb_instrumental(inst: np.ndarray, work_dir: Path, device: str,
                          allow_download: bool = True) -> np.ndarray | None:
    """Bersihkan sisa reverb hantu vokal dari instrumental mentah (v14).

    Menjalankan SATU model dereverb MelBand (rantai ``DEREVERB_CHAIN``) dengan
    input instrumental mentah, mengambil stem primernya (kering), me-level-match
    lalu blend 65/35 dengan mentah via ``dsp.blend_with_clean``. Hanya untuk
    CUDA; di CPU dilewati (terlalu lambat). Kegagalan apa pun -> None supaya
    pemanggil memakai instrumental mentah (fallback, bukan failed).

    Ini BUKAN masking: tidak ada pengurangan spektral adaptif ganda, hanya
    estimasi neural + blend linier sekali.
    """
    if not _dereverb_enabled():
        eprint("[KaraokeSep] dereverb mati (default v15; opt-in via VOCALYX_DEREVERB=1)")
        return None
    if (device or "").lower() == "cpu":
        eprint("[KaraokeSep] dereverb dilewati di CPU (berat, preset CPU tetap cepat)")
        return None
    raw = dsp.to_stereo(inst).astype(np.float32)
    if raw.size == 0:
        return None
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    in_wav = work_dir / "_dereverb_in.wav"
    try:
        dsp.write_wav(in_wav, raw)
    except Exception as ex:
        eprint(f"[KaraokeSep] dereverb: tulis input gagal: {ex}")
        return None
    try:
        for model in DEREVERB_CHAIN:
            if not ensure_model(model, allow_download=allow_download):
                eprint(f"[KaraokeSep] dereverb: model tidak tersedia: {model}")
                continue
            try:
                emit_progress(70.0, f"dereverb:{model_path(model).stem}")
                found, primary, _second = separate_one(
                    model, in_wav, work_dir / "_dereverb", device)
                dry = dsp.to_stereo(dsp.fit_length(dsp.load_audio(found), raw.shape[-1]))
                blended = dsp.blend_with_clean(raw, dry, dsp.DEREVERB_BLEND)
                try:
                    a = blended.ravel()[::97].astype(np.float64)
                    b = raw.ravel()[::97].astype(np.float64)
                    corr = float(np.corrcoef(a, b)[0, 1])
                except Exception:
                    corr = 1.0
                if corr < 0.90:
                    eprint(f"[KaraokeSep] dereverb {model}: corr {corr:.3f} < 0.90, "
                           f"dianggap merusak musik -> mentah dipakai")
                    continue
                eprint(f"[KaraokeSep] dereverb {model} ok (primary={primary or '?'}, corr={corr:.4f})")
                emit_progress(72.0, "dereverb:done")
                return blended.astype(np.float32)
            except Exception as ex:
                eprint(f"[KaraokeSep] dereverb {model} gagal: {ex}")
                continue
    finally:
        try:
            in_wav.unlink(missing_ok=True)
        except Exception:
            pass
    eprint("[KaraokeSep] dereverb: semua model gagal -> instrumental mentah dipakai")
    return None


def build_instrumental_from_models(weights, inp: Path, out_dir: Path, device: str,
                                   vocal_kill: float = 1.0,
                                   allow_download: bool = True,
                                   progress: tuple[float, float] = (6.0, 72.0),
                                   algorithm: str = "avg",
                                   dereverb: bool = True) -> dict:
    """Pisahkan dengan beberapa model, lalu rakit instrumental pada skala mix asli.

    ``weights``: list ``(model_file, bobot)``. Model yang bobotnya nol dilewati.
    Semua model dikonversi ke instrumental dulu sebelum dijumlahkan, jadi tidak
    ada lagi ``amix`` ffmpeg yang menjumlahkan stem dengan level beda-beda.
    """
    todo = []
    for name, w in weights:
        if w <= 0:
            continue
        if not ensure_model(name, allow_download=allow_download):
            eprint(f"[KaraokeSep] model tidak tersedia: {name}")
            continue
        todo.append((name, float(w)))
    if not todo:
        raise RuntimeError("tidak ada model yang bisa dipakai")

    if (device or "").lower() in ("cpu",):
        # Separator tidak menerima parameter device; ia memilih CUDA begitu
        # torch.cuda.is_available() -> True. Untuk memaksa CPU, nonaktifkan
        # deteksi CUDA SEBELUM Separator dibuat.
        try:
            import torch

            torch.cuda.is_available = lambda: False
            torch.cuda.device_count = lambda: 0
            eprint("[KaraokeSep] mode CPU dipaksakan (CUDA dinonaktifkan)")
        except Exception:
            pass

    missing = [n for n, _ in weights if n not in {t[0] for t in todo}]
    if missing:
        eprint(f"[KaraokeSep] model dilewati: {', '.join(missing)}")

    total_w = sum(w for _, w in todo)
    work_dir = out_dir / "_sep"
    work_dir.mkdir(parents=True, exist_ok=True)

    emit_progress(progress[0], "dsp:decode")
    mix = dsp.load_audio(inp)
    peak = dsp.true_peak(mix)
    if peak <= 1e-6:
        peak = 1.0

    lo, hi = progress
    inst_parts: list[tuple[np.ndarray, float]] = []
    used: list[str] = []
    done = 0.0
    for name, w in todo:
        stem_name = model_path(name).stem
        f0 = lo + (hi - lo) * (done / total_w)
        f1 = lo + (hi - lo) * ((done + w) / total_w)
        done += w
        emit_progress(f0, f"separate:{stem_name}")
        try:
            found, primary, second = separate_one(name, inp, work_dir, device)

            # Jalur sederhana: pakai STEM INSTRUMENTAL dari model apa adanya.
            #
            # Jangan tambahkan masking di sini. Versi sebelumnya memakai
            # magnitude_subtract + adaptive_center_suppress + boost HF, dan itu
            # yang menghasilkan "suara air": dua mask multiplicatif berturut-turut
            # di channel mid, error-nya menumpuk, dan harmonik vokal terpotong
            # sebagian-setengah. Terukur: burst envelope 12-16 kHz di frame hening
            # naik dari 0.197 (sumber) ke 0.348, dan detail backing ikut turun.
            # Stem mentah model + loudness-match menghasilkan korelasi 0.987 dengan
            # file yangPENGGUNA sukai, dan 4.3x lebih cepat.
            #
            # Kim_Vocal_2 memberi instrumental sebagai stem sekunder; RoFormer
            # bisa memberi primary atau secondary tergantung modelnya, jadi
            # keduanya diperiksa.
            inst = None
            for cand in (second, found):
                if cand is None:
                    continue
                p = Path(cand)
                if not p.is_file():
                    continue
                low = p.name.lower()
                if "(instrumental)" in low or "(other)" in low or "_no_vocals" in low or "(karaoke)" in low:
                    inst = dsp.to_stereo(dsp.fit_length(dsp.load_audio(p), mix.shape[-1]))
                    break
            if inst is None:
                raise RuntimeError(f"tidak menemukan stem instrumental dari {name}")
            inst_parts.append((inst.astype(np.float32), w))
            used.append(f"{stem_name}[{primary or '?'}]")
            eprint(f"[KaraokeSep] {name} w={w:.2f} primary={primary or '?'} "
                   f"-> instrumental mentah (tanpa masking)")
        except Exception as ex:
            eprint(f"[KaraokeSep] {name} gagal: {ex}")
        emit_progress(f1, f"separate:{stem_name}:done")

    if not inst_parts:
        raise RuntimeError("semua model gagal")

    inst = combine_instrumentals(mix, inst_parts, algorithm=algorithm)

    # Tahap-2 (v14, CUDA saja): keringkan sisa reverb hantu vokal, lalu blend
    # 65/35 dengan mentah. Gagal -> mentah dipakai (fallback, bukan failed).
    if dereverb and _dereverb_enabled() and (device or "").lower() != "cpu":
        try:
            clean = dereverb_instrumental(inst, work_dir, device,
                                          allow_download=allow_download)
        except Exception as ex:
            eprint(f"[KaraokeSep] tahap dereverb error: {ex}")
            clean = None
        if clean is not None:
            inst = dsp.to_stereo(dsp.fit_length(clean, mix.shape[-1])).astype(np.float32)
            used.append("dereverb_anvuew[dry-blend]")
        else:
            eprint("[KaraokeSep] tahap dereverb dilewati/gagal; instrumental mentah dipakai")

    vocal = np.zeros_like(mix)

    out_dir.mkdir(parents=True, exist_ok=True)
    inst_path = out_dir / "no_vocals.wav"
    vocal_path = out_dir / "_vocals.wav"
    dsp.write_wav(inst_path, inst)
    dsp.write_wav(vocal_path, vocal)
    try:
        for p in work_dir.rglob("*_*.wav"):
            if p.is_file() and p.name not in ("_vocals.wav",):
                p.unlink()
    except Exception:
        pass
    try:
        work_dir.rmdir()
    except Exception:
        pass

    return {
        "instrumental": inst_path,
        "vocals": vocal_path,
        "mix_peak": peak,
        "models": used,
        "weights": {model_path(n).stem: w for n, w in todo},
        "vocal_kill": float(vocal_kill),
    }
