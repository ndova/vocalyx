<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src/public/logo-dark.png">
    <img src="src/public/logo.png" alt="VocaLyx" width="560">
  </picture>
</p>

<h3 align="center">Desktop Music Manager · Vocal Isolation · Karaoke &amp; EQ</h3>

<p align="center">
  <a href="https://github.com/ndova/vocalyx-releases/releases/latest"><img src="https://img.shields.io/badge/version-0.1.0--beta-4f6ef7?style=flat-square" alt="version 0.1.0-beta"></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/ndova/vocalyx-releases/releases"><img src="https://img.shields.io/github/downloads/ndova/vocalyx-releases/v0.1.0-beta/total?style=flat-square" alt="downloads"></a>
  <img src="https://img.shields.io/badge/Tauri-2.x-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri">
  <img src="https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python">
</p>

<p align="center">
  <b><a href="#-english">🇬🇧 English</a> · <a href="#-bahasa-indonesia">🇮🇩 Bahasa Indonesia</a></b>
</p>

---

## 🇬🇧 English

**VocaLyx** is a Windows desktop app for your whole music workflow: organize your local
collection, search and download songs, turn any track into a karaoke instrumental with
AI, shape the sound with a 10-band EQ, follow synced lyrics, and move music to and from
your iPhone. Built with **Tauri (frontend) + Python (audio engine)** by
[Arif Mundhofir](https://github.com/ndova), licensed under [MIT](LICENSE).

### Download

| Installer | Size | Notes |
| :--- | ---: | :--- |
| [**Setup.exe (NSIS)**](https://github.com/ndova/vocalyx-releases/releases/latest) | ≈700 MB | Full build — runtime bundled, install and go |
| [**MSI**](https://github.com/ndova/vocalyx-releases/releases/latest) | ≈706 MB | Same full build, Windows Installer format |

If an installation breaks, just run the installer again — the runtime is part of it.

### Features

| | |
| :--- | :--- |
| 🎤 **AI karaoke** | 3 presets for every machine — `karaoke_aufr33` (MelBand RoFormer, keeps backing), `karaoke_full` (Kim_Vocal_2 + Inst_HQ_4, removes all vocals), `cpu_inst_hq` (fast CPU). Clarity EQ + −1 dBTP limiter + loudness match; results cached per track |
| ⚡ **One-click CUDA** | Install GPU dependencies (±5.8 GB) from a Settings button — no manual Python setup |
| 📥 **Search & download** | YouTube/YT Music, SoundCloud, Archive.org, 4shared without an account; Spotify Premium via **Connect**; Deezer via saved ARL — per-source status on failure |
| 🎚️ **10-band EQ** | Preset profiles (Rock/Pop/Jazz/…), VolumeGain loudness matching, Audio Cleaner (declip + normalize) |
| 📝 **Synced lyrics** | `.lrc` display with per-line editor and time-offset control |
| 📱 **iPhone transfer** | Two-way sync with your iPhone over USB |
| 🌓 **Auto theme** | Follows the Windows light/dark mode automatically |

### Minimum requirements

| Component | Minimum | Notes |
| :--- | :--- | :--- |
| OS | Windows 10/11, 64-bit | — |
| RAM | 4 GB | 8 GB recommended for karaoke |
| Disk | ≈700 MB installer | ≈1.9 GB installed; AI models ≈120 MB on first use; CUDA adds ±5.8 GB |
| Internet | Required | Search/download, model downloads, updates |
| GPU | Optional | NVIDIA driver + ±4 GB VRAM for CUDA karaoke; CPU mode is fully functional |
| VC++ Redist | Required once | Auto-installed from the installer bundle when missing ([manual download](https://aka.ms/vs/17/release/vc_redist.x64.exe)) — the AI engine cannot start without it |
| iPhone | Optional | [Apple Mobile Device Support](https://support.apple.com/en-us/103229) (with iTunes), run as administrator, tap **Trust** — VocaLyx only detects it |

### Install

1. Download the **Setup.exe** or **MSI** from the table above.
2. Run it — the Python runtime (±670 MB) is bundled and extracts to
   `%APPDATA%\VocaLyx` on first launch; AI models download on first use.
3. Optional: enable CUDA with **Install CUDA dependencies** in the Karaoke card of
   Settings.

<details>
<summary><b>Run from source (development)</b></summary>

Requires: Node 18+, Python 3.10/3.11, Rust (for `.exe`).

```powershell
npm install
npm run dev:all        # frontend + engine together
# or: npm run dev  +  npm run engine  (two terminals)
```

Fresh clone / another build PC: `scripts/*-venv` and `build/` are gitignored.
`npm run stage:premium` automatically fetches the prebuilt `premium-<ver>.zip`
from vocalyx-releases when the venvs are absent (or recreate them via
`scripts/requirements-premium-*.txt` with Python 3.11, then `--force`).
For a full runtime from scratch: `python scripts/build_runtime.py` once
(downloads embeddable Python 3.11.9 + deps, ~1 GB).

</details>

<details>
<summary><b>Build a release</b></summary>

```powershell
npm test                                        # smoke + Python tests (must be green)
python scripts/build_runtime.py --repack        # runtime-bundle.zip + dist-runtime/
npx tauri build                                 # MSI + NSIS under src-tauri/target/release/bundle/
```

`npm run stage:engine` runs automatically inside `npx tauri build`
(`beforeBuildCommand`) — a stale stage would ship old engine code.

</details>

<details>
<summary><b>Disclaimer</b></summary>

- VocaLyx is an independent project, **not affiliated with, endorsed by, or sponsored
  by** Google/YouTube, Spotify, Deezer, SoundCloud, Archive.org, 4shared, or Apple.
  All trademarks belong to their respective owners.
- Download only content you have the right to use. You are responsible for complying
  with copyright law and each service's terms in your country.
- Spotify features require your own **Premium** account used through the Connect
  flow — VocaLyx never asks for or stores your Spotify password.
- AI results (karaoke separation, cleaning) may vary per track. The software is
  provided **"as is"**, without warranty of any kind — see [MIT](LICENSE).

</details>

<p align="center">Built by <b>Arif Mundhofir</b> · <a href="LICENSE">MIT License</a> · <a href="NOTICE">Third-party attributions</a></p>

---

## 🇮🇩 Bahasa Indonesia

**VocaLyx** adalah aplikasi desktop Windows untuk seluruh alur musik Anda: kelola koleksi
lokal, cari & unduh lagu, ubah lagu apa pun menjadi trek karaoke instrumental dengan AI,
rapikan suara lewat EQ 10-band, ikuti lirik sinkron, dan pindahkan musik ke dan dari
iPhone Anda. Dibangun dengan **Tauri (frontend) + Python (audio engine)** oleh
[Arif Mundhofir](https://github.com/ndova), berlisensi [MIT](LICENSE).

### Unduh

| Installer | Ukuran | Catatan |
| :--- | ---: | :--- |
| [**Setup.exe (NSIS)**](https://github.com/ndova/vocalyx-releases/releases/latest) | ≈700 MB | Build full — runtime terbundel, pasang langsung jalan |
| [**MSI**](https://github.com/ndova/vocalyx-releases/releases/latest) | ≈706 MB | Build full yang sama, format Windows Installer |

Jika instalasi rusak, jalankan lagi saja installernya — runtime sudah bagian darinya.

### Fitur

| | |
| :--- | :--- |
| 🎤 **Karaoke AI** | 3 preset untuk semua mesin — `karaoke_aufr33` (MelBand RoFormer, backing tetap), `karaoke_full` (Kim_Vocal_2 + Inst_HQ_4, hapus semua vokal), `cpu_inst_hq` (CPU cepat). Clarity EQ + limiter −1 dBTP + loudness match; hasil di-cache per lagu |
| ⚡ **CUDA satu klik** | Pasang dependensi GPU (±5,8 GB) lewat tombol Settings — tanpa setup Python manual |
| 📥 **Pencarian & unduh** | YouTube/YT Music, SoundCloud, Archive.org, 4shared tanpa akun; Spotify Premium via **Connect**; Deezer via ARL tersimpan — status per sumber saat gagal |
| 🎚️ **EQ 10-band** | Profil preset (Rock/Pop/Jazz/…), VolumeGain penyamakan loudness, Pembersih Audio (declip + normalisasi) |
| 📝 **Lirik sinkron** | Tampilan `.lrc` dengan editor per baris dan kontrol offset waktu |
| 📱 **Transfer iPhone** | Sinkron dua arah dengan iPhone lewat USB |
| 🌓 **Tema otomatis** | Mengikuti mode terang/gelap Windows |

### Persyaratan minimum

| Komponen | Minimum | Catatan |
| :--- | :--- | :--- |
| OS | Windows 10/11, 64-bit | — |
| RAM | 4 GB | 8 GB disarankan untuk karaoke |
| Disk | ≈700 MB installer | ≈1,9 GB terpasang; model AI ≈120 MB saat pertama dipakai; CUDA +±5,8 GB |
| Internet | Diperlukan | Pencarian/unduh, unduh model, pembaruan |
| GPU | Opsional | Driver NVIDIA + ±4 GB VRAM untuk karaoke CUDA; mode CPU berfungsi penuh |
| VC++ Redist | Sekali saja | Terpasang otomatis dari bundel installer bila belum ada ([unduh manual](https://aka.ms/vs/17/release/vc_redist.x64.exe)) — engine AI tidak bisa jalan tanpanya |
| iPhone | Opsional | [Apple Mobile Device Support](https://support.apple.com/id-id/103229) (ikut iTunes), jalankan sebagai administrator, ketuk **Trust** — VocaLyx hanya mendeteksinya |

### Instalasi

1. Unduh **Setup.exe** atau **MSI** dari tabel di atas.
2. Jalankan — runtime Python (±670 MB) sudah terbundel dan diekstrak ke
   `%APPDATA%\VocaLyx` saat pertama dibuka; model AI diunduh saat pertama dipakai.
3. Opsional: aktifkan CUDA lewat **Install CUDA dependencies** di kartu Karaoke pada
   Settings.

<details>
<summary><b>Jalankan dari source (pengembangan)</b></summary>

Butuh: Node 18+, Python 3.10/3.11, Rust (untuk `.exe`).

```powershell
npm install
npm run dev:all        # frontend + engine sekaligus
# atau: npm run dev  +  npm run engine  (dua terminal)
```

Clone baru / PC builder lain: `scripts/*-venv` dan `build/` di-gitignore.
`npm run stage:premium` otomatis mengunduh `premium-<ver>.zip` prebuilt dari
vocalyx-releases bila venv tidak ada (atau buat ulang venv lewat
`scripts/requirements-premium-*.txt` dengan Python 3.11, lalu `--force`).
Untuk runtime penuh dari nol: `python scripts/build_runtime.py` sekali saja
(mengunduh Python embeddable 3.11.9 + dependensi, ~1 GB).

</details>

<details>
<summary><b>Bangun rilis</b></summary>

```powershell
npm test                                        # smoke + test Python (wajib hijau)
python scripts/build_runtime.py --repack        # runtime-bundle.zip + dist-runtime/
npx tauri build                                 # MSI + NSIS di src-tauri/target/release/bundle/
```

`npm run stage:engine` berjalan otomatis di dalam `npx tauri build`
(`beforeBuildCommand`) — stage basi akan mengirim kode engine lama.

</details>

<details>
<summary><b>Disclaimer</b></summary>

- VocaLyx adalah proyek independen, **tidak berafiliasi, didukung, atau disponsori oleh**
  Google/YouTube, Spotify, Deezer, SoundCloud, Archive.org, 4shared, atau Apple. Semua
  merek dagang milik pemiliknya masing-masing.
- Unduh hanya konten yang berhak Anda gunakan. Anda bertanggung jawab mematuhi hukum
  hak cipta dan ketentuan tiap layanan di negara Anda.
- Fitur Spotify memerlukan akun **Premium** milik Anda sendiri lewat alur Connect —
  VocaLyx tidak pernah meminta atau menyimpan kata sandi Spotify Anda.
- Hasil AI (pemisahan vokal, pembersihan) bisa bervariasi per lagu. Perangkat lunak
  disediakan **"sebagaimana adanya"**, tanpa jaminan apa pun — lihat [MIT](LICENSE).

</details>

<p align="center">Dibuat oleh <b>Arif Mundhofir</b> · <a href="LICENSE">Lisensi MIT</a> · <a href="NOTICE">Atribusi pihak ketiga</a></p>
