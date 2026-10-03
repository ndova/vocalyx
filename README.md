# VocaLyx — Desktop Music Manager | Vocal Isolation | Karaoke & EQ

Arsitektur: **Tauri (frontend) + Python (audio engine BS-RoFormer)**. Support **mp3 + m4a**.

## Penulis

Dibuat dan dikembangkan oleh **Arif Mundhofir**.

Lisensi: [MIT](LICENSE) · Atribusi font pihak ketiga: [NOTICE](NOTICE)

## Jalankan (dev, tanpa Rust)

Butuh: Node 18+, Python 3.10/3.11, Torch CUDA (sudah ada 2.5.1+cu121 di laptop ini).

```powershell
# 1) Frontend
npm install
npm run dev
# buka http://localhost:1420

# 2) Python engine (terminal baru)
pip install -r python-engine/requirements.txt
python python-engine/server.py
# health: http://127.0.0.1:8001/health
```

Frontend Vite mem-proxy `/api/*` → `127.0.0.1:8001`, jadi tombol Vocal Off / Karaoke langsung jalan.

## Jalankan sebagai Tauri (.exe)

```powershell
winget install Rustlang.Rustup
# restart terminal, lalu:
cargo --version
npm run tauri dev
npm run tauri build
```

## Rilis untuk pengguna lain

Installer dibangun dari `npm run tauri -- build`. Ada dua varian:

| Varian | Ukuran | Isi |
| --- | --- | --- |
| **Full** | ± 665 MB | Sudah membawa runtime Python + ffmpeg + model CPU. Tinggal install, jalan offline. |
| **Lite** | ± 10 MB | Shell kecil, runtime diunduh saat pertama kali dijalankan. |

Runtime diekstrak ke `%APPDATA%\VocaLyx\runtime` (± 1,9 GB). Installer Full mengekstraknya
otomatis saat aplikasi dibuka, jadi **tidak perlu Python atau ffmpeg terpasang**.
Paket runtime untuk varian Lite di-hosting di repo `vocalyx-releases` dan bisa dibuat
dengan `python scripts/build_runtime.py --repack`.

Model CPU `UVR-MDX-NET-Inst_HQ_4.onnx` ikut terbundel. Model besar (BS-RoFormer) dan
runtime GPU CUDA bisa diunduh terpisah bila dibutuhkan.

## Prasyarat: membaca iPhone

VocaLyx hanya **mendeteksi** driver Apple, tidak pernah memasangnya otomatis karena
batasan lisensi Apple. Untuk membaca library iPhone:

1. Unduh **Apple Mobile Device Support** dari Apple (ikut bundel di iTunes for Windows).
2. Jalankan installer sebagai administrator.
3. Sambungkan iPhone dengan **kabel data USB**, buka kunci, lalu ketuk **Trust**.

Kalau driver/service belum ada, tab Device menampilkan panduan langkah di dalam aplikasi.
Deteksi dilakukan lewat service *Apple Mobile Device Service* di `127.0.0.1:27015`.

## Cara pakai

1. Klik **＋ Add Folder**, pilih folder berisi lagu (mp3/m4a/flac). Cover & Duration langsung tampil, `mdx_extra/*Artist - Judul*/no_vocals.*` terdeteksi sebagai Karaoke.
2. Klik baris lagu untuk putar. Waveform + waktu jalan otomatis.
3. EQ 10-band + Preset (Rock/Jazz/Pop) + VolumeGain real via Web Audio.
4. Lirik sinkron otomatis dari `Lyrics/<nama>.lrc` atau download LRCLIB → simpan ke `Lyrics/`.
5. **Karaoke mode / Vocal Off** → pakai file lokal `mdx_extra/*/no_vocals.flac|wav|mp3` jika ada, jika tidak generate otomatis. Hasil disimpan ke `mdx_extra/` untuk next time, cache di `%APPDATA%/VocaLyx/cache/`.

## Catatan RTX 3050 4GB

- Model `mel_band_roformer_ep_3005_sdr_11.4360.ckpt` (BS-RoFormer) dengan `segment 128, overlap 0.25, batch 1` hemat 4GB VRAM.
- Fallback ke `htdemucs` jika BS-RoFormer OOM.
- Proses lagu 3 menit ≈ 30–60 detik di GPU.
- Device name untuk Spotify Premium Connect: `VocaLyx-XXXX` (bukan Tokek).
