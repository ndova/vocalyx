//! Auto-start untuk Python engine (FastAPI/BS-RoFormer di 127.0.0.1:8001).
//!
//! Semua fitur audio reliant pada engine, jadi aplikasi menyalakannya sendiri
//! saat start dan mematikannya saat exit. Kalau engine sudah hidup (mis. dari
//! `npm run engine`) kita pakai yang ada, tidak spawn dua-duanya karena port 8001
//! cuma bisa di-bind satu proses.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

const ENGINE_PORT: u16 = 8001;
const HEALTH_TIMEOUT: Duration = Duration::from_millis(900);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

macro_rules! log_line {
    ($($arg:tt)*) => { $crate::engine::write_log(format_args!($($arg)*)) };
}

pub struct Engine(pub Mutex<Option<Child>>);

impl Engine {
    pub fn new() -> Self {
        Engine(Mutex::new(None))
    }

    /// Matikan child saat aplikasi keluar supaya tidak ada python yatim
    /// yang masih memegang port 8001 setelah jendela ditutup.
    pub fn shutdown(&self) {
        let child = { self.0.lock().ok().and_then(|mut g| g.take()) };
        if let Some(mut child) = child {
            log_line!("shutdown engine (pid {})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Tunggu sampai port 8001 benar-benar bebas, supaya start baru tidak gagal
/// bind karena engine lama masih shutting down.
fn wait_port_free(max_ms: u64) {
    let step = Duration::from_millis(150);
    let mut waited: u64 = 0;
    while waited < max_ms {
        if !port_listening() {
            return;
        }
        std::thread::sleep(step);
        waited += step.as_millis() as u64;
    }
}

fn port_listening() -> bool {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, ENGINE_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// Restart engine dengan pilihan device baru. Dipakai saat user mengganti
/// Device / Python CUDA di Settings: interpreter yang hidup harus diganti,
/// karena `torch.cuda` ditentukan saat proses Python start.
///
/// Selalu dilanjutkan sampai spawn — termasuk bila port dipegang engine
/// eksternal yang sehat (mis. dari `npm run engine` / `dev:all`): ia diambil
/// alih (taskkill) lalu diganti child milik instance ini. Ini AMAN karena
/// `dev:all`/`dev:web` sengaja TANPA flag `-k` (lihat package.json): matinya
/// engine eksternal tidak merambat mematikan tauri dev, dan penggantinya
/// langsung di-spawn di bawah. JANGAN kembalikan `-k` tanpa mengubah fungsi
/// ini jadi menolak (pernah dicoba: tiap ganti device malah membunuh
/// aplikasi via concurrently).
pub fn restart(app: &AppHandle) {
    let owned = app
        .try_state::<Engine>()
        .and_then(|state| state.0.lock().ok().and_then(|mut g| g.take()));
    if let Some(mut child) = owned {
        log_line!("restart: stop engine (pid {})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
    wait_port_free(6000);
    take_over_stale_engine();
    start(app);
}

/// Engine yang memegang port 8001 tapi bukan anak instance ini akan membuat
/// `start()` melakukan "skip spawn" selamanya, sehingga pergantian device tidak
/// pernah benar-benar terjadi. Gejalanya: log `restart: stop engine (pid ...)`
/// lalu `engine sudah hidup di 127.0.0.1:8001, skip spawn` tanpa baris
/// `start engine` sama sekali.
///
/// Dua sumbernya: instance VocaLyx sebelumnya yang mati sebelum menutup engine,
/// dan spawn ganda yang hanya menyimpan child terakhir di state `Engine`.
/// Termasuk engine eksternal yang sehat (mis. dari `npm run engine`): saat
/// `restart()` ia memang harus diganti child ber-device baru, dan itu aman
/// karena concurrently berjalan tanpa `-k` (lihat dok `restart()`).
/// Karena itu port yang dijawab engine VocaLyx (`engine_alive()` sudah memastikan
/// jawabannya `/health` milik kita) aman diambil alih.
fn take_over_stale_engine() {
    if !engine_alive() {
        return;
    }
    let Some(pid) = port_owner_pid() else {
        log_line!("restart: port {ENGINE_PORT} masih hidup tapi PID pemegangnya tidak ditemukan");
        return;
    };
    log_line!("restart: ambil alih engine yatim di port {ENGINE_PORT} (pid {pid})");
    kill_pid(pid);
    wait_port_free(6000);
}

#[cfg(windows)]
fn port_owner_pid() -> Option<u32> {
    let out = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if cols[1].rsplit(':').next() != Some(ENGINE_PORT.to_string().as_str()) {
            continue;
        }
        if cols[3].eq_ignore_ascii_case("TIME_WAIT") {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            return Some(pid);
        }
    }
    None
}

#[cfg(not(windows))]
fn port_owner_pid() -> Option<u32> {
    None
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = pid;
}

/// `start()` bisa dipanggil dari `spawn_ensure_and_start` (spawn_blocking) dan
/// dari `restart` sekaligus. Tanpa lock, dua panggilan berdekatan bisa sama-sama
/// melihat port masih kosong lalu spawning dua engine; state `Engine` hanya
/// menyimpan child terakhir, jadi engine yang pertama jadi yatim yang tetap
/// memegang port 8001 dan memblokir semua pergantian device berikutnya.
static START_LOCK: Mutex<()> = Mutex::new(());

pub fn start(app: &AppHandle) {
    let _guard = match START_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if engine_alive() {
        // Engine yatim versi LAMA (bytecode basi, mis. dari instalasi sebelumnya)
        // tetap menjawab /health tapi tidak punya cap `premium_backend` - dan
        // kode lama di memori inilah yang membuat Test Login/Connect melaporkan
        // error lama walau file di disk sudah baru. Ambil alih dulu sebelum
        // memutuskan skip spawn.
        if engine_has_premium_backend() {
            log_line!("engine sudah hidup di 127.0.0.1:8001, skip spawn");
            return;
        }
        log_line!("engine di 8001 tanpa cap premium_backend (versi lama) -> diambil alih");
        take_over_stale_engine();
        if engine_alive() {
            log_line!("GAGAL: engine basi di 8001 masih hidup setelah takeover, spawn dibatalkan");
            return;
        }
    }

    let script = match find_engine_script(app) {
        Some(s) => s,
        None => {
            log_line!("GAGAL: python-engine/server.pyc tidak ditemukan");
            return;
        }
    };
    let Some(py) = find_python(Some(app)) else {
        log_line!("GAGAL: interpreter python tidak ditemukan (set VOCALYX_PYTHON untuk manual)");
        return;
    };

    // `server.pyc` mengimpor `vx_vault` (loader untuk bytecode terenkripsi)
    // pada baris pertamanya. Kalau `vx_vault.pyc` tidak ikut ter-stage di
    // sebelahnya - mis. folder engine hasil build lama - engine langsung mati
    // dengan `ModuleNotFoundError: No module named 'vx_vault'`, port 8001 tidak
    // pernah listen, lalu Connect / Verify / Test gagal fetch dan UI hanya
    // menampilkan error generik. Cek di sini supaya ENGINE.log menyebut
    // penyebabnya, bukan Diam saja selama 30 detik.
    if let Some(dir) = script.parent() {
        if !dir.join("vx_vault.pyc").is_file() {
            log_line!(
                "PERINGATAN: {} tidak punya vx_vault.pyc - engine akan gagal start \
                 (rebuild: python scripts/build_runtime.py --staging-only)",
                dir.display()
            );
        }
    }

    let cwd = project_root(&script);
    log_line!("start engine: {} -u {} (cwd {})", py, script.display(), cwd.display());

    // Catat interpreter aktif saja. Tidak ada probe CUDA di sini: `start()`
    // dipanggil dari `spawn_ensure_and_start` (spawn_blocking) maupun dari
    // `restart` (async) — tapi probe = impor torch yang berat, dan `/health`
    // sudah melaporkan cuda saat engine siap. Jadi Hematkan.
    EngineChoice::record_active(app, &py, None);

    let mut cmd = Command::new(&py);
    cmd.arg("-u")
        .arg(&script)
        .current_dir(&cwd)
        .stdin(Stdio::null());
    apply_runtime_env(&mut cmd, &py, &cwd, &script);

    match open_log() {
        Some((out, err)) => {
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            if let Ok(mut slot) = app.state::<Engine>().0.lock() {
                *slot = Some(child);
            }
            log_line!("engine berjalan (pid {})", pid);
            wait_engine_listen(30_000);
        }
        Err(e) => {
            log_line!("GAGAL spawn: {}", e);
            return;
        }
    }
}

/// Tahan lock `START_LOCK` sampai engine benar-benar listen, supaya `start()`
/// berikutnya tidak spawning engine kedua ke port yang sama.
fn wait_engine_listen(max_ms: u64) {
    let step = Duration::from_millis(300);
    let mut waited: u64 = 0;
    while waited < max_ms {
        if engine_alive() {
            return;
        }
        std::thread::sleep(step);
        waited += step.as_millis() as u64;
    }
    log_line!("start: engine belum listen setelah {} detik", max_ms / 1000);
}

/// Ping `/health` dengan HTTP mentah lewat TcpStream supaya tidak perlu
/// menambah dependency HTTP client. TCP connect saja tidak cukup — port 8001
/// bisa dipakai proses lain, sedangkan jawaban `/health` yang benar mengonfirmasi
/// bahwa itu engine kita.
///
/// Respons harus dibaca sampai habis, bukan sekali `read`: header HTTP dan body
/// JSON bisa tiba di segmen TCP terpisah, jadi satu `read` yang hanya menangkap
/// header membuat engine yang sehat terlihat mati.
fn engine_alive() -> bool {
    health_body().is_some()
}

/// Ambil respons mentah `GET /health` bila engine menjawab 200 + `"ok"`.
fn health_body() -> Option<String> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, ENGINE_PORT));
    let mut s = TcpStream::connect_timeout(&addr, HEALTH_TIMEOUT).ok()?;
    let _ = s.set_read_timeout(Some(HEALTH_TIMEOUT));
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        ENGINE_PORT
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut resp: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                resp.extend_from_slice(&chunk[..n]);
                if resp.len() >= 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let resp = String::from_utf8_lossy(&resp).into_owned();
    if resp.starts_with("HTTP/1.1 200") && resp.contains("\"ok\"") {
        Some(resp)
    } else {
        None
    }
}

/// Engine sebelum resolver backend premium tidak mengirim cap ini; cukup untuk
/// membedakan bytecode segar dari engine yatim basi di port yang sama.
fn engine_has_premium_backend() -> bool {
    health_body().map(|b| b.contains("\"premium_backend\"")).unwrap_or(false)
}

/// Environment untuk child engine.
///
/// Dua hal berbeda berlaku tergantung interpreter:
///
/// * Python embeddable dari runtime bawaan punya file `._pth`, dan begitu file
///   itu ada Python **tidak lagi memakai `sys.path[0]`** (folder script). Tanpa
///   itu, `server.py` tidak akan pernah menemukan modul `vx_*` di sebelahnya
///   dan boot gagal dengan `ModuleNotFoundError`. Jadi folder engine ikut
///   dimasukkan ke `PYTHONPATH`.
/// * Python sistem biasa memakai `site-packages` global, jadi `PYTHONPATH`
///   hanya berisi tambahan.
///
/// Model karaoke dipindah ke folder data aplikasi supaya tidak menabrak
/// instalasi milik user lain.
fn apply_runtime_env(cmd: &mut Command, py: &str, cwd: &Path, script: &Path) {
    let mut paths: Vec<String> = Vec::new();
    if let Some(dir) = script.parent() {
        paths.push(dir.to_string_lossy().to_string());
    }
    // Interpreter sistem (yang dipakai untuk CUDA) TIDAK boleh diberi
    // `site-packages` runtime lewat PYTHONPATH. PYTHONPATH didahulukan atas
    // `site-packages` milik interpreter, jadi `import torch` akan mengambil
    // torch CPU dari runtime bawaan — bukan torch CUDA milik Python user.
    // Gejalanya: engine jalan dengan Python CUDA tapi `/karaoke` tetap
    // `cuda:false`, dan tombol Karaoke diblokir. Terverifikasi:
    // tanpa PYTHONPATH torch 2.5.1+cu121 (cuda true), dengan PYTHONPATH
    // torch 2.14.1+cpu (cuda false).
    //
    // Yang tetap disetup untuk interpreter sistem cuma `VOCALYX_RUNTIME_DIR`
    // dan `ffmpeg\bin` di PATH (untuk ffmpeg & model), karena keduanya tidak
    // memengaruhi resolusi import.
    let mut runtime_dirs: Vec<PathBuf> = Vec::new();
    if let Some(rt) = bundled_runtime_dir(py) {
        runtime_dirs.push(rt);
    }
    if let Some(rt) = crate::runtime::runtime_root().canonicalize().ok() {
        if !runtime_dirs.iter().any(|d| *d == rt) {
            runtime_dirs.push(rt);
        }
    }
    for rt in &runtime_dirs {
        cmd.env("VOCALYX_RUNTIME_DIR", rt);
    }
    // `site-packages` runtime hanya relevan untuk interpreter runtime bawaan.
    // Runtime embeddable punya `._pth` yang mengabaikan PYTHONPATH, jadi ini
    // hanya SAFETY-NET untuk setup non-embeddable, bukan jalur utama.
    if let Some(rt) = bundled_runtime_dir(py) {
        let sp = rt.join("Lib").join("site-packages");
        if sp.is_dir() {
            paths.push(sp.to_string_lossy().to_string());
        }
        if let Ok(entries) = std::fs::read_dir(&rt) {
            let mut dirs: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path().to_string_lossy().to_string())
                .filter(|p| Path::new(p).join("site-packages").is_dir() || Path::new(p).join("Lib").is_dir())
                .collect();
            dirs.sort();
            paths.extend(dirs);
        }
        cmd.env("PYTHONHOME", &rt);
    }
    // Prepend ffmpeg runtime ke PATH agar memanggil `ffmpeg` polos bekerja.
    let ffmpeg_bin = runtime_dirs
        .iter()
        .map(|d| d.join("ffmpeg").join("bin"))
        .find(|d| d.join("ffmpeg.exe").is_file() || d.join("ffmpeg").is_file());
    if let Some(fb) = ffmpeg_bin {
        let existing_path = std::env::var("PATH").unwrap_or_default();
        let fb_s = fb.to_string_lossy().to_string();
        let value = if existing_path.is_empty() {
            fb_s
        } else {
            format!("{fb_s};{existing_path}")
        };
        cmd.env("PATH", value);
        cmd.env("FFMPEG_BINARY", fb.join("ffmpeg.exe"));
    }
    let joined = paths.join(";");
    if !joined.is_empty() {
        let existing = std::env::var("PYTHONPATH").unwrap_or_default();
        let value = if existing.is_empty() {
            joined
        } else {
            format!("{joined};{existing}")
        };
        cmd.env("PYTHONPATH", value);
    }
    let models = app_data_dir().join("models");
    let _ = std::fs::create_dir_all(&models);
    cmd.env("VOCALYX_MODELS_DIR", &models);
    cmd.env("VOCALYX_PROJECT_ROOT", cwd);
}

/// Folder runtime bawaan tempat interpreter `py` berada, kalau `py` memang
/// bagian dari runtime yang kita bundle (bukan Python sistem milik user).
fn bundled_runtime_dir(py: &str) -> Option<PathBuf> {
    let exe = Path::new(py);
    if exe.file_name().map(|n| n.to_string_lossy().to_string().to_ascii_lowercase())
        != Some("python.exe".into()) && exe.file_name().map(|n| n.to_string_lossy().to_string().to_ascii_lowercase())
        != Some("pythonw.exe".into())
    {
        return None;
    }
    let dir = exe.parent()?.to_path_buf();
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if name.eq_ignore_ascii_case("runtime") || name.eq_ignore_ascii_case("runtime-cpu") {
        Some(dir)
    } else {
        None
    }
}

fn app_data_dir() -> PathBuf {
    crate::runtime::app_data_dir()
}

/// Interpreter bawaan dari runtime yang dibundel, kalau ada.
fn bundled_python() -> Option<PathBuf> {
    if let Some(rt) = bundled_runtime_root() {
        for name in ["pythonw.exe", "python.exe"] {
            let p = rt.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Lokasi entry engine: resource bundle dulu, lalu relatif ke exe.
/// `_up_` dipakai Tauri untuk resource yang keluar dari folder `target`, dan
/// `../../` kena saat dev/`cargo run` dari dalam repo.
///
/// Rilis mengirim BYTECODE, bukan source: `scripts/build_runtime.py` mengompilasi
/// staging ke `.pyc` lalu membuang `.py`, jadi `server.pyc`才是 nama yangCEPAT ada
/// di resource. `server.py` tetap dicoba sebagai fallback supaya `npm run dev:all`
/// dari repo (yang memakai folder `python-engine` apa adanya) tetap jalan tanpa
/// harus menjalankan bundler dulu.
fn find_engine_script(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    // Sumber bytecode lebih dulu supaya rilis tidak pernah tertukar ke folder
    // `python-engine` milik repo ketika aplikasi dijalankan dari dalam repo.
    for name in ["server.pyc", "server.py"] {
        if let Ok(p) = app.path().resolve(
            format!("python-engine/{name}"),
            BaseDirectory::Resource,
        ) {
            cands.push(p);
        }
    }
    // Runtime portable (Fase 2 bundler) membawa engine-nya sendiri di dalam
    // runtime/engine, karena `._pth` membuat Python mengabaikan PYTHONPATH
    // sehingga folder script tidak otomatis masuk sys.path.
    if let Some(rt) = bundled_runtime_root() {
        cands.push(rt.join("engine").join("server.pyc"));
        cands.push(rt.join("engine").join("scripts").join("server.pyc"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in ["", "_up_/", "../", "../../"] {
                let b = dir.join(base);
                cands.push(b.join("python-engine/server.pyc"));
                cands.push(b.join("python-engine/server.py"));
                cands.push(b.join("runtime/engine/server.pyc"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("python-engine/server.pyc"));
        cands.push(cwd.join("python-engine/server.py"));
        cands.push(cwd.join("build/runtime/engine/server.pyc"));
    }
    cands.into_iter().find(|p| p.is_file())
}

/// Folder tempat runtime portable berada (ada python.exe), kalau terpasang.
fn bundled_runtime_root() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in ["", "_up_/", "../", "../../"] {
                let b = dir.join(base);
                cands.push(b.join("runtime"));
                cands.push(b.join("runtime-cpu"));
            }
        }
    }
    // Runtime milik aplikasi sendiri, hasil ekstraksi Installer Full / Lite.
    // Wajib sebelum kandidat `cwd`: kalau tidak, aplikasi yang dijalankan dari
    // dalam folder repo akan memakai `build/runtime` dev dan mengabaikan
    // runtime yang sudah diekstrak (persis yang dilaporkan `runtime_status`).
    cands.push(crate::runtime::runtime_root());
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("build/runtime"));
        cands.push(cwd.join("runtime"));
    }
    cands
        .into_iter()
        .find(|d| d.join("python.exe").is_file() || d.join("pythonw.exe").is_file())
}

/// Working directory engine harus root project, bukan folder `python-engine`:
/// `vx_core.py` mencari `ffmpeg/` dan `vx_download.py` membaca
/// `.spotify-premium/device_id.txt` relatif terhadap `Path.cwd()`.
///
/// Folder tempat `python-engine` berada dianggap sebagai root aplikasi dan
/// pencarian **berhenti di situ** kalau punya marker. Dulu pencarian terus naik
/// sampai 8 tingkat mencari `package.json`, dan itu pernah membuat engine
/// hasil installer ter-install berjalan dengan `cwd` = folder home user
/// (yang kebetulan punya `package.json`) alih-alih folder install.
fn project_root(script: &Path) -> PathBuf {
    let engine_dir = match script.parent() {
        Some(d) => d,
        None => return PathBuf::from("."),
    };
    let base = engine_dir.parent().unwrap_or(engine_dir);
    let has_marker = |dir: &Path| {
        ["ffmpeg", ".spotify-premium", "package.json", "runtime", "assets", "python-engine"]
            .iter()
            .any(|m| dir.join(m).exists())
    };
    if has_marker(base) {
        return base.to_path_buf();
    }
    for up in base.ancestors().take(8) {
        if has_marker(up) {
            return up.to_path_buf();
        }
    }
    base.to_path_buf()
}

/// Kandidat interpreter yang punya torch CUDA + dependensi engine lengkap.
///
/// Installer Full membawa runtime CPU-only (wheel CUDA ~4 GB tidak muat di
/// installer), jadi pada PC dengan GPU yang torch-nya sudah CUDA, user punya
/// Python sistem yang bisa dipakai. Modul ini mendeteksi interpreter itu lewat
/// probe singkat, lalu engine dijalankan dengan interpreter tersebut supaya
/// `torch.cuda.is_available()` benar-benar True.
pub mod gpu {
    use super::*;

#[derive(Serialize, Deserialize, Clone)]
    pub struct PythonInfo {
        pub path: String,
        pub version: String,
        pub torch: String,
        pub cuda: bool,
        pub cuda_build: String,
        pub device: String,
        pub has_deps: bool,
        pub bundled: bool,
    }

    /// Ringkasan hasil deteksi yang disimpan ke disk. Tujuannya satu: opsi CUDA
    /// di Settings bisa langsung tampil aktif/nonaktif sejak jendela pertama
    /// dibuka, tanpa menunggu probe torch yang memakan belasan detik.
    #[derive(Serialize, Deserialize, Clone)]
    pub struct ProbeSummary {
        pub at: u64,
        pub cuda_ready: bool,
        pub entries: Vec<PythonInfo>,
    }

    const PROBE_SUMMARY_FILE: &str = "gpu-probe.json";

    fn summary_path() -> Option<PathBuf> {
        Some(app_data_dir().join(PROBE_SUMMARY_FILE))
    }

    pub fn save_summary(entries: &[PythonInfo]) {
        let Some(p) = summary_path() else { return };
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let sum = ProbeSummary {
            at: epoch_secs(),
            cuda_ready: entries.iter().any(|i| i.cuda && i.has_deps),
            entries: entries.to_vec(),
        };
        match serde_json::to_string_pretty(&sum) {
            Ok(txt) => {
                let _ = fs::write(p, txt);
            }
            Err(e) => log_line!("gagal tulis {PROBE_SUMMARY_FILE}: {e}"),
        }
    }

    /// `max_age_secs` = 0 berarti tanpa batas umur.
    pub fn load_summary(max_age_secs: u64) -> Option<ProbeSummary> {
        let p = summary_path()?;
        let txt = fs::read_to_string(p).ok()?;
        let sum: ProbeSummary = serde_json::from_str(&txt).ok()?;
        if max_age_secs > 0 && epoch_secs().saturating_sub(sum.at) > max_age_secs {
            return None;
        }
        Some(sum)
    }

    const PROBE: &str = concat!(
        "import json,sys\n",
        "d={'version':'.'.join(map(str,sys.version_info[:3]))}\n",
        "try:\n",
        "    import torch\n",
        "    d['torch']=torch.__version__\n",
        "    d['cuda']=bool(torch.cuda.is_available())\n",
        "    d['cuda_build']=getattr(torch.version,'cuda',None) or ''\n",
        "    d['device']=torch.cuda.get_device_name(0) if d['cuda'] else ''\n",
        "except Exception as e:\n",
        "    d['torch']='';d['cuda']=False;d['cuda_build']='';d['device']='';d['terr']=str(e)\n",
        "mods=['fastapi','uvicorn','audio_separator','librosa','soundfile','pymobiledevice3','yt_dlp']\n",
        "d['has_deps']=all(__import__('importlib.util',fromlist=['u']).find_spec(m) for m in mods)\n",
        "print(json.dumps(d))\n",
    );

    fn run_probe(exe: &Path) -> Option<PythonInfo> {
        let out = Command::new(exe)
            .args(["-E", "-c", PROBE])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().rev().find(|l| l.trim_start().starts_with('{'))?;
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        Some(PythonInfo {
            path: exe.to_string_lossy().into_owned(),
            version: v["version"].as_str().unwrap_or("").into(),
            torch: v["torch"].as_str().unwrap_or("").into(),
            cuda: v["cuda"].as_bool().unwrap_or(false),
            cuda_build: v["cuda_build"].as_str().unwrap_or("").into(),
            device: v["device"].as_str().unwrap_or("").into(),
            has_deps: v["has_deps"].as_bool().unwrap_or(false),
            bundled: super::bundled_runtime_dir(&exe.to_string_lossy()).is_some(),
        })
    }

/// Kandidat interpreter yang sudah dipangkas satu per folder instalasi.
///
/// `python.exe` dan `pythonw.exe` di folder yang sama memakai `site-packages`
/// yang identik, jadi hasil probe-nya selalu sama. Setelah keduanya di-probe,
/// dropdown menampilkan Python311 dua kali dan Python314 tiga kali padahal
/// hanya ada dua instalasi. Cukup satu per folder, dengan `pythonw.exe` diutamakan
/// karena itulah yang dipakai engine (windowless, tanpa jendela konsol).
fn one_exe_per_dir(cands: Vec<PathBuf>) -> Vec<PathBuf> {
    const PREF: [&str; 3] = ["pythonw.exe", "python.exe", "python3.exe"];
    fn rank(p: &Path) -> usize {
        p.file_name()
            .and_then(|f| PREF.iter().position(|n| f.to_string_lossy().eq_ignore_ascii_case(n)))
            .unwrap_or(usize::MAX)
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for c in cands {
        let Some(dir) = c.parent().map(|d| d.to_string_lossy().to_ascii_lowercase()) else {
            out.push(c);
            continue;
        };
        match out
            .iter()
            .position(|p| p.parent().map(|d| d.to_string_lossy().to_ascii_lowercase()) == Some(dir.clone()))
        {
            Some(i) => {
                if rank(&c) < rank(&out[i]) {
                    out[i] = c;
                }
            }
            None => out.push(c),
        }
    }
    out
}

/// Semua interpreter yang bisa dipakai, hasil probe. Tidak error kalau tidak
/// ada yang bisa dipakai; pemanggil yang memutuskan.
pub fn detect() -> Vec<PythonInfo> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(custom) = std::env::var("VOCALYX_PYTHON") {
        cands.push(PathBuf::from(custom));
    }
    // Venv CUDA milik app (Opsi B): kandidat prioritas bila instalasinya
    // selesai. Dipakai otomatis saat device=cuda; sorting cuda-dulu di bawah
    // menempatkannya di depan tanpa logika khusus.
    if let Some(v) = crate::cuda_setup::cuda_venv_python() {
        cands.push(v);
    }
    if let Some(b) = super::bundled_python() {
        cands.push(b);
    }
    for name in ["pythonw.exe", "python.exe", "python3.exe"] {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                if dir.to_string_lossy().contains("WindowsApps") {
                    continue;
                }
                let p = dir.join(name);
                // Cukup yang pertama per nama: satu probe sudah memakan
                // beberapa detik karena torch diimpor.
                if p.is_file() {
                    cands.push(p);
                    break;
                }
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local).join("Programs").join("Python");
        if let Ok(entries) = std::fs::read_dir(&base) {
            let mut dirs: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            dirs.reverse();
            for d in dirs.into_iter().take(4) {
                for exe in ["pythonw.exe", "python.exe", "python3.exe"] {
                    let p = d.join(exe);
                    if p.is_file() {
                        cands.push(p);
                        break;
                    }
                }
            }
        }
    }

    let cands = one_exe_per_dir(cands);
    let mut out: Vec<PythonInfo> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for c in cands {
        let key = c.to_string_lossy().to_ascii_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        if let Some(info) = run_probe(&c) {
            out.push(info);
        }
    }
        // CUDA lebih dulu, lalu yang punya dependensi lengkap.
        out.sort_by(|a, b| {
            b.cuda.cmp(&a.cuda)
                .then(b.has_deps.cmp(&a.has_deps))
                .then(a.path.cmp(&b.path))
        });
        out
    }

    /// Cache hasil probe supaya tidak meng-import torch berulang kali.
    ///
    /// Setiap probe menjalankan `python -c "import torch..."` yang memakan
    /// belasan detik. Tanpa cache, satu pergantian device memicu beberapa
    /// pass penuh (pilih interpreter, cek active_cuda, catat saat start) dan
    /// itu yang membuat UI membeku. TTL 60 detik cukup karena interpreter
    /// tidak berubah sendiri di tengah sesi.
    static CACHE: Mutex<Option<(std::time::Instant, Vec<PythonInfo>)>> = Mutex::new(None);
    const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

    /// Deteksi dengan cache. `force` dipakai tombol "Deteksi" di Settings.
    pub fn detect_cached(force: bool) -> Vec<PythonInfo> {
        if !force {
            if let Ok(guard) = CACHE.lock() {
                if let Some((at, list)) = guard.as_ref() {
                    if at.elapsed() < CACHE_TTL {
                        return list.clone();
                    }
                }
            }
        }
        let fresh = detect();
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((std::time::Instant::now(), fresh.clone()));
        }
        save_summary(&fresh);
        fresh
    }
}

/// Waktu unix dalam detik, untuk tanda umur cache.
fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Device yang dipilih user untuk karaoke.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct EngineConfig {
    pub device: String,
    pub gpu_python: String,
    pub active_python: String,
    pub active_cuda: bool,
}

pub struct EngineChoice(pub Mutex<EngineConfig>);

/// Device yang dipilih user harus bertahan lintas restart app. Dulu state ini
/// hanya in-memory: setiap app baru kembali ke `auto` (engine CPU), sedangkan
/// dropdown di frontend tetap menampilkan CUDA dari localStorage. Akibatnya user
/// tidak bisa memicu perbaikan dari UI — CUDA sudah terpilih di dropdown, jadi
/// mengkliknya tidak memunculkan event `change`.
fn engine_config_path() -> Option<PathBuf> {
    Some(app_data_dir().join("engine.json"))
}

fn default_config() -> EngineConfig {
    EngineConfig {
        device: "cpu".into(),
        gpu_python: String::new(),
        active_python: String::new(),
        active_cuda: false,
    }
}

/// Nilai device hanya `cpu` dan `cuda`. Versi lama sempat punya `auto` (yang
/// faktanya sudah sama dengan CPU) dan `gpu` (tidak pernah bisa dipilih dari UI
/// dan tidak punya cabang di Python), jadi keduanya dipetakan ke nilai yang
/// sekarang supaya config lama tidak menggantung.
fn normalize_device(dev: &str) -> String {
    match dev.trim().to_ascii_lowercase().as_str() {
        "cuda" | "gpu" => "cuda".to_string(),
        _ => "cpu".to_string(),
    }
}

fn load_config() -> EngineConfig {
    let Some(p) = engine_config_path() else {
        return default_config();
    };
    let Ok(txt) = fs::read_to_string(p) else {
        return default_config();
    };
    match serde_json::from_str::<EngineConfig>(&txt) {
        Ok(mut cfg) => {
            let norm = normalize_device(&cfg.device);
            if norm != cfg.device {
                log_line!("device {:?} dinormalkan menjadi {norm}", cfg.device);
                cfg.device = norm.clone();
                save_config(&cfg);
            }
            log_line!("muat pilihan engine: device={} python={}", cfg.device, cfg.active_python);
            cfg
        }
        Err(e) => {
            log_line!("gagal baca engine.json: {e}");
            default_config()
        }
    }
}

fn save_config(cfg: &EngineConfig) {
    let Some(p) = engine_config_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(cfg) {
        Ok(txt) => {
            let _ = fs::write(p, txt);
        }
        Err(e) => log_line!("gagal tulis engine.json: {e}"),
    }
}

impl EngineChoice {
    pub fn new() -> Self {
        EngineChoice(Mutex::new(load_config()))
    }

    fn snapshot(app: &AppHandle) -> Option<EngineConfig> {
        let state = app.try_state::<EngineChoice>()?;
        let guard = state.0.lock().ok()?;
        Some(guard.clone())
    }

    fn record_active(app: &AppHandle, python: &str, cuda: Option<bool>) {
        if let Some(state) = app.try_state::<EngineChoice>() {
            if let Ok(mut guard) = state.0.lock() {
                guard.active_python = python.to_string();
                if let Some(c) = cuda {
                    guard.active_cuda = c;
                }
                let cfg = guard.clone();
                drop(guard);
                save_config(&cfg);
            }
        }
    }

    fn store(app: &AppHandle, cfg: EngineConfig) -> bool {
        if let Some(state) = app.try_state::<EngineChoice>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = cfg;
                let cfg = guard.clone();
                drop(guard);
                save_config(&cfg);
                return true;
            }
        }
        false
    }
}

/// Interpreter untuk device tertentu. `cuda`/`gpu` wajib punya torch CUDA +
/// dependensi engine; kalau tidak -> Err supaya UI bisa memberi tahu, bukan
/// diam-diam jatuh ke CPU.
///
/// `detected` dipakai untuk device cuda supaya deteksi cukup dijalankan sekali
/// oleh pemanggil, bukan di sini juga.
fn resolve_interpreter(
    device: &str,
    gpu_python: &str,
    detected: &[gpu::PythonInfo],
) -> Result<PathBuf, String> {
    let dev = device.to_ascii_lowercase();
    let chosen = if dev == "cuda" {
        let usable = |i: &&gpu::PythonInfo| i.cuda && i.has_deps;
        // Kalau user memilih path spesifik, pakai itu (kalau memang CUDA+lengkap).
        let pick = if !gpu_python.trim().is_empty() {
            detected
                .iter()
                .find(|i| i.path.eq_ignore_ascii_case(gpu_python.trim()))
                .filter(usable)
                .cloned()
        } else {
            detected.iter().find(usable).cloned()
        };
        match pick {
            Some(i) => PathBuf::from(i.path),
            None => {
                let any_cuda = detected.iter().any(|i| i.cuda);
                return Err(if any_cuda {
                    "Python CUDA terdeteksi tapi dependensi engine belum lengkap di sana".into()
                } else {
                    "Tidak ada Python dengan PyTorch CUDA + dependensi engine di PC ini".into()
                });
            }
        }
    } else {
        // cpu: runtime bawaan (PyTorch CPU) selalu bisa dipakai.
        bundled_python()
            .or_else(|| system_python())
            .ok_or_else(|| "interpreter python tidak ditemukan".to_string())?
    };
    Ok(chosen)
}

fn system_python() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    for name in ["pythonw.exe", "python.exe"] {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                let p = dir.join(name);
                if p.is_file() {
                    cands.push(p);
                }
            }
        }
    }
    let mut best: Option<(u8, PathBuf)> = None;
    for c in cands {
        let s = python_score(&c);
        if best.as_ref().map(|(bs, _)| *bs < s).unwrap_or(true) {
            best = Some((s, c));
        }
    }
    best.map(|(_, c)| c)
}

/// Pilih interpreter berdasarkan device yang tersimpan (state global).
/// Device cuda berarti user memang minta GPU, jadi runtime bawaan (PyTorch CPU)
/// tidak boleh dipakai di sini.
fn chosen_python(app: &AppHandle) -> Option<PathBuf> {
    let cfg = EngineChoice::snapshot(app);
    let device = cfg.as_ref().map(|c| c.device.clone()).unwrap_or_else(|| "auto".into());
    let gpu_python = cfg.as_ref().map(|c| c.gpu_python.clone()).unwrap_or_default();
    let dev = device.to_ascii_lowercase();

    // Fast path: interpreter CUDA sudah pernah dipakai dan file-nya masih ada.
    // Pakai langsung tanpa probe torch supaya app yang dibuka ulang dengan
    // device cuda tidak menunggu probe ulang sebelum engine start.
    if dev == "cuda" {
        if let Some(c) = cfg.as_ref() {
            let p = PathBuf::from(&c.active_python);
            if !c.active_python.is_empty() && p.is_file() {
                log_line!("pakai interpreter tersimpan: {}", p.display());
                return Some(p);
            }
        }
    }

    // Deteksi hanya perlu kalau device cuda. Untuk cpu tidak ada yang perlu
    // di-probe, jadi jangan bakar belasan detik impor torch di startup.
    let detected = if dev == "cuda" {
        gpu::detect_cached(false)
    } else {
        Vec::new()
    };
    resolve_interpreter(&dev, &gpu_python, &detected).ok()
}

/// Urutan pilihan interpreter saat start:
/// 1. `VOCALYX_PYTHON` (escape hatch manual)
/// 2. Device tersimpan di Settings (cuda -> interpreter CUDA, cpu -> bawaan)
/// 3. Runtime bawaan installer
/// 4. Runtime hasil ekstraksi `%APPDATA%\VocaLyx\runtime`
/// 5. Python sistem, di skor kelengkapan dependensinya
fn find_python(app: Option<&AppHandle>) -> Option<String> {
    if let Some(custom) = std::env::var_os("VOCALYX_PYTHON") {
        let p = PathBuf::from(custom);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    if let Some(app) = app {
        if let Some(p) = chosen_python(app) {
            log_line!("pakai interpreter untuk device: {}", p.display());
            return Some(p.to_string_lossy().into_owned());
        }
        // Device tersimpan `cuda` tapi tidak ada interpreter CUDA yang bisa
        // dipakai (Python di-uninstall/upgrade, driver hilang, dll). Kalau tidak
        // dikoreksi, app tersangkut: dropdown bilang CUDA, engine jalan CPU,
        // dan status merah permanen. Turunkan ke cpu supaya konsisten.
        let wants_cuda = EngineChoice::snapshot(app)
            .map(|c| normalize_device(&c.device) == "cuda")
            .unwrap_or(false);
        if wants_cuda {
            log_line!("device cuda tersimpan tapi interpreter CUDA tidak ada, dikembalikan ke cpu");
            let mut healed = EngineChoice::snapshot(app).unwrap_or_else(default_config);
            healed.device = "cpu".into();
            healed.active_cuda = false;
            EngineChoice::store(app, healed);
        }
    }
    if let Some(bundled) = bundled_python() {
        log_line!("pakai runtime bawaan: {}", bundled.display());
        return Some(bundled.to_string_lossy().into_owned());
    }
    system_python().map(|p| {
        log_line!("pakai python sistem: {}", p.display());
        p.to_string_lossy().into_owned()
    })
}

/// Laptop bisa punya beberapa Python (mis. 3.11 yang sudah ada torch + 3.14
/// yang masih kosong), jadi "versi terbaru" bukan kriteria yang benar — yang
/// dicek justru kelengkapan dependensi engine.
fn python_score(exe: &Path) -> u8 {
    let Some(prefix) = exe.parent() else { return 0 };
    let sp = prefix.join("Lib").join("site-packages");
    let mut score = 0u8;
    if sp.join("torch").is_dir() {
        score += 4;
    }
    if sp.join("fastapi").is_dir() {
        score += 2;
    }
    score
}

fn log_path() -> Option<PathBuf> {
    Some(app_data_dir().join("engine.log"))
}

fn open_log() -> Option<(File, File)> {
    let p = log_path()?;
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let out = OpenOptions::new().create(true).append(true).open(&p).ok()?;
    let err = OpenOptions::new().create(true).append(true).open(&p).ok()?;
    Some((out, err))
}

pub fn write_log_note(msg: &str) {
    log_line!("{}", msg);
}

pub fn write_log(args: std::fmt::Arguments<'_>) {
    let Some(p) = log_path() else { return };
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", secs, args);
    }
}

// ---------------------------------------------------------------------------
// Perintah Tauri: deteksi Python CUDA + pergantian device engine
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn restart_engine(app: AppHandle) -> Result<bool, String> {
    // Restart ringan tanpa mengubah device: dipakai tombol "Coba lagi" saat
    // engine offline. Async + spawn_blocking supaya tidak membekukan UI
    // (restart menunggu port bebas + engine listen).
    tauri::async_runtime::spawn_blocking(move || {
        log_line!("restart engine manual dari UI");
        restart(&app);
        Ok(true)
    })
    .await
    .map_err(|e| format!("gagal menjalankan perintah: {e}"))?
}

#[tauri::command]
pub fn detect_pythons() -> Vec<gpu::PythonInfo> {
    gpu::detect_cached(false)
}

/// Versi async supaya probe (yang meng-import torch, beberapa detik per
/// interpreter) tidak membekukan UI. `force=true` untuk tombol "Deteksi"
/// (cache dilewati); `false` memakai cache TTL.
#[tauri::command]
pub async fn detect_pythons_async(force: Option<bool>) -> Vec<gpu::PythonInfo> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || gpu::detect_cached(force))
        .await
        .unwrap_or_default()
}

/// Ringkasan deteksi CUDA terakhir yang tersimpan di disk. Dipakai frontend
/// agar opsi CUDA di Settings bisa langsung tampil aktif/nonaktif sejak jendela
/// pertama dibuka — memanggil `detect_pythons_async` akan membekukan UI karena
/// tiap probe meng-import torch. `max_age_secs` = 0 berarti tanpa batas umur.
#[tauri::command]
pub fn gpu_probe_cached(max_age_secs: Option<u64>) -> Option<gpu::ProbeSummary> {
    gpu::load_summary(max_age_secs.unwrap_or(86_400))
}

#[tauri::command]
pub fn get_engine_config(app: AppHandle) -> EngineConfig {
    EngineChoice::snapshot(&app).unwrap_or_else(default_config)
}

/// Token auth engine, dibaca dari lokasi yang SAMA dengan yang ditulis engine.
///
/// Dulu frontend membacanya sendiri lewat `appDataDir()` dari `@tauri-apps/api`,
/// yang memakai `identifier` (`com.vocalyx.app`), sementara engine menulis ke
/// `%APPDATA%\VocaLyx\engine-token` (lihat `runtime::app_data_dir`). Dua path
/// berbeda, `readTextFile` gagal, `catch` di `engine-auth.js` menelan error jadi
/// `null`, header `X-VX-Token` tidak pernah terkirim, dan semua endpoint selain
/// `/health` + `/peaks` membalas 401.
///
/// Rust sudah tahu path-nya sendiri, jadi frontend tidak perlu menebak dan
/// `fs:scope` tidak perlu dilebarkan hanya demi satu file ini.
#[tauri::command]
pub fn engine_token() -> Option<String> {
    let p = crate::runtime::app_data_dir().join("engine-token");
    let raw = fs::read_to_string(p).ok()?;
    let t = raw.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Ganti device / Python CUDA lalu restart engine.
///
/// Sengaja `async`: perintah Tauri yang sinkron dieksekusi di main thread, dan
/// main thread itu juga yang menggambar jendela. Dulu perintah ini sinkron
/// sekaligus memanggil `gpu::detect()` dua kali (tiap probe meng-import torch,
/// belasan detik) lalu menunggu port 8001 sampai 6 detik — semuanya memblokir
/// UI sehingga jendela "Not responding". Sekarang semua kerja berat dipindah ke
/// `spawn_blocking`, jadi hanya awaited, tidak memblokir.
///
/// Kalau `cuda` dipilih tapi interpreter yang diminta tidak punya CUDA +
/// dependensi lengkap, command ini mengembalikan Err **sebelum** menyimpan
/// state dan sebelum menyentuh proses yang sedang jalan. Jadi user tetap di
/// device sebelumnya; tidak ada keadaan setengah jalan.
#[tauri::command]
pub async fn set_engine_config(
    app: AppHandle,
    device: String,
    gpu_python: String,
) -> Result<EngineConfig, String> {
    let dev = normalize_device(&device);
    let gpu_py = gpu_python.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // Pakai cache (TTL 60 detik), bukan deteksi paksa: probe meng-import
        // torch di tiap interpreter sehingga satu pergantian device bisa memakan
        // 30-90 detik, dan klik berikutnya ikut menumpuk di antrean. Tombol
        // "Deteksi" tetap memakai force=true bila memang perlu data segar.
        let detected = gpu::detect_cached(false);
        let chosen = resolve_interpreter(&dev, &gpu_py, &detected)?;
        let chosen_s = chosen.to_string_lossy().into_owned();
        let active_cuda = detected
            .iter()
            .find(|i| i.path.eq_ignore_ascii_case(&chosen_s))
            .map(|i| i.cuda)
            .unwrap_or(false);
        if dev == "cuda" && !active_cuda {
            return Err("interpreter yang dipilih tidak punya PyTorch CUDA".into());
        }

        let next = EngineConfig {
            device: dev.clone(),
            gpu_python: gpu_py,
            active_python: chosen_s.clone(),
            active_cuda,
        };
        if !EngineChoice::store(&app, next.clone()) {
            return Err("state engine tidak tersedia".into());
        }
        log_line!("device engine -> {dev} (python {chosen_s})");
        restart(&app);
        Ok(next)
    })
    .await
    .map_err(|e| format!("gagal menjalankan perintah: {e}"))?
}
