# VocaLyx — Desktop Music Manager | Karaoke & EQ

**[🇬🇧 English](#-english) · [🇮🇩 Bahasa Indonesia](#-bahasa-indonesia)**

Architecture: **Tauri (frontend) + Python (audio engine)**. Organize your local collection, search & download songs, make karaoke tracks, 10-band EQ, synced lyrics.

Built and developed by **Arif Mundhofir**.
License: [MIT](LICENSE) · Third-party attributions: [NOTICE](NOTICE)

> Rilis (installer + runtime): [ndova/vocalyx-releases](https://github.com/ndova/vocalyx-releases)

---

## 🇬🇧 English

### Features

- **Karaoke / vocal removal** — 3 presets: `karaoke_aufr33` (MelBand RoFormer Aufr33/Viperx, removes lead, keeps backing), `karaoke_full` (Kim_Vocal_2 + Inst_HQ_4, removes all vocals), `cpu_inst_hq` (fast CPU path). Post chain: guarded multi-stage clarity EQ, iterative −1 dBTP limiter, loudness-match to the original. Results are cached per track.
- **One-click CUDA** — PCs without PyTorch CUDA can install GPU dependencies (±5.8 GB, official PyPI + PyTorch sources) from a Settings button, no manual Python setup.
- **Search & download** — Spotify, Deezer, SoundCloud, Archive.org, 4shared, YouTube/YT Music, with per-source status on failure.
- **10-band EQ + presets**, VolumeGain loudness matching, Audio Cleaner (declip + normalize).
- **Synced lyrics** (.lrc) + per-line editor + time-offset control.
- **Two-way iPhone transfer** (requires Apple Mobile Device Service — detected only, see below).

### System requirements

- Windows 10/11 64-bit + internet connection.
- Disk: installer ±665 MB → runtime ±1.9 GB → +5.8 GB for CUDA → +AI models as used.
- Optional GPU: NVIDIA driver + ±4 GB VRAM for CUDA karaoke. CPU mode is fully functional without one.
- iPhone: install **Apple Mobile Device Support** (bundled with iTunes for Windows) as administrator, connect via USB, tap **Trust**. The app only detects it, never installs it (Apple licensing).

### Install (users)

Download `VocaLyx_0.1.0-beta_x64-setup.exe` (NSIS) or `.msi` from [the releases page](https://github.com/ndova/vocalyx-releases/releases/latest) and run — Python, ffmpeg, and the CPU runtime are included. The runtime self-extracts to `%APPDATA%\VocaLyx` on first launch. AI models download on first use; CUDA dependencies install from the **Install CUDA dependencies** button in the Karaoke card in Settings.

### Run from source (dev)

Requires: Node 18+, Python 3.10/3.11, Rust (for `.exe`).

```powershell
npm install
npm run dev:all        # frontend + engine together
# or: npm run dev  +  npm run engine  (two terminals)
```

### Build a release

```powershell
npm test                                   # smoke + Python tests (must be green)
npm run build                              # frontend -> dist/
python scripts/build_runtime.py --staging-only   # refresh build/engine from python-engine/
python scripts/build_runtime.py --repack         # runtime-bundle.zip + dist-runtime/
npx tauri build                            # MSI + NSIS under src-tauri/target/release/bundle/
```

> `--staging-only` is not optional: `--repack` only copies `build/engine` into the runtime, so a stale stage would ship old engine code.

| Installer variant | Size | Contents |
| --- | --- | --- |
| **Full** (built) | ± 665 MB | Python runtime + ffmpeg + CPU model. Just install. |
| **Lite** | ± 10 MB | Shell only; runtime downloads on first run. |

---

## 🇮🇩 Bahasa Indonesia

Arsitektur: **Tauri (frontend) + Python (audio engine)**. Kelola koleksi lokal, cari & unduh lagu, buat trek karaoke, EQ 10-band, lirik sinkron.

Dibuat dan dikembangkan oleh **Arif Mundhofir**.
Lisensi: [MIT](LICENSE) · Atribusi pihak ketiga: [NOTICE](NOTICE)

### Fitur

- **Karaoke / vocal removal** — 3 preset: `karaoke_aufr33` (MelBand RoFormer Aufr33/Viperx, hapus lead, backing dipertahankan), `karaoke_full` (Kim_Vocal_2 + Inst_HQ_4, hapus semua vokal), `cpu_inst_hq` (cepat untuk CPU). Post-processing: clarity EQ bertingkat ber-guard, limiter iteratif −1 dBTP, loudness-match ke lagu asli. Hasil di-cache per lagu.
- **CUDA satu klik** — PC tanpa PyTorch CUDA bisa pasang dependensi GPU (±5,8 GB, sumber resmi PyPI + PyTorch) lewat tombol di Settings, tanpa install Python manual.
- **Pencarian & unduh** — Spotify, Deezer, SoundCloud, Archive.org, 4shared, YouTube/YT Music, dengan info status per sumber bila gagal.
- **EQ 10-band + preset** (Rock/Pop/Jazz/…), VolumeGain loudness matching, Pembersih Audio (declip + normalisasi).
- **Lirik sinkron** (.lrc) + editor per baris + kontrol offset waktu.
- **Transfer iPhone dua arah** (butuh Apple Mobile Device Service — hanya dideteksi, lihat bawah).

### Persyaratan sistem

- Windows 10/11 64-bit + koneksi internet.
- Disk: installer ±665 MB → runtime ±1,9 GB → +5,8 GB bila pasang CUDA → +model AI sesuai pemakaian.
- GPU opsional: driver NVIDIA + ±4 GB VRAM untuk karaoke CUDA. Tanpa GPU, mode CPU tetap jalan penuh.
- iPhone: pasang **Apple Mobile Device Support** (ikut bundel iTunes for Windows) sebagai administrator, sambungkan via USB, ketuk **Trust**. Aplikasi hanya mendeteksi, tidak memasang otomatis (batasan lisensi Apple).

### Instalasi (pengguna)

Unduh `VocaLyx_0.1.0-beta_x64-setup.exe` (NSIS) atau `.msi` dari [halaman rilis](https://github.com/ndova/vocalyx-releases/releases/latest), jalankan, selesai — Python, ffmpeg, dan runtime CPU sudah termasuk. Runtime diekstrak otomatis ke `%APPDATA%\VocaLyx` saat pertama dibuka. Model AI diunduh otomatis saat pertama dipakai; dependensi CUDA dipasang lewat tombol **Install CUDA dependencies** di kartu Karaoke pada Settings.

### Jalankan dari source (dev)

Butuh: Node 18+, Python 3.10/3.11, Rust (untuk `.exe`).

```powershell
npm install
npm run dev:all        # frontend + engine sekaligus
# atau: npm run dev  +  npm run engine  (dua terminal)
```

### Bangun rilis

```powershell
npm test                                   # smoke + test Python (wajib hijau)
npm run build                              # frontend -> dist/
python scripts/build_runtime.py --staging-only   # segarkan build/engine dari python-engine/
python scripts/build_runtime.py --repack         # runtime-bundle.zip + dist-runtime/
npx tauri build                            # MSI + NSIS di src-tauri/target/release/bundle/
```

> `--staging-only` tidak boleh dilewati: `--repack` hanya menyalin `build/engine` ke runtime, jadi stage basi akan mengirim kode engine lama.

| Varian installer | Ukuran | Isi |
| --- | --- | --- |
| **Full** (yang dibangun) | ± 665 MB | Runtime Python + ffmpeg + model CPU. Tinggal install. |
| **Lite** | ± 10 MB | Shell saja; runtime diunduh saat pertama jalan. |
