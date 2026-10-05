//! Penyiapan dependensi CUDA satu klik (Opsi B).
//!
//! PC tanpa PyTorch CUDA tidak bisa karaoke GPU. Alih-alih meminta user
//! menginstal Python + pip manual, modul ini membuat venv khusus milik app di
//! `%APPDATA%\VocaLyx\py-cuda` dari Python embeddable bawaan installer, lalu
//! `pip install` torch CUDA (index resmi PyTorch cu121) + `requirements.txt`
//! ke dalamnya — semua otomatis setelah satu klik, dari sumber resmi saja.
//!
//! Desain mengikuti pola `runtime.rs`: marker `.ready`/`.failed`, progres via
//! event (`cuda-setup://progress`), worker di thread blocking, dan kegagalan
//! kapan pun membuat status kembali aman (CPU tetap jalan, instalasi setengah
//! tidak dipakai). Venv TIDAK menyentuh Python milik user maupun PATH sistem.
//!
//! Alur: `cuda_setup_status` -> `cuda_setup_precheck` (driver/VRAM/disk/net)
//! -> `cuda_setup_start` -> event progres -> `cuda_setup_status` sampai
//! `state == "ready"`. Setelah ready, `engine::detect()` menemukan interpreter
//! venv sebagai kandidat CUDA prioritas dan user tinggal pilih device CUDA.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const PROGRESS_EVENT: &str = "cuda-setup://progress";

const VENV_DIRNAME: &str = "py-cuda";
const READY_MARKER: &str = ".ready";
const FAILED_MARKER: &str = ".failed";
const SETUP_LOG: &str = "cuda-setup.log";

/// Estimasi total unduhan (torch CUDA ±2.5 GB + deps ±1.5 GB). Dipakai sebagai
/// penyebut progres saat ukuran pasti belum diketahui; dikoreksi naik bila
/// ukuran direktori melampauinya supaya persen tidak macet di 100%.
const EST_TOTAL_BYTES: u64 = 4_500_000_000;
/// Ruang disk bebas minimum untuk mulai (byte).
const MIN_FREE_BYTES: u64 = 6_000_000_000;
/// VRAM minimum yang disarankan (MB). Di bawah ini hanya peringatan, bukan
/// penolakan — model kecil masih bisa jalan.
const WARN_VRAM_MB: u64 = 4096;

const TORCH_INDEX: &str = "https://download.pytorch.org/whl/cu121";
const TORCH_PIN: &str = "torch==2.5.1+cu121";
const GET_PIP_URL: &str = "https://bootstrap.pypa.io/get-pip.py";
const CONNECT_CHECK_URL: &str = "https://download.pytorch.org/whl/cu121/";

static INSTALLING: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);
static CHILD: Mutex<Option<u32>> = Mutex::new(None);

fn venv_root() -> PathBuf {
    crate::runtime::app_data_dir().join(VENV_DIRNAME)
}

fn venv_python() -> PathBuf {
    let scripts = venv_root().join("Scripts");
    for name in ["pythonw.exe", "python.exe"] {
        let p = scripts.join(name);
        if p.is_file() {
            return p;
        }
    }
    scripts.join("python.exe")
}

/// Interpreter venv untuk kandidat probe CUDA. Hanya Some bila instalasi
/// selesai (marker ready) — instalasi setengah tidak boleh ikut di-probe
/// (torch belum ada, probe hanya membuang waktu).
pub fn cuda_venv_python() -> Option<PathBuf> {
    let root = venv_root();
    if !root.join(READY_MARKER).is_file() {
        return None;
    }
    let p = venv_python();
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

fn mark_ready(root: &Path) {
    let _ = fs::write(root.join(READY_MARKER), b"v1\n");
    let _ = fs::remove_file(root.join(FAILED_MARKER));
}

fn mark_failed(root: &Path) {
    if root.is_dir() {
        let _ = fs::write(root.join(FAILED_MARKER), b"v1\n");
    }
}

fn setup_log(msg: &str) {
    let line = format!("[{}] {msg}\n", chrono_now());
    let p = crate::runtime::app_data_dir().join(SETUP_LOG);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(line.as_bytes());
    }
    crate::engine::write_log_note(&format!("cuda-setup: {msg}"));
}

fn chrono_now() -> String {
    // Cap waktu sederhana tanpa dependensi chrono: detik epoch.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

#[derive(Serialize, Clone)]
pub struct CudaSetupStatus {
    pub state: String,
    pub detail: String,
    pub received: u64,
    pub total: u64,
    pub percent: f64,
    pub stage: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
pub struct CudaPrecheck {
    pub ok: bool,
    pub nvidia: bool,
    pub gpu_name: String,
    pub vram_mb: u64,
    pub compute_cap: String,
    pub driver: String,
    pub disk_free_gb: f64,
    pub internet: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub advice: Vec<String>,
}

/// Minimum untuk torch cu121: compute capability sm_50 (Maxwell I) dan
/// driver R535+ (versi >= 537). Di bawah ini CUDA tidak akan init walau
/// 5,8 GB sudah diunduh — jadi ditolak di precheck, bukan setelah unduhan.
const MIN_CC_MAJOR: u32 = 5;
const MIN_CC_MINOR: u32 = 0;
const MIN_DRIVER_MAJOR: u32 = 537;

/// Parse "8.6" -> (8, 6). Murni, diunit-test.
fn parse_cc(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.trim().split_once('.')?;
    Some((a.trim().parse().ok()?, b.trim().split_whitespace().next()?.parse().ok()?))
}

fn parse_driver_major(s: &str) -> Option<u32> {
    s.trim().split(['.', ' ']).next()?.parse().ok()
}

/// Nasihat otomatis berdasar VRAM (MB). Dipakai UI + engine Python
/// (overlap otomatis). Bukan gate keras kecuali noted.
fn vram_advice(vram_mb: u64) -> Vec<String> {
    if vram_mb == 0 {
        return vec!["VRAM tidak terbaca; pengaturan kualitas otomatis dinonaktifkan.".to_string()];
    }
    if vram_mb < 3500 {
        return vec![
            "VRAM di bawah 3,5 GB: karaoke GPU dibatasi model ringan (preset CPU disarankan; aufr33 berisiko OOM).".to_string(),
        ];
    }
    if vram_mb < 6144 {
        return vec![
            "VRAM 4 GB: overlap otomatis 4, single model; hindari ensemble berat + dereverb.".to_string(),
        ];
    }
    vec!["VRAM >= 6 GB: overlap 8 dan ensemble model diizinkan.".to_string()]
}

#[derive(Serialize, Clone)]
struct Progress {
    received: u64,
    total: u64,
    percent: f64,
    stage: String,
}

fn emit_progress(app: &AppHandle, stage: &str, received: u64, total: u64) {
    let total = total.max(EST_TOTAL_BYTES / 4);
    let percent = (received as f64 * 100.0 / total as f64).clamp(0.0, 100.0);
    let _ = app.emit(
        PROGRESS_EVENT,
        Progress { received, total, percent, stage: stage.to_string() },
    );
}

// ---------------------------------------------------------------------------
// precheck tanpa dependensi baru (FFI langsung ke kernel32)
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetDiskFreeSpaceExW(
        dir: *const u16,
        free_to_caller: *mut u64,
        total: *mut u64,
        free_total: *mut u64,
    ) -> i32;
}

fn disk_free_bytes(dir: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        let wide: Vec<u16> = dir.to_string_lossy().encode_utf16().chain([0]).collect();
        let mut free: u64 = 0;
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok != 0 {
            return Some(free);
        }
        None
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        None
    }
}

struct GpuInfo {
    present: bool,
    name: String,
    vram_mb: u64,
    cc: String,
    driver: String,
}

fn nvidia_info() -> GpuInfo {
    // nvidia-smi ada di System32 bila driver NVIDIA terpasang.
    let out = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total,compute_cap,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let txt = String::from_utf8_lossy(&o.stdout);
            let line = txt.lines().next().unwrap_or("").trim();
            let mut parts = line.split(',');
            let name = parts.next().unwrap_or("").trim().to_string();
            let vram = parts
                .next()
                .unwrap_or("")
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("0")
                .parse::<u64>()
                .unwrap_or(0);
            let cc = parts.next().unwrap_or("").trim().to_string();
            let driver = parts.next().unwrap_or("").trim().to_string();
            GpuInfo { present: !name.is_empty(), name, vram_mb: vram, cc, driver }
        }
        _ => GpuInfo { present: false, name: String::new(), vram_mb: 0, cc: String::new(), driver: String::new() },
    }
}

fn internet_ok() -> bool {
    // Cek ringan: curl bawaan Windows 10+ HEAD ke index PyTorch.
    Command::new("curl.exe")
        .args(["-sSI", "--max-time", "15", CONNECT_CHECK_URL])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run_precheck() -> CudaPrecheck {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut advice = Vec::new();
    let gpu = nvidia_info();
    let nvidia = gpu.present;
    let gpu_name = gpu.name.clone();
    let vram_mb = gpu.vram_mb;
    if !nvidia {
        errors.push("Driver NVIDIA / nvidia-smi tidak ditemukan. Pasang driver GPU dulu.".to_string());
    } else {
        // Gerbang compute capability: cu121 butuh sm_50+. Di bawah ini torch
        // CUDA tidak akan init — tolak sebelum unduhan 5,8 GB, bukan sesudah.
        match parse_cc(&gpu.cc) {
            Some((maj, min)) if maj > MIN_CC_MAJOR || (maj == MIN_CC_MAJOR && min >= MIN_CC_MINOR) => {}
            Some((maj, min)) => {
                errors.push(format!(
                    "GPU {} compute capability {}.{} di bawah minimum sm_{}_{} untuk PyTorch CUDA 12.1; karaoke GPU tidak didukung di GPU ini.",
                    gpu_name, maj, min, MIN_CC_MAJOR, MIN_CC_MINOR
                ));
            }
            None => {
                warnings.push("Compute capability GPU tidak terbaca; lanjutkan, verifikasi akhir yang menentukan.".to_string());
            }
        }
        match parse_driver_major(&gpu.driver) {
            Some(_v) if _v >= MIN_DRIVER_MAJOR => {}
            Some(_old) => {
                errors.push(format!(
                    "Driver NVIDIA {} terlalu lama untuk CUDA 12.1 (butuh >= R{}); perbarui driver dulu.",
                    gpu.driver, MIN_DRIVER_MAJOR
                ));
            }
            None => {
                warnings.push("Versi driver tidak terbaca; pastikan >= R537.".to_string());
            }
        }
        if vram_mb > 0 && vram_mb < WARN_VRAM_MB {
            warnings.push(format!("VRAM {vram_mb} MB di bawah anjuran 4 GB; model besar bisa kehabisan memori."));
        }
        advice = vram_advice(vram_mb);
        for a in &advice {
            setup_log(&format!("nasihat: {a}"));
        }
    }
    let root = venv_root();
    let anchor = root.parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir);
    let _ = fs::create_dir_all(&anchor);
    let disk_free = disk_free_bytes(&anchor).unwrap_or(0);
    if disk_free < MIN_FREE_BYTES {
        errors.push(format!(
            "Ruang disk bebas {:.1} GB, butuh >= {:.0} GB.",
            disk_free as f64 / 1e9,
            MIN_FREE_BYTES as f64 / 1e9
        ));
    }
    let internet = internet_ok();
    if !internet {
        errors.push("Tidak bisa menjangkau index PyTorch. Periksa koneksi internet.".to_string());
    }
    CudaPrecheck {
        ok: errors.is_empty(),
        nvidia,
        gpu_name,
        vram_mb,
        compute_cap: gpu.cc.clone(),
        driver: gpu.driver.clone(),
        disk_free_gb: disk_free as f64 / 1e9,
        internet,
        errors,
        warnings,
        advice,
    }
}

// ---------------------------------------------------------------------------
// worker instalasi
// ---------------------------------------------------------------------------

fn dir_size(root: &Path) -> u64 {
    fn walk(p: &Path, acc: &mut u64) {
        let entries = match fs::read_dir(p) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_symlink() {
                continue;
            }
            match e.metadata() {
                Ok(m) if m.is_dir() => walk(&path, acc),
                Ok(m) => *acc += m.len(),
                Err(_) => {}
            }
        }
    }
    let mut total = 0u64;
    walk(root, &mut total);
    total
}

fn store_child(id: Option<u32>) {
    if let Ok(mut g) = CHILD.lock() {
        *g = id;
    }
}

fn kill_child() {
    let id = CHILD.lock().ok().and_then(|g| *g);
    if let Some(pid) = id {
        // Taskkill by pid: pola yang sama dipakai engine untuk cancel job.
        let _ = Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
}

struct Runner<'a> {
    app: &'a AppHandle,
}

impl<'a> Runner<'a> {
    /// Jalankan perintah, stream stderr ke log + pantau ukuran venv untuk
    /// progres. Kembalikan Err bila dibatalkan atau exit != 0.
    ///
    /// Heartbeat TANPA SYARAT tiap 2 dtk: emit tidak menunggu ada baris
    /// stderr baru. Tanpa ini, stall jaringan (pip diam) atau perintah sunyi
    /// (verify `import torch` ±15 dtk) membuat frontend mengira instalasi
    /// macet dan progress bar hilang-muncul — bug yang dilaporkan user.
    fn run(&self, exe: &Path, args: &[&str], stage: &str, workdir: Option<&Path>) -> Result<(), String> {
        use std::sync::{Arc, Mutex as StdMutex};
        if CANCELLED.load(Ordering::Relaxed) {
            return Err("dibatalkan".to_string());
        }
        let mut cmd = Command::new(exe);
        cmd.args(args).stderr(Stdio::piped()).stdout(Stdio::null());
        if let Some(d) = workdir {
            cmd.current_dir(d);
        }
        // Jangan warisi PYTHONPATH/HOME aneh dari proses induk. Paksa UTF-8:
        // pip menulis emoji progres yang crash di console cp1252 Windows
        // (terverifikasi) bila output-nya dibaca via pipe.
        cmd.env_remove("PYTHONPATH");
        cmd.env_remove("PYTHONHOME");
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        let mut child: Child = cmd.spawn().map_err(|e| format!("gagal jalankan {}: {e}", exe.display()))?;
        store_child(Some(child.id()));
        // Drain stderr di thread sendiri supaya loop utama bebas mengatur
        // tempo heartbeat; ekor log (±1500 char) untuk diagnosis.
        let tail: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&tail);
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut t) = tail.lock() {
                        t.push_str(&line);
                        t.push('\n');
                        if t.len() > 1500 {
                            let cut = t.len() - 1500;
                            *t = t[cut..].to_string();
                        }
                    }
                }
            });
        }
        let root = venv_root();
        let mut last_emit = Instant::now() - Duration::from_secs(10);
        let code: Option<i32> = loop {
            if CANCELLED.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                store_child(None);
                return Err("dibatalkan".to_string());
            }
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(e) => {
                    store_child(None);
                    return Err(format!("tunggu proses gagal: {e}"));
                }
            }
            if last_emit.elapsed() >= Duration::from_secs(2) {
                let got = dir_size(&root);
                emit_progress(self.app, stage, got, EST_TOTAL_BYTES.max(got + 1));
                last_emit = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(400));
        };
        store_child(None);
        if CANCELLED.load(Ordering::Relaxed) {
            return Err("dibatalkan".to_string());
        }
        let tail_txt = tail.lock().map(|t| t.clone()).unwrap_or_default();
        match code {
            Some(0) => Ok(()),
            _ => {
                setup_log(&format!("gagal stage {stage}: {tail_txt}"));
                Err(format!(
                    "tahap {stage} gagal (exit {}). Detail di cuda-setup.log",
                    code.unwrap_or(-1)
                ))
            }
        }
    }
}

/// Cari get-pip.py: bundel assets dulu, lalu unduh kecil bila perlu.
fn find_or_fetch_get_pip(app: &AppHandle) -> Result<PathBuf, String> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("assets/get-pip.py", tauri::path::BaseDirectory::Resource) {
        cands.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in ["", "_up_/", "../", "../../"] {
                cands.push(dir.join(base).join("assets/get-pip.py"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("assets/get-pip.py"));
    }
    if let Some(p) = cands.into_iter().find(|p| p.is_file()) {
        return Ok(p);
    }
    // Fallback: unduh kecil (~2 MB) via curl bawaan Windows.
    let dest = venv_root().join("get-pip.py");
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let st = Command::new("curl.exe").args(["-sSL", "--max-time", "120", "-o"]).arg(&dest).arg(GET_PIP_URL).status();
    match st {
        Ok(s) if s.success() && dest.is_file() => Ok(dest),
        _ => Err("get-pip.py tidak terbundel dan unduhannya gagal".to_string()),
    }
}

/// Buat layout venv manual dari Python dasar (embeddable maupun penuh).
/// Menyalin biner + DLL + zip stdlib yang ADA (set embeddable vs penuh
/// beda isinya; yang tidak ada dilewati) lalu menulis pyvenv.cfg.
fn make_venv_layout(base_exe: &Path, root: &Path) -> Result<(), String> {
    let base_dir = base_exe.parent().ok_or("path python dasar aneh")?.to_path_buf();
    let scripts = root.join("Scripts");
    fs::create_dir_all(&scripts).map_err(|e| format!("buat Scripts gagal: {e}"))?;
    let mut copied = 0;
    for name in [
        "python.exe",
        "pythonw.exe",
        "python311.dll",
        "python3.dll",
        "python311.zip",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
    ] {
        let src = base_dir.join(name);
        if src.is_file() {
            fs::copy(&src, scripts.join(name)).map_err(|e| format!("salin {name} gagal: {e}"))?;
            copied += 1;
        }
    }
    if copied < 2 {
        return Err("file inti Python tidak ditemukan di runtime bawaan".to_string());
    }
    let cfg = format!(
        "home = {}\r\ninclude-system-site-packages = false\r\n",
        base_dir.to_string_lossy()
    );
    fs::write(root.join("pyvenv.cfg"), cfg).map_err(|e| format!("tulis pyvenv.cfg gagal: {e}"))?;
    // Validasi: interpreter venv harus hidup dengan prefix-nya sendiri
    // (bukan prefix base) — kalau ini gagal, instalasi pip akan salah sasaran.
    let out = Command::new(scripts.join("python.exe"))
        .args(["-c", "import sys;print(sys.prefix)"])
        .output()
        .map_err(|e| format!("uji venv gagal dijalankan: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "interpreter venv tidak hidup: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let prefix = String::from_utf8_lossy(&out.stdout).trim().to_lowercase();
    let want = root.to_string_lossy().trim().to_lowercase();
    if prefix != want {
        return Err(format!("prefix venv {prefix} bukan {want}; venv tidak valid"));
    }
    Ok(())
}

/// Python dasar untuk membuat venv: runtime bawaan dulu, lalu PATH.
fn base_python() -> Option<PathBuf> {
    let rt = crate::runtime::runtime_root();
    for name in ["python.exe", "pythonw.exe"] {
        let p = rt.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join("python.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn pip_args<'b>(extra: &[&'b str]) -> Vec<&'b str> {
    // Catatan: JANGAN pakai `--progress-bar off` — pip 26 menolaknya
    // ("no such option"). `-q` cukup; progres dipantau dari ukuran direktori.
    let mut v = vec!["-m", "pip", "--disable-pip-version-check", "--no-input", "--no-color", "-q"];
    v.extend_from_slice(extra);
    v
}

fn worker(app: AppHandle) {
    let root = venv_root();
    // Emit SEGERA sebelum precheck (curl HEAD bisa makan belasan detik):
    // tanpa ini UI duduk kosong antara klik dan event pertama. Frontend juga
    // sudah melukis status installing+precheck saat klik, jadi tidak ada jeda.
    emit_progress(&app, "precheck", 0, EST_TOTAL_BYTES);
    let pre = run_precheck();
    if !pre.ok {
        let msg = pre.errors.join(" ");
        setup_log(&format!("precheck gagal: {msg}"));
        mark_failed(&root);
        emit_progress(&app, "failed", 0, EST_TOTAL_BYTES);
        INSTALLING.store(false, Ordering::Relaxed);
        return;
    }
    if root.join(READY_MARKER).is_file() {
        emit_progress(&app, "done", EST_TOTAL_BYTES, EST_TOTAL_BYTES);
        INSTALLING.store(false, Ordering::Relaxed);
        return;
    }
    let _ = fs::remove_file(root.join(FAILED_MARKER));
    let runner = Runner { app: &app };

    let base = match base_python() {
        Some(p) => p,
        None => {
            let msg = "Python dasar tidak ditemukan (runtime bawaan belum ada)";
            setup_log(msg);
            mark_failed(&root);
            INSTALLING.store(false, Ordering::Relaxed);
            return;
        }
    };

    let guard = |step: Result<(), String>| -> bool {
        if let Err(e) = step {
            setup_log(&format!("berhenti: {e}"));
            mark_failed(&root);
            emit_progress(&app, "failed", dir_size(&root), EST_TOTAL_BYTES);
            INSTALLING.store(false, Ordering::Relaxed);
            return false;
        }
        true
    };

    // 1. Layout venv manual (lewati bila sudah ada -> resume instalasi
    // setengah). Python embeddable TIDAK punya modul `venv`/`ensurepip`
    // (terverifikasi: `No module named venv`), jadi struktur dibuat langsung:
    // Scripts/{python.exe,pythonw.exe,dll,zip} + pyvenv.cfg yang home-nya ke
    // base. Pola ini setara hasil `venv` (prefix = venv, stdlib dari base,
    // site-packages sendiri) dan terbukti jalan + bisa pip install terisolasi.
    let vpy = venv_python();
    if !vpy.is_file() {
        emit_progress(&app, "venv", 0, EST_TOTAL_BYTES);
        if let Err(e) = make_venv_layout(&base, &root) {
            setup_log(&format!("gagal buat venv: {e}"));
            mark_failed(&root);
            INSTALLING.store(false, Ordering::Relaxed);
            return;
        }
    }
    let vpy = venv_python();
    if !vpy.is_file() {
        setup_log("venv jadi tapi interpreter tidak ditemukan");
        mark_failed(&root);
        INSTALLING.store(false, Ordering::Relaxed);
        return;
    }
    let has_pip = Command::new(&vpy)
        .args(["-m", "pip", "--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !has_pip {
        match find_or_fetch_get_pip(&app) {
            Ok(getpip) => {
                if !guard(runner.run(
                    &vpy,
                    &[&getpip.to_string_lossy(), "--no-warn-script-location"],
                    "pip",
                    None,
                )) {
                    return;
                }
            }
            Err(e) => {
                setup_log(&e);
                mark_failed(&root);
                INSTALLING.store(false, Ordering::Relaxed);
                return;
            }
        }
    }

    // 2. torch CUDA dari index resmi (paket terbesar; progres dari ukuran dir).
    emit_progress(&app, "torch", dir_size(&root), EST_TOTAL_BYTES);
    let torch_ok = Command::new(&vpy)
        .args(["-c", "import torch; assert torch.__version__.startswith('2.5.1+cu121')"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !torch_ok {
        let idx = format!("--index-url={TORCH_INDEX}");
        let args = pip_args(&["install", &idx, TORCH_PIN]);
        if !guard(runner.run(&vpy, &args, "torch", None)) {
            return;
        }
    }

    // 3. Dependensi engine dari PyPI (pin di requirements-cuda.txt bila ada).
    emit_progress(&app, "deps", dir_size(&root), EST_TOTAL_BYTES);
    let req = find_requirements(&app);
    if let Some(req) = req {
        let req_s = req.to_string_lossy().to_string();
        let mut extra: Vec<&str> = vec!["install", "-r", &req_s, "--extra-index-url", TORCH_INDEX];
        let pin = req.parent().map(|d| d.join("constraints-cuda.txt")).unwrap_or_default();
        let pin_s;
        if pin.is_file() {
            pin_s = pin.to_string_lossy().to_string();
            extra.push("-c");
            extra.push(&pin_s);
        }
        if !guard(runner.run(&vpy, &pip_args(&extra), "deps", None)) {
            return;
        }
    } else {
        setup_log("requirements-cuda.txt tidak ditemukan; lewati tahap deps");
    }

    // 4. Verifikasi via Runner (bukan Command langsung) supaya tahap sunyi
    // `import torch` (±15 dtk tanpa output) tetap memancarkan heartbeat dan
    // progress bar tidak hilang di tengah jalan.
    emit_progress(&app, "verify", dir_size(&root), EST_TOTAL_BYTES);
    let verify = "import torch,audio_separator,fastapi;assert torch.cuda.is_available(), 'cuda false'";
    if !guard(runner.run(&vpy, &["-c", verify], "verify", None)) {
        return;
    }
    setup_log("verifikasi OK (torch CUDA + audio_separator + fastapi)");
    mark_ready(&root);
    emit_progress(&app, "done", EST_TOTAL_BYTES, EST_TOTAL_BYTES);
    INSTALLING.store(false, Ordering::Relaxed);
}

/// requirements-cuda.txt: resource/assets dulu, lalu folder engine.
fn find_requirements(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("assets/requirements-cuda.txt", tauri::path::BaseDirectory::Resource) {
        cands.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in ["", "_up_/", "../", "../../"] {
                cands.push(dir.join(base).join("assets/requirements-cuda.txt"));
                cands.push(dir.join(base).join("python-engine/requirements-cuda.txt"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("assets/requirements-cuda.txt"));
        cands.push(cwd.join("python-engine/requirements-cuda.txt"));
    }
    // Runtime bawaan membawa engine-nya sendiri.
    cands.push(crate::runtime::runtime_root().join("engine").join("requirements-cuda.txt"));
    cands.into_iter().find(|p| p.is_file())
}

// ---------------------------------------------------------------------------
// command Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn cuda_setup_status() -> CudaSetupStatus {
    let root = venv_root();
    let ready = root.join(READY_MARKER).is_file();
    let failed = root.join(FAILED_MARKER).is_file();
    let installing = INSTALLING.load(Ordering::Relaxed);
    let state = if ready {
        "ready"
    } else if installing {
        "installing"
    } else if failed {
        "failed"
    } else {
        "missing"
    };
    let got = if root.is_dir() { dir_size(&root) } else { 0 };
    CudaSetupStatus {
        state: state.to_string(),
        detail: if ready {
            "Dependensi CUDA siap dipakai.".to_string()
        } else if failed {
            "Instalasi terakhir gagal; bisa diulang (melanjutkan).".to_string()
        } else {
            String::new()
        },
        received: got,
        total: EST_TOTAL_BYTES,
        percent: (got as f64 * 100.0 / EST_TOTAL_BYTES as f64).clamp(0.0, 100.0),
        stage: String::new(),
        error: String::new(),
    }
}

#[tauri::command]
pub fn cuda_setup_precheck() -> CudaPrecheck {
    run_precheck()
}

#[tauri::command]
pub fn cuda_setup_start(app: AppHandle) -> Result<bool, String> {
    if INSTALLING.swap(true, Ordering::Relaxed) {
        return Ok(false);
    }
    if venv_root().join(READY_MARKER).is_file() {
        INSTALLING.store(false, Ordering::Relaxed);
        return Ok(false);
    }
    CANCELLED.store(false, Ordering::Relaxed);
    setup_log("instalasi dimulai");
    std::thread::spawn(move || worker(app));
    Ok(true)
}

#[tauri::command]
pub fn cuda_setup_cancel() -> bool {
    if !INSTALLING.load(Ordering::Relaxed) {
        return false;
    }
    CANCELLED.store(true, Ordering::Relaxed);
    kill_child();
    true
}

#[tauri::command]
pub fn cuda_setup_reset() -> bool {
    if INSTALLING.load(Ordering::Relaxed) {
        return false;
    }
    let root = venv_root();
    fs::remove_dir_all(&root).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_missing_tanpa_venv() {
        // Tidak menyentuh disk asli: status memakai venv_root() sungguhan,
        // jadi test ini hanya menegaskan bentuk struct, bukan state mesin.
        let s = CudaSetupStatus {
            state: "missing".to_string(),
            detail: String::new(),
            received: 0,
            total: EST_TOTAL_BYTES,
            percent: 0.0,
            stage: String::new(),
            error: String::new(),
        };
        assert_eq!(s.total, EST_TOTAL_BYTES);
        assert!(s.percent >= 0.0);
    }

    #[test]
    fn torch_pin_cu121() {
        assert!(TORCH_PIN.contains("cu121"));
        assert!(TORCH_INDEX.contains("cu121"));
    }

    #[test]
    fn parse_cc_ok() {
        assert_eq!(parse_cc("8.6"), Some((8, 6)));
        assert_eq!(parse_cc(" 6.1 "), Some((6, 1)));
        assert_eq!(parse_cc("12.0"), Some((12, 0)));
        assert_eq!(parse_cc("tak-ada"), None);
        assert_eq!(parse_cc("8"), None);
    }

    #[test]
    fn cc_gate_batas() {
        let ok = |s: &str| {
            matches!(parse_cc(s), Some((maj, min)) if maj > MIN_CC_MAJOR || (maj == MIN_CC_MAJOR && min >= MIN_CC_MINOR))
        };
        assert!(ok("8.6"));
        assert!(ok("5.0"));
        assert!(!ok("3.5"));
        assert!(!ok("4.9"));
    }

    #[test]
    fn parse_driver_ok() {
        assert_eq!(parse_driver_major("546.33"), Some(546));
        assert_eq!(parse_driver_major("537"), Some(537));
        assert_eq!(parse_driver_major("tak-ada"), None);
        assert!(parse_driver_major("546.33") >= Some(MIN_DRIVER_MAJOR));
        assert!(parse_driver_major("471.11") < Some(MIN_DRIVER_MAJOR));
    }

    #[test]
    fn advice_tiers() {
        assert!(vram_advice(0)[0].contains("tidak terbaca"));
        assert!(vram_advice(2048)[0].contains("3,5 GB"));
        assert!(vram_advice(4096)[0].contains("4 GB"));
        assert!(vram_advice(8192)[0].contains("6 GB"));
    }
}
