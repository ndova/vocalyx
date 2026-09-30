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

pub fn start(app: &AppHandle) {
    if engine_alive() {
        log_line!("engine sudah hidup di 127.0.0.1:8001, skip spawn");
        return;
    }

    let Some(script) = find_engine_script(app) else {
        log_line!("GAGAL: python-engine/server.py tidak ditemukan");
        return;
    };
    let Some(py) = find_python() else {
        log_line!("GAGAL: interpreter python tidak ditemukan (set VOCALYX_PYTHON untuk manual)");
        return;
    };

    let cwd = project_root(&script);
    log_line!("start engine: {} -u {} (cwd {})", py, script.display(), cwd.display());

    let mut cmd = Command::new(&py);
    cmd.arg("-u")
        .arg(&script)
        .current_dir(&cwd)
        .stdin(Stdio::null());

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

/// Lokasi `server.py`: resource bundle dulu, lalu relatif ke exe.
/// `_up_` dipakai Tauri untuk resource yang keluar dari folder `target`, dan
/// `../../` kena saat dev/`cargo run` dari dalam repo.
fn find_engine_script(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("python-engine/server.py", BaseDirectory::Resource) {
        cands.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("python-engine/server.py"));
            cands.push(dir.join("_up_/python-engine/server.py"));
            cands.push(dir.join("../python-engine/server.py"));
            cands.push(dir.join("../../python-engine/server.py"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("python-engine/server.py"));
    }
    cands.into_iter().find(|p| p.is_file())
}

/// Working directory engine harus root project, bukan folder `python-engine`:
/// `vx_core.py` mencari `ffmpeg/` dan `vx_download.py` membaca
/// `.spotify-premium/device_id.txt` relatif terhadap `Path.cwd()`.
///
/// `assets` sengaja dianggap marker lemah: folder `_up_` hasil salinan resource
/// Tauri juga punya `assets`, whereas penanda project asli ada di folder yang
/// lebih atas. Makanya `'assets'` hanya dipakai sebagai fallback.
fn project_root(script: &Path) -> PathBuf {
    let engine_dir = match script.parent() {
        Some(d) => d,
        None => return PathBuf::from("."),
    };
    let base = engine_dir.parent().unwrap_or(engine_dir);
    let mut weak: Option<&Path> = None;
    for up in base.ancestors().take(8) {
        for marker in ["ffmpeg", ".spotify-premium", "package.json"] {
            if up.join(marker).exists() {
                return up.to_path_buf();
            }
        }
        if weak.is_none() && up.join("assets").exists() {
            weak = Some(up);
        }
    }
    weak.map(Path::to_path_buf).unwrap_or_else(|| base.to_path_buf())
}

fn find_python() -> Option<String> {
    if let Some(custom) = std::env::var_os("VOCALYX_PYTHON") {
        let p = PathBuf::from(custom);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }

    let mut cands: Vec<PathBuf> = Vec::new();
    for name in ["pythonw.exe", "python.exe"] {
        if let Some(p) = which(name) {
            cands.push(PathBuf::from(p));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local).join("Programs").join("Python");
        if let Ok(entries) = fs::read_dir(base) {
            let mut dirs: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            for d in dirs.into_iter().rev() {
                for exe in ["pythonw.exe", "python.exe"] {
                    let c = d.join(exe);
                    if c.is_file() {
                        cands.push(c);
                    }
                }
            }
        }
    }

    let mut best: Option<(u8, PathBuf)> = None;
    for c in cands {
        let score = python_score(&c);
        match &best {
            Some((bs, _)) if *bs >= score => {}
            _ => best = Some((score, c)),
        }
    }
    best.map(|(_, c)| c.to_string_lossy().into_owned())
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

fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|c| c.is_file())
        .map(|c| c.to_string_lossy().into_owned())
}

fn log_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("NetKara").join("engine.log"))
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
