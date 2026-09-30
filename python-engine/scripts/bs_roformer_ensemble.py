#!/usr/bin/env python3
"""
LALAL.AI Phoenix-like 3-model ensemble via audio-separator ONNX.
High: Kim_Vocal_2 (BS-RoFormer) -> UVR-MDX-NET-Vocal-FT -> UVR-MDX-NET-Inst_HQ_4 (3-pass sequential residual, nearest to LALAL without true averaging).
Standard: Kim_Vocal_2 single.
Only no_vocals.wav, loudnorm I=-14 (no anlmdn grainy).
Usage: python bs_roformer_ensemble.py <input> <out_dir> <cuda|cpu> <high|standard>
"""
import sys, os, pathlib, json, subprocess, shutil

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import win_nowindow

win_nowindow.hide_child_consoles()

FFMPEG = os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg") or ""
if not FFMPEG:
    sys.stderr.write("[Ensemble-LALAL] WARNING: ffmpeg tidak ditemukan; "
                     "langkah loudnorm/mix bisa gagal.\n")

def eprint(*a): print(*a, file=sys.stderr)

def find_stems(outputs, search_dir: pathlib.Path):
    found_voc=None; found_inst=None
    for p in outputs or []:
        low=p.lower()
        if "vocal" in low: found_voc=p
        elif "instrument" in low or "accompan" in low or "no_voc" in low: found_inst=p
    if not found_voc or not found_inst:
        for f in search_dir.glob("*.wav"):
            n=f.name.lower()
            if not found_voc and "vocal" in n: found_voc=str(f)
            if not found_inst and ("instrument" in n or "accompan" in n or "no_voc" in n): found_inst=str(f)
    if not found_voc:
        wavs=list(search_dir.glob("*.wav"))
        if len(wavs)>=1: found_voc=str(wavs[0])
        if len(wavs)>=2 and not found_inst: found_inst=str(wavs[1])
    return found_voc, found_inst

def sep_one(model_file: str, inp: str, out_dir: pathlib.Path, model_dir: str):
    from audio_separator.separator import Separator
    sep=Separator(output_dir=str(out_dir), output_format="WAV", model_file_dir=model_dir)
    sep.load_model(model_filename=model_file)
    out=sep.separate(inp)
    return find_stems(out, out_dir)

def emit_progress(pct: float, stage: str):
    try:
        sys.stdout.write(json.dumps({"karaoke_progress": round(float(pct), 1), "karaoke_stage": str(stage)}) + "\n")
        sys.stdout.flush()
    except: pass

def main():
    if len(sys.argv) < 4:
        eprint("usage: bs_roformer_ensemble.py <input> <out_dir> <cuda|cpu> [high|standard]")
        sys.exit(2)
    inp=sys.argv[1]
    out_dir=sys.argv[2]
    device=sys.argv[3].lower()
    quality=sys.argv[4].lower() if len(sys.argv)>=5 else "high"
    use_ensemble=quality=="high"
    eprint(f"[Ensemble-LALAL] quality={quality} 3-model={use_ensemble} device={device}")
    emit_progress(2, "start")

    try:
        import onnxruntime as ort
        eprint(f"[Ensemble-LALAL] ONNX {ort.get_available_providers()} v{ort.__version__}")
        base=pathlib.Path(inp).stem
        target_out=pathlib.Path(out_dir)/"mdx_extra"/base
        target_out.mkdir(parents=True, exist_ok=True)
        model_dir=os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "audio-separator-models")

        tmp1=target_out/"_tmp1_kim"
        tmp2=target_out/"_tmp2_mdxv"
        tmp3=target_out/"_tmp3_mdxi"
        for d in [tmp1,tmp2,tmp3]:
            if d.exists(): shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True, exist_ok=True)

        weights = {"Kim_Vocal_2.onnx": 0.5, "UVR-MDX-NET-Vocal-FT.onnx": 0.3, "UVR-MDX-NET-Inst_HQ_4.onnx": 0.2} if use_ensemble else {"Kim_Vocal_2.onnx": 1.0}
        insts=[]
        items=list(weights.items())
        sep_lo, sep_hi = 5.0, 70.0
        cum = 0.0
        total_w = sum(w for _, w in items) or 1.0
        for mi, (mf, w) in enumerate(items):
            frac0 = sep_lo + (sep_hi - sep_lo) * (cum / total_w)
            frac1 = sep_lo + (sep_hi - sep_lo) * ((cum + w) / total_w)
            cum += w
            emit_progress(frac0, f"separate:{pathlib.Path(mf).stem}")
            tmp = tmp1 if "Kim" in mf else (tmp2 if "Vocal-FT" in mf else tmp3)
            eprint(f"[Ensemble-LALAL] {mf} weight {w}")
            try:
                _, inst = sep_one(mf, inp, tmp, model_dir)
                if inst and pathlib.Path(inst).exists():
                    dst=str(target_out/f"_inst_{pathlib.Path(mf).stem}.wav")
                    shutil.copy(inst, dst)
                    insts.append((dst, w))
                    eprint(f"[Ensemble-LALAL] {mf} {pathlib.Path(dst).stat().st_size} bytes")
                else:
                    eprint(f"[Ensemble-LALAL] {mf} no inst")
            except Exception as ex:
                eprint(f"[Ensemble-LALAL] {mf} failed: {ex}")
            emit_progress(frac1, f"separate:{pathlib.Path(mf).stem}:done")
        if not insts:
            eprint(f"[Ensemble-LALAL] no inst at all")
            sys.exit(3)
        emit_progress(72, "mix")
        if len(insts)==1:
            s_avg=insts[0][0]
        else:
            s_avg=str(target_out/"_avg.wav")
            import shlex
            inputs=[]
            for p,_ in insts: inputs.extend(["-i", p])
            w_str=" ".join(str(w) for _,w in insts)
            if not FFMPEG:
                eprint("[Ensemble-LALAL] mix dilewati (ffmpeg tidak ada)")
                s_avg = insts[0][0]
            else:
                cmd=[FFMPEG,"-y"]
                for p,_ in insts: cmd.extend(["-i", p])
                filt=f"amix=inputs={len(insts)}:duration=longest:normalize=0:weights={w_str},alimiter=limit=-1dB"
                cmd.extend(["-filter_complex", filt, s_avg])
                eprint(f"[Ensemble-LALAL] amix {w_str}")
                subprocess.run(cmd, check=True, capture_output=True)
        emit_progress(78, "mix:done")
        final=s_avg
        s1=insts[0][0] if insts else final

        normed=str(target_out/"no_vocals.wav")
        for f in target_out.glob("vocals*"):
            try: f.unlink()
            except: pass
        def measure(p: str):
            try:
                if not FFMPEG:
                    return None, None
                r=subprocess.run([FFMPEG,"-i",p,"-af","loudnorm=I=-14:TP=-1:LRA=11:print_format=json","-f","null","-"], capture_output=True, text=True)
                txt=r.stderr; s=txt.find("{"); e=txt.rfind("}")
                if s>=0 and e>=0:
                    j=json.loads(txt[s:e+1]); return float(j.get("input_i", -14)), float(j.get("input_tp", -1))
            except: pass
            return None, None
        inp_i, _ = measure(inp)
        target_i = f"{inp_i:.1f}" if inp_i is not None else "-11"
        af_target = f"loudnorm=I={target_i}:TP=-1:LRA=11"
        eprint(f"[Ensemble-LALAL] loudnorm target I={target_i} (input {inp_i})")
        emit_progress(82, "loudnorm")
        tmp_norm=str(target_out/"_norm.wav")
        try:
            if not FFMPEG:
                raise RuntimeError("ffmpeg tidak tersedia")
            subprocess.run([FFMPEG,"-y","-i",final,"-af",af_target, tmp_norm], check=True, capture_output=True)
            shutil.move(tmp_norm, normed)
            emit_progress(90, "loudnorm:done")
            for p in [final, s1]:
                try:
                    if pathlib.Path(p).exists() and pathlib.Path(p)!=pathlib.Path(normed):
                        pathlib.Path(p).unlink()
                except: pass
            try:
                s2p=target_out/"_stage2.wav"
                if s2p.exists() and s2p!=pathlib.Path(normed): s2p.unlink()
            except: pass
        except Exception as e:
            eprint(f"[Ensemble-LALAL] loudnorm fail keep raw: {e}")
            if pathlib.Path(final)!=pathlib.Path(normed):
                shutil.copy(final, normed)

        for d in [tmp1,tmp2,tmp3]:
            try: shutil.rmtree(d, ignore_errors=True)
            except: pass
        for f in target_out.glob("_stage*.wav"):
            try: f.unlink()
            except: pass
        for f in target_out.glob("*.wav"):
            if f.name!="no_vocals.wav":
                try: f.unlink()
                except: pass

        eprint(f"[Ensemble-LALAL] Final: {normed}")
        emit_progress(94, "wav:done")
        print(json.dumps({"vocals": "", "instrumental": normed, "model": "lalal-3model" if use_ensemble else "Kim_Vocal_2"}))
        return 0
    except Exception as ex:
        eprint(f"[Ensemble-LALAL] failed: {ex}")
        import traceback; traceback.print_exc()
        sys.exit(4)

if __name__=="__main__": sys.exit(main())
