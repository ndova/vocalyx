
"""Smoke end-to-end endpoint /separate VocaLyx (dev only).

    python python-engine/tests/smoke_separate_api.py <engine_base> <track> <quality>
"""
import json
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123"
TRACK = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("sample/baru.flac")
QUALITY = sys.argv[3] if len(sys.argv) > 3 else "standard"
VOCAL_KILL = sys.argv[4] if len(sys.argv) > 4 else "1.00"
CENTRE_KILL = sys.argv[5] if len(sys.argv) > 5 else "1.00"
FMT = sys.argv[6] if len(sys.argv) > 6 else "flac"

SUFFIX = TRACK.suffix.lower()
CT = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
      ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg"}[SUFFIX]


def post_separate():
    boundary = "----vx" + uuid.uuid4().hex
    fields = [
        ("mode", "karaoke"), ("model", "bsroformer"), ("quality", QUALITY),
        ("device", "cuda"), ("format", FMT), ("vocal_kill", VOCAL_KILL),
        ("centre_kill", CENTRE_KILL), ("track_path", str(TRACK.resolve())),
    ]
    raw = TRACK.read_bytes()
    out = bytearray()
    out += f"--{boundary}\r\n".encode()
    out += f'Content-Disposition: form-data; name="file"; filename="{TRACK.name}"\r\n'.encode()
    out += f"Content-Type: {CT}\r\n\r\n".encode()
    out += raw + b"\r\n"
    for k, v in fields:
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    out += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE}/separate", data=bytes(out),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=60) as r:
        return json.loads(r.read().decode())


def wait(job_id, limit_s=1800):
    t0 = time.time()
    last = None
    while time.time() - t0 < limit_s:
        p = get(f"/separate/progress?job_id={job_id}")
        key = (p.get("status"), p.get("pct"), p.get("stage"))
        if key != last:
            print(f"  {time.time()-t0:6.1f}s  {p.get('status'):<9} {p.get('pct',0):5}%  {p.get('stage')}")
            last = key
        if p.get("status") in ("done", "failed", "cancelled"):
            return p
        time.sleep(1.5)
    return {"status": "timeout"}


def fetch_result(job_id, dest: Path):
    with urllib.request.urlopen(f"{BASE}/separate/result?job_id={job_id}", timeout=300) as r:
        dest.write_bytes(r.read())
    return dest


def probe(path: Path) -> dict:
    """ffprobe: bit depth + sample_fmt; untuk verifikasi ukuran keluaran."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from vx_core import ffprobe_bin
    import subprocess as _sp
    fp = ffprobe_bin()
    if not fp:
        return {}
    try:
        p = _sp.run([fp, "-v", "error", "-select_streams", "a:0",
                     "-show_entries", "stream=bits_per_raw_sample,sample_fmt,channels,sample_rate",
                     "-of", "default=noprint_wrappers=1", str(path)],
                    capture_output=True, text=True, timeout=30)
    except Exception:
        return {}
    info = {}
    for line in (p.stdout or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k.strip()] = v.strip()
    return info


def duration_sec(path: Path):
    """Durasi detik via ffprobe engine."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from vx_core import ffprobe_bin
    import subprocess as _sp
    fp = ffprobe_bin()
    if not fp:
        return None
    try:
        p = _sp.run([fp, "-v", "error", "-show_entries", "format=duration",
                     "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                    capture_output=True, text=True, timeout=30)
        return float((p.stdout or "").strip())
    except Exception:
        return None


def measure(path: Path):
    """(LUFS, true peak) via vx_karaoke_dsp.measure_loudness."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import vx_karaoke_dsp as dsp
    return dsp.measure_loudness(path)


def main():
    print(f"engine {BASE}  track {TRACK}  quality={QUALITY} vocal_kill={VOCAL_KILL} centre_kill={CENTRE_KILL}")
    job = post_separate()
    print("start:", job)
    if job.get("cached"):
        print("cache hit (tanpa kerja) -> ok")
        return 0
    res = wait(job["job_id"])
    if res.get("status") != "done":
        print("GAGAL:", res.get("error", "")[:1500])
        try:
            print(get(f"/separate/log?job_id={job['job_id']}&tail=40")["log"][-2500:])
        except Exception as ex:
            print("log error:", ex)
        return 1
    out = Path(tempfile.gettempdir()) / "vocalyx-apptest" / ("api_out." + FMT)
    out.parent.mkdir(parents=True, exist_ok=True)
    fetch_result(job["job_id"], out)
    size = out.stat().st_size
    print(f"result {out} {size} bytes ({size/1024/1024:.2f} MB)")
    info = probe(out)
    print(f"probe  bits_per_raw_sample={info.get('bits_per_raw_sample')!r} "
          f"sample_fmt={info.get('sample_fmt')!r} {info.get('channels')}ch "
          f"{info.get('sample_rate')}Hz")

    fails = []
    if info.get("sample_fmt") not in ("s16", "u16p"):
        fails.append(f"bit depth bukan 16 (sample_fmt={info.get('sample_fmt')})")

    lufs, tp = measure(out)
    print(f"loudness {lufs:.2f} LUFS  true peak {tp:.2f} dBTP")
    if tp is None or tp > -1.0:
        fails.append(f"true peak {tp} di atas -1 dBTP")

    
    
    
    ref = TRACK
    if ref.is_file() and ref != out:
        ref_i, _ = measure(ref)
        if ref_i is not None and lufs is not None:
            delta = lufs - ref_i
            print(f"original {ref_i:.2f} LUFS -> delta {delta:+.2f} LU")
            if abs(delta) > 1.5:
                fails.append(f"loudness {lufs:.2f} LUFS tidak match lagu asli "
                             f"{ref_i:.2f} LUFS (delta {delta:+.2f} LU)")
        elif lufs is not None and abs(lufs - (-13.0)) > 1.5:
            
            fails.append(f"loudness {lufs:.2f} LUFS tidak di sekitar -13 LUFS")
    elif lufs is not None and abs(lufs - (-13.0)) > 1.5:
        fails.append(f"loudness {lufs:.2f} LUFS tidak di sekitar -13 LUFS")

    
    
    dur = duration_sec(out) or 0.0
    pcm16 = dur * 44100 * 2 * 2
    mb = size / 1024 / 1024
    hi = pcm16 * 0.80 / 1024 / 1024  
    print(f"size check: {mb:.2f} MB untuk {dur:.0f}s "
          f"(PCM16 {pcm16/1024/1024:.1f} MB, batas {hi:.2f} MB)")
    if pcm16 > 0 and size > pcm16 * 0.80:
        fails.append(f"keluaran {mb:.2f} MB melebihi batas 16-bit {hi:.2f} MB")

    
    
    
    
    
    if ref.is_file() and ref != out:
        try:
            import numpy as np
            sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
            import vx_karaoke_dsp as dsp
            from scipy.signal import butter, lfilter
            a = dsp.load_audio(ref)
            b = dsp.load_audio(out)
            n = min(a.shape[-1], b.shape[-1])
            a, b = a[..., :n], b[..., :n]
            
            
            def _best_lag(x, y, mx=1000):
                N = 1 << int(np.ceil(np.log2(len(x) + mx)))
                A = np.fft.rfft(x, N)
                B = np.fft.rfft(y, N)
                cc = np.fft.irfft(A * np.conj(B), N)
                cc = np.concatenate([cc[-mx:], cc[:mx + 1]])
                return int(np.argmax(cc)) - mx
            ma0 = (a[0] + a[1]) * 0.5
            mb0 = (b[0] + b[1]) * 0.5
            LAG = _best_lag(ma0, mb0)
            if LAG > 0:
                bb, aa = b[:, LAG:], a[:, :-LAG]
            elif LAG < 0:
                bb, aa = b[:, :LAG], a[:, -LAG:]
            else:
                bb, aa = b, a
            fbb, faa = butter(4, [200 / 22050, 1000 / 22050], btype="band")
            ma = lfilter(fbb, faa, (aa[0] + aa[1]) * 0.5)
            mb = lfilter(fbb, faa, (bb[0] + bb[1]) * 0.5)
            vc = float(np.corrcoef(ma, mb)[0, 1])
            print(f"korelasi vokal (200-1k mid) vs sumber: {vc:+.3f} (lag {LAG:+d}, info saja)")
        except Exception as ex:
            print(f"info korelasi dilewati: {ex}")

    if fails:
        print("GAGAL:", "; ".join(fails))
        return 1
    print("smoke_separate_api OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
