#!/usr/bin/env python3
"""
BS-RoFormer karaoke separator via audio-separator — Kim_Vocal_2 ONLY.

Disederhanakan dari versi cascade 3-model: Kim terbukti jalan di RTX 3050 4GB
(music-dl), cascade hanya menambah waktu/OOM tanpa manfaat. Gagal = exit cepat
dengan pesan jelas (bukan coba model berikut).

Pipeline karaoke (otomatis, tanpa opsi):
1. Kim_Vocal_2 pisah vokal -> no_vocals.wav.

Post:
- precise (high): loudness-match gain ke LUFS input + limiter (kualitas maks).
- fast (standard): lewati loudnorm, pakai hasil mentah (1 pass ffmpeg lebih sedikit).

Progress: emit 2/10/72/82/90/94 + heartbeat tiap 15 dtk selama inferensi
yang memblokir (sep.separate tidak memberi callback), agar pemanggil tahu
proses hidup — heartbeat dibatasi 10..68 supaya tidak mendahului progres asli.

Usage: bs_roformer_separate.py <input> <out_dir> <cuda|cpu> [precise|fast]
"""
import gc
import sys, os, json, pathlib, shutil, subprocess, threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import win_nowindow

win_nowindow.hide_child_consoles()

MODEL = "Kim_Vocal_2"


def _ffmpeg_bin():
    cand = os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg") or ""
    return cand


FFMPEG = _ffmpeg_bin()
if not FFMPEG:
    sys.stderr.write("[BS-RoFormer] WARNING: ffmpeg tidak ditemukan; "
                     "langkah loudnorm dilewati bila gagal.\n")


def eprint(*a): print(*a, file=sys.stderr)


def emit_progress(pct: float, stage: str):
    try:
        sys.stdout.write(json.dumps({"karaoke_progress": round(float(pct), 1), "karaoke_stage": str(stage)}) + "\n")
        sys.stdout.flush()
    except: pass


def _free_vram(tag: str):
    try:
        gc.collect()
    except Exception:
        pass
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            eprint(f"[BS-RoFormer] VRAM dibersihkan ({tag})")
    except Exception:
        pass


class _Heartbeat(threading.Thread):
    """Emit progres pelan selama inferensi memblokir. Daemon, dihentikan via stop()."""
    def __init__(self, stage: str):
        super().__init__(daemon=True)
        self.stage = stage
        self.stop_ev = threading.Event()
        self.pct = 10.0

    def run(self):
        while not self.stop_ev.wait(15):
            self.pct = min(68.0, self.pct + 4.0)
            emit_progress(self.pct, self.stage)

    def stop(self):
        self.stop_ev.set()


def _measure(p: str):
    """Ukur (input_i, input_tp) via loudnorm print_format=json. Return (None, None) bila gagal."""
    try:
        import json as _js
        if not FFMPEG:
            return None, None
        r = subprocess.run([FFMPEG, "-i", p, "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
                            "-f", "null", "-"], capture_output=True, text=True, timeout=300)
        t = r.stderr; s = t.find("{"); e = t.rfind("}")
        if s >= 0 and e >= 0:
            j = _js.loads(t[s:e + 1])
            return float(j.get("input_i", -14)), float(j.get("input_tp", -1))
    except Exception:
        pass
    return None, None


def main():
    if len(sys.argv) < 4:
        eprint("usage: bs_roformer_separate.py <input> <out_dir> <cuda|cpu> [precise|fast]")
        sys.exit(2)
    inp = sys.argv[1]
    out_dir = sys.argv[2]
    device = sys.argv[3].lower()
    post = sys.argv[4].lower() if len(sys.argv) >= 5 else "precise"
    if post not in ("precise", "fast"):
        post = "precise"
    emit_progress(2, "start")
    try:
        import torch
        eprint(f"[BS-RoFormer] torch {torch.__version__} cuda={torch.cuda.is_available()}"
               + (f" ({torch.cuda.get_device_name(0)})" if torch.cuda.is_available() else ""))
        try:
            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info()
                eprint(f"[BS-RoFormer] VRAM bebas {free_b/1e9:.1f}/{total_b/1e9:.1f} GB")
        except Exception:
            pass
        try:
            import onnxruntime as ort
            eprint(f"[BS-RoFormer] ONNX {ort.__version__} {ort.get_available_providers()}")
        except Exception as ex:
            eprint(f"[BS-RoFormer] ONNX probe gagal: {ex}")
    except Exception as ex:
        eprint(f"[BS-RoFormer] torch probe gagal: {ex}")
    try:
        from audio_separator.separator import Separator
        base = pathlib.Path(inp).stem
        target_out = pathlib.Path(out_dir) / "mdx_extra" / base
        target_out.mkdir(parents=True, exist_ok=True)
        eprint(f"[BS-RoFormer] {MODEL} device={device} post={post}")
        sep = Separator(output_dir=str(target_out), output_format="WAV",
                        model_file_dir=os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                                                    "audio-separator-models"))
        sep.load_model(model_filename=f"{MODEL}.onnx")
        emit_progress(10, f"separate:{MODEL}")
        hb = _Heartbeat(f"separate:{MODEL}")
        hb.start()
        try:
            outputs = sep.separate(inp)
        finally:
            hb.stop()
        try:
            del sep
        except Exception:
            pass
        _free_vram("after-separate")
        emit_progress(72, f"separate:{MODEL}:done")
        found_voc = None; found_inst = None
        for p in outputs or []:
            low = p.lower()
            if "vocal" in low: found_voc = p
            elif "instrument" in low or "accompan" in low: found_inst = p
        if not found_voc or not found_inst:
            for f in target_out.glob("*.wav"):
                n = f.name.lower()
                if not found_voc and "vocal" in n: found_voc = str(f)
                if not found_inst and ("instrument" in n or "accompan" in n): found_inst = str(f)
        if not (found_voc and found_inst):
            eprint(f"[BS-RoFormer] {MODEL} tidak menghasilkan sepasang stem "
                   f"(voc={found_voc}, inst={found_inst}). Fail-fast, tanpa cascade.")
            sys.exit(3)
        found_voc = str(pathlib.Path(found_voc).resolve()) if not pathlib.Path(found_voc).is_absolute() else found_voc
        found_inst = str(pathlib.Path(found_inst).resolve()) if not pathlib.Path(found_inst).is_absolute() else found_inst
        if not pathlib.Path(found_voc).exists():
            alt = target_out / pathlib.Path(found_voc).name
            if alt.exists(): found_voc = str(alt)
        if not pathlib.Path(found_inst).exists():
            alt = target_out / pathlib.Path(found_inst).name
            if alt.exists(): found_inst = str(alt)
        normed_inst = str(target_out / "no_vocals.wav")
        if pathlib.Path(found_inst) != pathlib.Path(normed_inst):
            shutil.move(found_inst, normed_inst)
        else:
            normed_inst = found_inst
        try:
            if pathlib.Path(found_voc).exists(): pathlib.Path(found_voc).unlink()
        except: pass
        for f in target_out.glob("*.wav"):
            if f.name != "no_vocals.wav":
                try: f.unlink()
                except: pass
        if post == "precise":
            _inp_i, _inp_tp = _measure(inp)
            _inst_i, _inst_tp = _measure(normed_inst)
            if _inp_i is not None and _inst_i is not None:
                _gain = _inp_i - _inst_i
                if _inst_tp is not None and _inst_tp + _gain > -1: _gain = -1 - _inst_tp
                _af = f"volume={_gain:.2f}dB,alimiter=limit=-1dB"
                eprint(f"[BS-RoFormer] gain {_gain:.2f}dB (inp {_inp_i:.1f} -> inst {_inst_i:.1f})")
            else:
                _af = "loudnorm=I=-14:TP=-1:LRA=11"
                eprint("[BS-RoFormer] measure fail fallback -14")
            emit_progress(82, "loudnorm")
            tmp_inst = str(target_out / "_inst_norm.wav")
            try:
                if not FFMPEG:
                    raise RuntimeError("ffmpeg tidak tersedia")
                subprocess.run([FFMPEG, "-y", "-i", normed_inst, "-af", _af, tmp_inst],
                               check=True, capture_output=True, timeout=600)
                shutil.move(tmp_inst, normed_inst)
            except Exception as ex:
                eprint(f"[BS-RoFormer] loudnorm post failed, keeping raw: {ex}")
            emit_progress(90, "loudnorm:done")
        else:
            eprint("[BS-RoFormer] post=fast, lewati loudnorm (hasil mentah)")
            emit_progress(90, "loudnorm:skipped")
        eprint(f"[BS-RoFormer] Inst: {normed_inst} (vocals discarded)")
        _free_vram("final")
        emit_progress(94, "wav:done")
        print(json.dumps({"vocals": "", "instrumental": normed_inst, "model": MODEL}))
        return 0
    except SystemExit:
        raise
    except Exception as ex:
        eprint(f"[BS-RoFormer] {MODEL} failed: {ex}")
        import traceback; traceback.print_exc()
        sys.exit(4)


if __name__ == "__main__": sys.exit(main())
