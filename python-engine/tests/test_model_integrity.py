#!/usr/bin/env python3
"""Self-test untuk proteksi model corrupt (vx_karaoke_sep).

Kasus nyata: .ckpt 91,9 MB (lolos cek ukuran >= 8 MB) ternyata bukan zip
valid (central directory hilang, unduhan terpotong) lalu meledak saat
load_model di semua PC dengan koneksi tidak stabil. Lapis pertahanan:

1. _download_one menolak "sukses palsu" (got < total) — .part disimpan.
2. have_model menolak arsip .ckpt/.pth yang central directory-nya rusak.
3. separate_one self-heal: tanda corrupt -> buang + unduh ulang + retry sekali.
4. ensure_model_meta: 3 JSON meta audio-separator (download_checks,
   vr/mdx model_data) diambil dengan retry + validasi JSON — tanpa ini,
   ConnectionReset di tengah unduhan meta menggagalkan seluruh job dan
   file JSON setengah jadi meracuni run berikutnya.
5. ensure_model retry selama .part tumbuh (server masih mengalirkan data).
6. separate_one: error jaringan saat load -> segarkan meta + coba sekali lagi.
"""
import io
import json
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import vx_karaoke_sep as sep

FAIL = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"  {detail}" if detail else ""))
    if not ok:
        FAIL.append(name)


def make_zip(path, payload=b"x" * 64):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("data.bin", payload)


class FakeHeaders(dict):
    pass


class FakeResp:
    """Resp HTTP palsu: data terpotong (truncated) atau utuh."""

    def __init__(self, data, total, status=200):
        self._buf = io.BytesIO(data)
        self.status = status
        cr = f"bytes 0-{len(data)-1}/{total}" if status == 206 else ""
        self.headers = FakeHeaders({
            "Content-Length": str(total if status != 206 else len(data)),
            "Content-Range": cr,
        })

    def read(self, n=-1):
        return self._buf.read(n if n and n > 0 else 4096)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def main():
    tmp = Path(tempfile.mkdtemp(prefix="vocalyx-model-"))
    old_dir, old_min = sep.MODEL_DIR, sep.MIN_MODEL_BYTES
    sep.MODEL_DIR = tmp
    # Kecilkan ambang supaya test cepat (file MB-an tidak perlu ditulis).
    sep.MIN_MODEL_BYTES = 1024
    try:
        # ------------------------------------------------- have_model dasar
        check("have_model hilang -> False", sep.have_model("m.ckpt") is False)

        small = tmp / "m.ckpt"
        small.write_bytes(b"0" * 100)
        check("have_model kecil -> False", sep.have_model("m.ckpt") is False)

        # --------------------------------- ckpt terpotong tapi "besar" palsu
        trunc = tmp / "t.ckpt"
        trunc.write_bytes(b"\x50\x4b\x03\x04" + b"0" * 2048)  # header zip + sampah
        check("have_model ckpt terpotong -> False",
              sep.have_model("t.ckpt") is False, f"{trunc.stat().st_size} byte")

        # ------------------------------------------------- ckpt zip valid
        # Payload acak (tak termampatkan) supaya ukuran > ambang test dengan
        # isi zip yang tetap valid — tanpa menempel sampah setelah EOCD.
        good = tmp / "g.ckpt"
        import random
        rng = random.Random(1234)
        make_zip(good, bytes(rng.randrange(256) for _ in range(4096)))
        check("have_model ckpt zip valid -> True", sep.have_model("g.ckpt") is True,
              f"{good.stat().st_size} byte")

        # --------------------------------------- onnx tidak dicek sebagai zip
        onnx = tmp / "m.onnx"
        onnx.write_bytes(b"9" * 2048)
        check("have_model onnx biner acak -> True (bukan zip)",
              sep.have_model("m.onnx") is True)

        # ------------------------------------------------- _looks_corrupt
        corrupt_err = RuntimeError(
            "PytorchStreamReader failed reading zip archive: failed finding "
            "central directory. This is an internal miniz error.")
        check("_looks_corrupt central directory -> True",
              sep._looks_corrupt(corrupt_err) is True)
        check("_looks_corrupt OOM -> False",
              sep._looks_corrupt(RuntimeError("CUDA out of memory")) is False)
        check("_looks_corrupt config -> False",
              sep._looks_corrupt(ValueError("unexpected key in yaml")) is False)

        # ------------------------------------------------- _quarantine
        q = tmp / "q.ckpt"
        q.write_bytes(b"1" * 2048)
        qp = tmp / "q.ckpt.part"
        qp.write_bytes(b"2" * 512)
        sep._quarantine("q.ckpt")
        check("_quarantine hapus file + .part",
              not q.exists() and not qp.exists())

        # --------------------------------- _download_one tolak sukses palsu
        import urllib.request
        real_urlopen = urllib.request.urlopen
        full = b"D" * 5000
        try:
            # Kasus 1: server janji 5000 byte, koneksi putus di 2000.
            urllib.request.urlopen = lambda req, timeout=120: FakeResp(full[:2000], 5000)
            dest = tmp / "dl1.ckpt"
            ok = sep._download_one("http://x/dl1.ckpt", dest)
            part = dest.with_suffix(dest.suffix + ".part")
            check("unduhan terpotong ditolak", ok is False)
            check("dest tidak terbentuk", not dest.exists())
            check(".part disimpan untuk resume",
                  part.is_file() and part.stat().st_size == 2000)

            # Kasus 2: unduhan utuh tetap diterima.
            urllib.request.urlopen = lambda req, timeout=120: FakeResp(full, 5000)
            dest2 = tmp / "dl2.yaml"
            ok2 = sep._download_one("http://x/dl2.yaml", dest2)
            check("unduhan utuh diterima",
                  ok2 is True and dest2.is_file() and dest2.stat().st_size == 5000)

            # Kasus 3: server error -> False, tidak crash.
            def boom(req, timeout=120):
                raise URLError("putus")
            urllib.request.urlopen = boom
            ok3 = sep._download_one("http://x/dl3.ckpt", tmp / "dl3.ckpt")
            check("server error -> False", ok3 is False)
        finally:
            urllib.request.urlopen = real_urlopen

        # ------------------------- ensure_model force_fresh buang yang rusak
        # Pakai nama model asli (terdaftar di ROFORMER_CONFIGS) supaya jalur
        # unduh ckpt+yaml ditempuh; _download_one di-mock agar tanpa internet.
        real_ckpt = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
        bad = tmp / real_ckpt
        bad.write_bytes(b"\x50\x4b\x03\x04" + b"7" * 2048)
        calls = []
        real_dl = sep._download_one
        sep._download_one = lambda url, dest: calls.append(url) or True
        try:
            okf = sep.ensure_model(real_ckpt, force_fresh=True)
            check("force_fresh unduh ulang ckpt+yaml", okf is True and len(calls) == 2,
                  f"calls={len(calls)}")
            check("force_fresh buang file rusak", not bad.exists())
        finally:
            sep._download_one = real_dl

        # ------------------------------------------- _looks_network
        check("_looks_network ConnectionReset -> True",
              sep._looks_network(ConnectionResetError(10054, "diputus")) is True)
        check("_looks_network pesan requests -> True",
              sep._looks_network(Exception(("Connection aborted.", "x"))) is True)
        try:
            raise HTTPError("http://x/m.json", 500, "Server Error", {}, None)
        except Exception as e500:
            check("_looks_network HTTP 500 -> True", sep._looks_network(e500) is True)
        try:
            raise HTTPError("http://x/m.json", 404, "Not Found", {}, None)
        except Exception as e404:
            check("_looks_network HTTP 404 -> False", sep._looks_network(e404) is False)
        check("_looks_network OOM -> False",
              sep._looks_network(RuntimeError("CUDA out of memory")) is False)

        # ------------------------------------------- meta JSON valid/korup
        good_meta = tmp / "mdx_model_data.json"
        good_meta.write_text(json.dumps({"abc123": {"stems": ["a"]}}), encoding="utf-8")
        check("_meta_ok JSON valid -> True", sep._meta_ok(good_meta) is True)
        trunc_meta = tmp / "vr_model_data.json"
        trunc_meta.write_bytes(b'{"abc123": {"stems": ["a"]')
        check("_meta_ok JSON terpotong -> False", sep._meta_ok(trunc_meta) is False)
        check("_meta_ok hilang -> False", sep._meta_ok(tmp / "tak-ada.json") is False)

        # ------------------------------------------- _fetch_meta + retry
        old_backoff = sep._NET_BACKOFF_S
        sep._NET_BACKOFF_S = (0, 0)
        try:
            body = json.dumps({"h": {"x": 1}}).encode("utf-8")

            class JsonResp(FakeResp):
                def __init__(self, data):
                    super().__init__(data, len(data))

            urllib.request.urlopen = lambda req, timeout=30: JsonResp(body)
            mdest = tmp / "vr_model_data.json"
            if mdest.exists():
                mdest.unlink()
            check("_fetch_meta JSON utuh -> True + atomik",
                  sep._fetch_meta("http://x/v.json", mdest) is True
                  and mdest.is_file()
                  and not mdest.with_suffix(mdest.suffix + ".part").exists())

            urllib.request.urlopen = lambda req, timeout=30: JsonResp(b'{"h": {"x":')
            bdest = tmp / "download_checks.json"
            check("_fetch_meta JSON rusak ditolak",
                  sep._fetch_meta("http://x/d.json", bdest) is False
                  and not bdest.exists())

            state = {"n": 0}

            def flaky(req, timeout=30):
                state["n"] += 1
                if state["n"] == 1:
                    raise URLError("putus di tengah")
                return JsonResp(body)

            urllib.request.urlopen = flaky
            fdest = tmp / "mdx_model_data.json"
            if fdest.exists():
                fdest.unlink()
            check("_fetch_meta retry 1x lalu ok",
                  sep._fetch_meta("http://x/m.json", fdest) is True
                  and state["n"] == 2 and fdest.is_file())
        finally:
            urllib.request.urlopen = real_urlopen
            sep._NET_BACKOFF_S = old_backoff

        # ------------------------------------------- ensure_model retry tumbuh
        real_dl2 = sep._download_one
        tries = {"n": 0}

        def growing(url, dest):
            tries["n"] += 1
            dest.with_suffix(dest.suffix + ".part").write_bytes(b"z" * tries["n"])
            return False

        sep._download_one = growing
        try:
            sep._NET_BACKOFF_S = (0, 0)
            okg = sep.ensure_model("UVR-MDX-NET-Inst_HQ_4.onnx")
            check("ensure_model retry dibatasi maks percobaan",
                  okg is False and 2 <= tries["n"] <= 3, f"tries={tries['n']}")
        finally:
            sep._download_one = real_dl2
            sep._NET_BACKOFF_S = old_backoff
    finally:
        sep.MODEL_DIR = old_dir
        sep.MIN_MODEL_BYTES = old_min
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAIL:
        print(f"{len(FAIL)} GAGAL: " + ", ".join(FAIL))
        return 1
    print("semua ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
