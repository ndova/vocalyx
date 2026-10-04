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

use serde::Serialize;

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
/// Mengembalikan `Err` kalau engine tidak benar-benar bisa diganti. Ini penting:
/// kalau port 8001 masih dipegang engine milik instance VocaLyx yang lain
/// (mis. sisa dari `tauri dev` sebelumnya), `start()` akan melakukan "skip spawn"
/// sehingga engine yang hidup tetap interpreter lama. Tanpa error, UI sempat
/// menampilkan "Engine is running with a CUDA interpreter" padahal tidak.
pub fn restart(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<Engine>() {
        let child = { state.0.lock().ok().and_then(|mut g| g.take()) };
        if let Some(mut child) = child {
            log_line!("restart: stop engine (pid {})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    wait_port_free(6000);
    if port_listening() {
        let stale = stale_engine_pid();
        let extra = match stale {
            Some(pid) if !pid_alive(pid) => format!(" (tercatat pid {pid}, sudah mati)"),
            _ => String::new(),
        };
        return Err(format!(
            "Port {ENGINE_PORT} masih dipakai engine lain{extra}. Tutup instance VocaLyx yang lain, lalu coba lagi."
        ));
    }
    start(app);
    Ok(())
}

/// Baca `/health` engine sebagai JSON. Dipakai untuk verifikasi nyata setelah
/// restart, bukan mempercayai hasil probe.
fn health_json(timeout: Duration) -> Option<serde_json::Value> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, ENGINE_PORT));
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.write_all(
        format!(
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{ENGINE_PORT}\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    )
    .ok()?;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= 16 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let body = text.split_once("\r\n\r\n")?.1;
    serde_json::from_str(body.trim()).ok()
}

/// Tunggu engine sampai `/health` melaporkan cuda sama dengan yang diharapkan.
/// `Err` kalau engine tidak pernah melaporkan nilai itu dalam batas waktu.
fn wait_engine_cuda(expect_cuda: bool, max_ms: u64) -> Result<(), String> {
    let step = Duration::from_millis(500);
    let mut waited: u64 = 0;
    while waited <= max_ms {
        if let Some(j) = health_json(Duration::from_secs(3)) {
            let cuda = j.get("cuda").and_then(|v| v.as_bool()).unwrap_or(false);
            if cuda == expect_cuda {
                return Ok(());
            }
        }
        std::thread::sleep(step);
        waited += step.as_millis() as u64;
    }
    Err(format!(
        "Engine tidak melaporkan CUDA={expect_cuda} setelah restart (mungkin gagal boot atau masih pakai runtime CPU)."
    ))
}

fn stale_engine_pid() -> Option<u32> {
    let txt = fs::read_to_string(app_data_dir().join("engine.pid")).ok()?;
    txt.trim().parse::<u32>().ok()
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .stdin(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn pid_alive(_pid: u32) -> bool {
    false
}

pub fn start(app: &AppHandle) {
    if engine_alive() {
        log_line!("engine sudah hidup di 127.0.0.1:8001, skip spawn");
        return;
    }

    let Some(script) = find_engine_script(app) else {
        log_line!("GAGAL: python-engine/server.py tidak ditemukan");
        return;
    };
    let Some(py) = find_python(Some(app)) else {
        log_line!("GAGAL: interpreter python tidak ditemukan (set VOCALYX_PYTHON untuk manual)");
        return;
    };

    let cwd = project_root(&script);
    log_line!("start engine: {} -u {} (cwd {})", py, script.display(), cwd.display());

    // Catat interpreter aktif saja. Tidak ada probe CUDA di sini: `start()`
    // dipanggil dari `spawn_ensure_and_start` (spawn_blocking) maupun dari
    // `restart` (async) — tapi probe = impor torch yang berat, dan `/health`
    // sudah melaporkan cuda saat engine siap.
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
            // Catat PID engine yang kita spawn agar `restart` bisa membedakan
            // "engine milik instance lain yang masih hidup" dari "sisa engine
            // yang sudah mati" (mis. dari `tauri dev` sebelumnya).
            let _ = fs::write(app_data_dir().join("engine.pid"), pid.to_string());
            log_line!("engine berjalan (pid {})", pid);
        }
        Err(e) => log_line!("GAGAL spawn: {}", e),
    }
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
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, ENGINE_PORT));
    let mut s = match TcpStream::connect_timeout(&addr, HEALTH_TIMEOUT) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(HEALTH_TIMEOUT));
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        ENGINE_PORT
    );
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
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
    let resp = String::from_utf8_lossy(&resp);
    resp.starts_with("HTTP/1.1 200") && resp.contains("\"ok\"")
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

/// Lokasi `server.py`: resource bundle dulu, lalu relatif ke exe.
/// `_up_` dipakai Tauri untuk resource yang keluar dari folder `target`, dan
/// `../../` kena saat dev/`cargo run` dari dalam repo.
fn find_engine_script(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("python-engine/server.py", BaseDirectory::Resource) {
        cands.push(p);
    }
    // Runtime portable (Fase 2 bundler) membawa engine-nya sendiri di dalam
    // runtime/engine, karena `._pth` membuat Python mengabaikan PYTHONPATH
    // sehingga folder script tidak otomatis masuk sys.path.
    if let Some(rt) = bundled_runtime_root() {
        cands.push(rt.join("engine").join("server.py"));
        cands.push(rt.join("engine").join("scripts").join("server.py"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in ["", "_up_/", "../", "../../"] {
                let b = dir.join(base);
                cands.push(b.join("python-engine/server.py"));
                cands.push(b.join("runtime/engine/server.py"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("python-engine/server.py"));
        cands.push(cwd.join("build/runtime/engine/server.py"));
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
    use serde::Serialize;

    #[derive(Serialize, Clone)]
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

    /// Semua interpreter yang bisa dipakai, hasil probe. Tidak error kalau tidak
    /// ada yang bisa dipakai; pemanggil yang memutuskan.
    pub fn detect() -> Vec<PythonInfo> {
        let mut cands: Vec<PathBuf> = Vec::new();
        if let Ok(custom) = std::env::var("VOCALYX_PYTHON") {
            cands.push(PathBuf::from(custom));
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
                    for exe in ["python.exe", "pythonw.exe"] {
                        let p = d.join(exe);
                        if p.is_file() {
                            cands.push(p);
                        }
                    }
                }
            }
        }

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
        fresh
    }
}

/// Device yang dipilih user untuk karaoke.
#[derive(Serialize, Clone, PartialEq)]
pub struct EngineConfig {
    pub device: String,
    pub gpu_python: String,
    pub active_python: String,
    pub active_cuda: bool,
}

pub struct EngineChoice(pub Mutex<EngineConfig>);

impl EngineChoice {
    pub fn new() -> Self {
        EngineChoice(Mutex::new(EngineConfig {
            device: "auto".into(),
            gpu_python: String::new(),
            active_python: String::new(),
            active_cuda: false,
        }))
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
            }
        }
    }

    fn store(app: &AppHandle, cfg: EngineConfig) -> bool {
        if let Some(state) = app.try_state::<EngineChoice>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = cfg;
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
    let chosen = if dev == "cuda" || dev == "gpu" {
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
                    "Tidak ada Python dengan PyTorch CUDA + dependensi engine. Set di Settings > Karaoke.".into()
                });
            }
        }
    } else {
        // cpu / auto: pakai runtime bawaan kalau ada.
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
fn chosen_python(app: &AppHandle) -> Option<PathBuf> {
    let cfg = EngineChoice::snapshot(app);
    let device = cfg.as_ref().map(|c| c.device.clone()).unwrap_or_else(|| "auto".into());
    let gpu_python = cfg.as_ref().map(|c| c.gpu_python.clone()).unwrap_or_default();
    let dev = device.to_ascii_lowercase();
    // Deteksi hanya perlu kalau device benar-benar cuda/gpu. Untuk auto/cpu
    // tidak ada yang perlu di-probe, jadi jangan bakar belasan detik impor torch
    // di startup.
    let detected = if dev == "cuda" || dev == "gpu" {
        gpu::detect_cached(false)
    } else {
        Vec::new()
    };
    resolve_interpreter(&dev, &gpu_python, &detected).ok()
}

/// Urutan pilihan interpreter saat start:
/// 1. `VOCALYX_PYTHON` (escape hatch manual)
/// 2. Device tersimpan di Settings (cuda -> interpreter CUDA, cpu/auto -> bawaan)
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

#[tauri::command]
pub fn get_engine_config(app: AppHandle) -> EngineConfig {
    EngineChoice::snapshot(&app).unwrap_or_else(|| EngineConfig {
        device: "auto".into(),
        gpu_python: String::new(),
        active_python: String::new(),
        active_cuda: false,
    })
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
    let dev = device.trim().to_ascii_lowercase();
    if !matches!(dev.as_str(), "auto" | "cpu" | "cuda" | "gpu") {
        return Err("device tidak dikenal".into());
    }
    let gpu_py = gpu_python.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // Satu-satunya pass deteksi. `resolve_interpreter` memakai daftar ini,
        // jadi tidak ada probe kedua.
        let detected = gpu::detect_cached(true);
        let chosen = resolve_interpreter(&dev, &gpu_py, &detected)?;
        let chosen_s = chosen.to_string_lossy().into_owned();
        let probe_cuda = detected
            .iter()
            .find(|i| i.path.eq_ignore_ascii_case(&chosen_s))
            .map(|i| i.cuda)
            .unwrap_or(false);
        if (dev == "cuda" || dev == "gpu") && !probe_cuda {
            return Err("interpreter yang dipilih tidak punya PyTorch CUDA".into());
        }

        let want_cuda = dev == "cuda" || dev == "gpu";
        let previous = EngineChoice::snapshot(&app);
        let next = EngineConfig {
            device: dev.clone(),
            gpu_python: gpu_py,
            active_python: chosen_s.clone(),
            active_cuda: probe_cuda,
        };
        if !EngineChoice::store(&app, next.clone()) {
            return Err("state engine tidak tersedia".into());
        }
        log_line!("device engine -> {dev} (python {chosen_s})");

        // Verifikasi NYATA lewat /health. Tanpa ini, `restart` bisa gagal diam-diam
        // (port 8001 dipegang engine milik instance lain -> start() skip spawn)
        // sementara UI tetap menampilkan "Engine is running with a CUDA
        // interpreter" padahal engine-nya masih CPU.
        if let Err(e) = restart(&app).and_then(|()| wait_engine_cuda(want_cuda, 90_000)) {
            // Kembalikan state & interpreter sebelumnya supaya tidak ada
            // keadaan setengah jalan.
            if let Some(prev) = previous {
                EngineChoice::store(&app, prev);
                let _ = restart(&app);
            }
            return Err(e);
        }
        Ok(next)
    })
    .await
    .map_err(|e| format!("gagal menjalankan perintah: {e}"))?
}
