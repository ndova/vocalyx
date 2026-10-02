#!/usr/bin/env python3
"""Runtime smoke test untuk fungsi backend karaoke.

KENAPA ADA FILE INI
-------------------
``node tests/smoke.mjs`` hanya greping string, dan ``import vx_separate``
hanya mengeksekusi level modul. Keduanya TIDAK menangkap nama yang salah ketik
di dalam badan fungsi -- NameError baru muncul saat fungsi dipanggil.

Bug yang lolos ke build terpasang: ``KAROKE_DSP_VERSION`` (tanpa huruf A)
terkena di 5 tempat, termasuk ``_persist_signature()`` yang dipanggil setiap
karaoke job dan ``karaoke_caps()`` yang dipanggil app untuk deteksi CUDA.
Hasilnya ``/separate/caps`` balas 500 terus-menerus.

File ini memanggil fungsi-fungsi itu sungguhan, tanpa perlu server. Kalau ada
nama yang rusak lagi, test ini gagal di sini -- bukan setelah install.

Jalankan:  python tests/test_api_surface.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

FAIL = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"  {detail}" if detail else ""))
    if not ok:
        FAIL.append(name)


def section(title):
    print(f"\n--- {title} ---")


def main():
    # =============================================== import (tanpa efek samping)
    import vx_separate as sep
    import vx_sep_cache as cache
    import vx_karaoke_sep as ksep
    import vx_karaoke_dsp as dsp

    section("konstanta")
    check("BEST_MODEL = Kim_Vocal_2", cache.BEST_MODEL[0] == "Kim_Vocal_2.onnx",
          cache.BEST_MODEL[0])
    check("BEST_MODEL_ROFORMER = Resurrection",
          cache.BEST_MODEL_ROFORMER[0].startswith("bs_roformer"),
          cache.BEST_MODEL_ROFORMER[0])
    check("KARAOKE_DSP_VERSION ada", isinstance(cache.KARAOKE_DSP_VERSION, int),
          str(cache.KARAOKE_DSP_VERSION))
    check("KARAOKE_PRESETS punya 2 preset", set(cache.KARAOKE_PRESETS) ==
          {"karaoke_aufr33", "cpu_inst_hq"},
          str(list(cache.KARAOKE_PRESETS)))
    check("MIN_FREE_VRAM_GB = 0.5", sep.MIN_FREE_VRAM_GB == 0.5,
          str(sep.MIN_FREE_VRAM_GB))
    check("quality aufr33 diterima (default)",
          "karaoke_aufr33" in cache.KARAOKE_PRESETS)

    # ================================ _model_fingerprint (3x KAROKE typo dulu)
    section("_model_fingerprint()")
    try:
        fp = cache._model_fingerprint()
        check("bisa dipanggil tanpa exception", isinstance(fp, str) and len(fp) > 0,
              repr(fp[:40]))
    except Exception as ex:
        check("bisa dipanggil tanpa exception", False, f"{type(ex).__name__}: {ex}")
        fp = ""

    # ================================ _persist_signature (dipanggil tiap job)
    section("_persist_signature()")
    try:
        sig = cache._persist_signature("karaoke", "high", 1.0, 1.0, True, {})
        ok = isinstance(sig, dict) and sig.get("version") == cache.KARAOKE_DSP_VERSION
        check("bisa dipanggil + version benar", ok, f"version={sig.get('version')!r}")
        check("signature punya mode/quality/match_level",
              all(k in sig for k in ("mode", "quality", "match_level")),
              str(sorted(sig.keys())))
    except Exception as ex:
        check("bisa dipanggil + version benar", False, f"{type(ex).__name__}: {ex}")

    # ================================================= karaoke_caps (500 dulu)
    section("karaoke_caps()")
    try:
        caps = sep.karaoke_caps("cpu")
        check("tidak melempar (dulu NameError)", True)
        check("ok=True", caps.get("ok") is True)
        check("dsp_version = KARAOKE_DSP_VERSION",
              caps.get("dsp_version") == cache.KARAOKE_DSP_VERSION,
              repr(caps.get("dsp_version")))
        q = caps.get("quality") or []
        check("quality caps berisi 2 preset", set(q) == {"karaoke_aufr33", "cpu_inst_hq"}, str(q))
        check("min_free_vram_gb = 0.5", caps.get("min_free_vram_gb") == 0.5,
              str(caps.get("min_free_vram_gb")))
        check("formats berisi flac/ogg/wav",
              set(caps.get("formats") or []) == {"flac", "ogg", "wav"},
              str(caps.get("formats")))
        d = caps.get("defaults") or {}
        check("defaults tidak lagi mengiklankan slider yang dihapus",
              "vocal_kill" not in d and "centre_kill" not in d, str(sorted(d.keys())))
        check("caps punya field yang dibaca frontend",
              all(k in caps for k in ("cuda", "device", "providers",
                                      "vram_free_gb", "min_free_vram_gb",
                                      "kim_cached", "cpu_name", "cpu_threads")))
    except Exception as ex:
        check("tidak melempar (dulu NameError)", False, f"{type(ex).__name__}: {ex}")

    # ============================================================ combine stem
    section("combine_instrumentals()")
    n = 8000
    a = np.zeros((2, n), dtype=np.float32)
    b = np.zeros((2, n), dtype=np.float32)
    a[:] = 0.4
    b[:] = 0.2
    mix = np.zeros((2, n), dtype=np.float32)
    mix[:] = 0.3
    try:
        one = ksep.combine_instrumentals(mix, [(a, 1.0)])
        check("satu stem -> balik apa adanya",
              one.shape == mix.shape and abs(float(np.abs(one - a).max())) < 1e-6,
              f"maxerr {float(np.abs(one - a).max()):.2e}")
        two = ksep.combine_instrumentals(mix, [(a, 1.0), (b, 1.0)])
        expect = (a + b) / 2.0
        err = float(np.abs(two - expect).max())
        check("dua stem -> rata-rata tertimbang", err < 1e-6, f"maxerr {err:.2e}")
        empty = False
        try:
            ksep.combine_instrumentals(mix, [])
        except RuntimeError:
            empty = True
        check("parts kosong -> RuntimeError (bukan diam)", empty)
    except Exception as ex:
        check("combine_instrumentals() jalan", False, f"{type(ex).__name__}: {ex}")

    # ========================================== weighted_sum (masih dipakai)
    section("weighted_sum()")
    try:
        ws = dsp.weighted_sum(mix, [(a, 1.0), (b, 1.0)], 2.0)
        err = float(np.abs(ws - (a + b) / 2.0).max())
        check("rata-rata benar", err < 1e-6, f"maxerr {err:.2e}")
        check("total_weight 0 -> silence", float(np.abs(dsp.weighted_sum(mix, [(a, 1.0)], 0.0)).max()) == 0.0)
    except Exception as ex:
        check("weighted_sum() jalan", False, f"{type(ex).__name__}: {ex}")

    # ============================== preset karaoke_best.py terbaca dari cache
    section("skrip karaoke")
    for script in ("karaoke_best.py", "karaoke_standard.py", "karaoke_mdx.py"):
        p = Path(__file__).resolve().parent.parent / "scripts" / script
        check(f"{script} ada", p.is_file())
    check("karaoke_high.py (ensemble 2-model) sudah dihapus",
          not (Path(__file__).resolve().parent.parent / "scripts" / "karaoke_high.py").exists())
    check("vx_karaoke_mask.py (sumber 'suara air') sudah dihapus",
          not (Path(__file__).resolve().parent.parent / "vx_karaoke_mask.py").exists())

    print()
    if FAIL:
        print(f"{len(FAIL)} GAGAL: " + "; ".join(FAIL))
        return 1
    print("semua ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())