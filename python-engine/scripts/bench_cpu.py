
"""Benchmark waktu separasi CPU untuk beberapa model karaoke/instrumental.

Menjalankan build_instrumental_from_models dengan satu model per uji,
mencatat waktu dinding (wall-clock) dan Separation duration dari stderr,
lalu menulis benchmarks/cpu/timings.json.
"""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import win_nowindow  

win_nowindow.hide_child_consoles()

import vx_karaoke_sep as sep  

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "benchmarks" / "cpu"
CLIP = ROOT / "tmp_cpu60.wav"

CANDIDATES = [
    ("standard_resurrection", "bs_roformer_instrumental_resurrection_unwa.ckpt"),
    ("Kim_Vocal_2", "Kim_Vocal_2.onnx"),
    ("UVR_MDX_NET_Inst_HQ_4", "UVR-MDX-NET-Inst_HQ_4.onnx"),
    ("Kim_Inst", "Kim_Inst.onnx"),
]


def main():
    results = []
    for name, model in CANDIDATES:
        dest = OUT / name
        import shutil
        shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        try:
            sep.build_instrumental_from_models(((model, 1.0),), CLIP, dest, "cpu",
                                               allow_download=False)
            ok = True
        except Exception as ex:
            ok = False
            print(f"[FAIL] {name}: {ex}")
        results.append({"name": name, "model": model, "wall_s": round(time.time() - t0, 1),
                        "ok": ok})
        print(f"[{'OK' if ok else 'FAIL'}] {name}: {time.time()-t0:.1f}s")
    (OUT / "timings.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
