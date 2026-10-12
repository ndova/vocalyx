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
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::Digest;
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

/// Cache unduhan pip milik instalasi ini. SENGAJA di dalam venv (bukan
/// %LOCALAPPDATA%\pip\Cache bawaan pip): heartbeat progres mengukur ukuran
/// folder venv, dan wheel torch ±2,5 GB mendarat di cache dulu sebelum
/// dibongkar — dengan cache bawaan, bar macet di 0.0 GB selama unduhan
/// terlama. Setelah instalasi sukses cache dihapus lagi (lihat worker).
fn pip_cache_dir() -> PathBuf {
    venv_root().join("cache")
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

/// Hasil cek koneksi: (terjangkau, lewat_ipv4_saja).
fn internet_check() -> (bool, bool) {
    // Cek ringan: curl bawaan Windows 10+ HEAD ke index PyTorch.
    let probe = |extra: &[&str]| {
        Command::new("curl.exe")
            .args(["-sSI", "--max-time", "15"])
            .args(extra)
            .arg(CONNECT_CHECK_URL)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if probe(&[]) {
        return (true, false);
    }
    // Kasus nyata: jalur IPv6 rusak (reset saat TLS) tapi IPv4 sehat.
    // Tanpa fallback ini instalasi diblokir padahal server baik-baik saja;
    // worker pip umumnya fallback sendiri, precheck jangan menghalangi.
    if probe(&["-4"]) {
        return (true, true);
    }
    (false, false)
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
    let (internet, ipv4_only) = internet_check();
    if !internet {
        errors.push("Tidak bisa menjangkau index PyTorch. Periksa koneksi internet.".to_string());
    } else if ipv4_only {
        warnings.push("Jalur IPv6 bermasalah (koneksi direset); unduhan memakai IPv4.".to_string());
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

/// Batas diam tanpa byte baru sebelum child tahap jaringan dianggap stall
/// (detik). Koneksi yang tersambung tapi mati suri tidak pernah timeout
/// sendiri di pip (terverifikasi: ESTABLISHED IPv6 ke CDN PyTorch, 0 KB dalam
/// 60 detik, selamanya), sehingga tanpa ini instalasi duduk di angka yang
/// sama tanpa akhir. Trikle lambat tetap aman: pewaktu di-reset tiap ada
/// pertumbuhan byte, berapa pun kecilnya.
const STALL_TIMEOUT_SECS: u64 = 300;
/// Total percobaan tiap tahap jaringan (1 awal + retry). Tiap ulangan
/// mengunduh ulang dari nol (pip tidak melanjutkan parsial) — mahal, tapi
/// lebih baik daripada gantung selamanya. Tiap ulangan dicatat di log.
const STALL_MAX_ATTEMPTS: u32 = 3;

/// Tahap yang memakai jaringan dan karenanya diawasi watchdog stall.
/// Tahap sunyi yang sah (venv/precheck/verify) tidak ikut: di sana tidak ada
/// byte yang diharapkan sehingga watchdog akan membunuh proses yang sehat.
fn stage_uses_network(stage: &str) -> bool {
    matches!(stage, "pip" | "torch" | "deps")
}

/// Hasil satu percobaan `run_once`: selesai (sukses/gagal/dibatalkan) atau
/// mati suri sehingga layak dicoba ulang.
enum RunFail {
    Fatal(String),
    Stalled,
}

impl<'a> Runner<'a> {
    /// Jalankan perintah, stream stderr ke log + pantau ukuran venv untuk
    /// progres. Kembalikan Err bila dibatalkan atau exit != 0.
    ///
    /// Heartbeat TANPA SYARAT tiap 2 dtk: emit tidak menunggu ada baris
    /// stderr baru. Tanpa ini, stall jaringan (pip diam) atau perintah sunyi
    /// (verify `import torch` ±15 dtk) membuat frontend mengira instalasi
    /// macet dan progress bar hilang-muncul — bug yang dilaporkan user.
    ///
    /// Untuk tahap jaringan, satu percobaan yang stall (tanpa byte baru
    /// selama `STALL_TIMEOUT_SECS`) dibunuh lalu diulang sampai
    /// `STALL_MAX_ATTEMPTS` sebelum menyerah dengan pesan yang jelas.
    fn run(&self, exe: &Path, args: &[&str], stage: &str, workdir: Option<&Path>) -> Result<(), String> {
        if CANCELLED.load(Ordering::Relaxed) {
            return Err("dibatalkan".to_string());
        }
        let attempts = if stage_uses_network(stage) { STALL_MAX_ATTEMPTS } else { 1 };
        for attempt in 1..=attempts {
            match self.run_once(exe, args, stage, workdir) {
                Ok(()) => return Ok(()),
                Err(RunFail::Fatal(e)) => return Err(e),
                Err(RunFail::Stalled) => {
                    if attempt < attempts && !CANCELLED.load(Ordering::Relaxed) {
                        setup_log(&format!(
                            "tahap {stage} stall tanpa byte baru > {} mnt, mencoba ulang ({attempt}/{attempts})",
                            STALL_TIMEOUT_SECS / 60
                        ));
                        continue;
                    }
                    if CANCELLED.load(Ordering::Relaxed) {
                        return Err("dibatalkan".to_string());
                    }
                    return Err(format!(
                        "tahap {stage} stall: tidak ada byte baru selama {} menit setelah {attempts}x percobaan. \
                         Periksa koneksi (jalur IPv6 yang rusak pernah terbukti diam seperti ini), lalu ulangi.",
                        STALL_TIMEOUT_SECS / 60
                    ));
                }
            }
        }
        Err(format!("tahap {stage} gagal"))
    }

    /// Satu percobaan menjalankan child sampai selesai/dibatalkan/stall.
    fn run_once(&self, exe: &Path, args: &[&str], stage: &str, workdir: Option<&Path>) -> Result<(), RunFail> {
        use std::sync::{Arc, Mutex as StdMutex};
        let net = stage_uses_network(stage);
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
        // Cache pip di dalam venv supaya heartbeat ukuran direktori ikut
        // mengukur unduhan wheel (bukan diam di 0.0 GB sampai bongkar).
        cmd.env("PIP_CACHE_DIR", pip_cache_dir());
        let mut child: Child = cmd
            .spawn()
            .map_err(|e| RunFail::Fatal(format!("gagal jalankan {}: {e}", exe.display())))?;
        store_child(Some(child.id()));
        // Drain stderr di thread sendiri supaya loop utama bebas mengatur
        // tempo heartbeat; ekor log (±1500 char) untuk diagnosis.
        //
        // stderr dibaca per chunk lalu dibelah `\r` DAN `\n`: meter progres
        // pip memakai carriage return tanpa newline, jadi `.lines()` tidak
        // akan pernah melihatnya bergerak. Segmen meter di-parse jadi byte
        // akurat (sumber kebenaran saat mengunduh) dan TIDAK ikut masuk ekor
        // log supaya pesan error asli tidak tenggelam dalam sampah meter.
        let tail: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
        let pip_bytes: Arc<StdMutex<u64>> = Arc::new(StdMutex::new(0));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&tail);
            let pip_bytes = Arc::clone(&pip_bytes);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut chunk: Vec<u8> = Vec::with_capacity(8192);
                loop {
                    chunk.clear();
                    // `read_until` agar `\r` meter ikut terbaca walau tanpa `\n`.
                    let n = reader
                        .by_ref()
                        .take(8192)
                        .read_until(b'\n', &mut chunk)
                        .unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&chunk);
                    for seg in text.split(['\r', '\n']) {
                        let seg = seg.trim();
                        if seg.is_empty() {
                            continue;
                        }
                        if let Some((got, _)) = parse_pip_progress(seg) {
                            if let Ok(mut p) = pip_bytes.lock() {
                                if got > *p {
                                    *p = got;
                                }
                            }
                        } else if let Ok(mut t) = tail.lock() {
                            t.push_str(seg);
                            t.push('\n');
                            if t.len() > 1500 {
                                let cut = t.len() - 1500;
                                *t = t[cut..].to_string();
                            }
                        }
                    }
                }
            });
        }
        let root = venv_root();
        let mut last_emit = Instant::now() - Duration::from_secs(10);
        let mut last_got = 0u64;
        let mut last_growth = Instant::now();
        let code: Option<i32> = loop {
            if CANCELLED.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                store_child(None);
                return Err(RunFail::Fatal("dibatalkan".to_string()));
            }
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(e) => {
                    store_child(None);
                    return Err(RunFail::Fatal(format!("tunggu proses gagal: {e}")));
                }
            }
            if last_emit.elapsed() >= Duration::from_secs(2) {
                // Byte meter pip menang atas ukuran direktori: direktori buta
                // selama resolusi index/get-pip dan tumbuh lambat di awal
                // unduhan, sementara meter tahu persis byte yang sudah turun.
                let pip = pip_bytes.lock().map(|p| *p).unwrap_or(0);
                let got = dir_size(&root).max(pip);
                if got > last_got {
                    last_got = got;
                    last_growth = Instant::now();
                } else if net && last_growth.elapsed() >= Duration::from_secs(STALL_TIMEOUT_SECS) {
                    // Watchdog: koneksi mati suri tidak pernah timeout sendiri
                    // di pip — bunuh agar pemanggil bisa mencoba ulang, bukan
                    // gantung selamanya di angka yang sama.
                    let _ = child.kill();
                    let _ = child.wait();
                    store_child(None);
                    return Err(RunFail::Stalled);
                }
                emit_progress(self.app, stage, got, EST_TOTAL_BYTES.max(got + 1));
                last_emit = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(400));
        };
        store_child(None);
        if CANCELLED.load(Ordering::Relaxed) {
            return Err(RunFail::Fatal("dibatalkan".to_string()));
        }
        let tail_txt = tail.lock().map(|t| t.clone()).unwrap_or_default();
        match code {
            Some(0) => Ok(()),
            _ => {
                setup_log(&format!("gagal stage {stage}: {tail_txt}"));
                Err(RunFail::Fatal(format!(
                    "tahap {stage} gagal (exit {}). Detail di cuda-setup.log",
                    code.unwrap_or(-1)
                )))
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
    // ("no such option"). `-q` SENGAJA tidak dipakai: meter progres pip
    // (ditulis ke stderr) adalah satu-satunya sumber byte akurat saat
    // mengunduh — heartbeat ukuran direktori buta selama fase resolusi index
    // dan get-pip (yang mengunduh ke %TEMP%), sehingga bar macet di 0.0 GB.
    // `--no-color` menjaga output tetap ASCII agar bisa di-parse.
    // `--timeout 60` (bawaan pip 15 dtk): jaringan lambat tidak boleh dibunuh
    // saat handshake; stall mati suri diurus watchdog `run()` (pecah koneksi
    // yang tersambung tapi nol byte tidak pernah timeout sendiri di pip).
    let mut v = vec!["-m", "pip", "--disable-pip-version-check", "--no-input", "--no-color", "--timeout", "60"];
    v.extend_from_slice(extra);
    v
}

/// Parse satu segmen meter progres pip jadi (byte terunduh, byte total).
///
/// Bentuk pip: `1,2/2,5 GB` atau `114,3/300,2 MB` — satuan hanya ditulis
/// sekali di kanan, jadi sisi kiri yang tak bersatuan memakai satuan kanan.
/// Koma desimal (`1,2`) ikut diterima. Tiap sisi dikonversi mandiri sehingga
/// satuan campuran (`512 kB/2,5 GB`) tetap benar. `None` = bukan baris
/// progres (pesan biasa, URL, `12,3 MB/s eta ...`) — pemanggil mengabaikannya
/// dan tetap memakai heartbeat ukuran direktori sebagai fallback.
fn parse_pip_progress(seg: &str) -> Option<(u64, u64)> {
    fn num_unit(s: &str) -> Option<(f64, &str)> {
        let mut end = 0;
        for (idx, ch) in s.char_indices() {
            if ch.is_ascii_digit() || ch == '.' || ch == ',' {
                end = idx + ch.len_utf8();
            } else {
                break;
            }
        }
        if end == 0 {
            return None;
        }
        let v: f64 = s[..end].replace(',', ".").parse().ok()?;
        Some((v, s[end..].trim_start()))
    }
    fn mult(u: &str) -> Option<f64> {
        let w: String = u.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        match w.to_ascii_lowercase().as_str() {
            "b" => Some(1.0),
            "kb" | "k" | "kib" => Some(1024.0),
            "mb" | "m" | "mib" => Some(1024.0 * 1024.0),
            "gb" | "g" | "gib" => Some(1024.0 * 1024.0 * 1024.0),
            _ => None,
        }
    }
    // Cari `/` satu per satu (maju min 1 byte tiap iterasi supaya URL
    // `https://...` tidak membuat loop selamanya).
    let mut pos = 0;
    while pos < seg.len() {
        let rest = &seg[pos..];
        let Some(rel) = rest.find('/') else { break };
        let right = &rest[rel + 1..];
        if let Some((rv, rrest)) = num_unit(right) {
            if let Some(rm) = mult(rrest) {
                // Token angka kiri: terakhir saja (`1,2`) atau dua terakhir
                // (`512 kB` — angka dan satuannya dipisah spasi).
                let toks: Vec<&str> = rest[..rel].split_whitespace().collect();
                let n = toks.len();
                let mut cands: Vec<String> = Vec::new();
                if n >= 1 {
                    cands.push(toks[n - 1].to_string());
                }
                if n >= 2 {
                    cands.push(format!("{} {}", toks[n - 2], toks[n - 1]));
                }
                for cand in &cands {
                    if let Some((lv, lrest)) = num_unit(cand) {
                        // Sisi kiri tak bersatuan memakai satuan kanan
                        // (`1,2/2,5 GB`); satuan sampah ditolak, bukan ditebak.
                        let lm = if lrest.is_empty() {
                            rm
                        } else if let Some(m) = mult(lrest) {
                            m
                        } else {
                            continue;
                        };
                        let got = (lv * lm) as u64;
                        let tot = (rv * rm) as u64;
                        if tot > 0 && got <= tot {
                            return Some((got, tot));
                        }
                        break;
                    }
                }
            }
        }
        pos += rel + 1;
    }
    None
}

/// Versi torch yang diminta pin, mis. `2.5.1+cu121` dari
/// `torch==2.5.1+cu121`. Satu sumber kebenaran supaya probe, filter wheel,
/// dan pin pip tidak drift satu sama lain.
fn torch_pin_full() -> String {
    TORCH_PIN.split("==").nth(1).unwrap_or("").to_string()
}

/// Awalan nama file wheel, mis. `torch-2.5.1` (bagian `+cu121` ditulis
/// `%2B` di URL sehingga tidak bisa dipakai untuk match mentah).
fn torch_file_prefix() -> String {
    let full = torch_pin_full();
    format!("torch-{}", full.split('+').next().unwrap_or(&full))
}

/// Pilih wheel torch yang cocok dari HTML index PyTorch.
///
/// Mengembalikan (url, sha256-dari-fragment-bila-ada). Filter ketat:
/// nama `torch-<ver>`, tag `cp311`, platform `win_amd64`, akhiran `.whl` —
/// decoy seperti build cp312/win32 atau paket lain harus ditolak. Href absolut
/// dipakai apa adanya; relatif digabung ke index.
fn pick_torch_wheel(html: &str) -> Option<(String, Option<String>)> {
    let prefix = torch_file_prefix();
    let mut pos = 0;
    while pos < html.len() {
        let rest = &html[pos..];
        let Some(rel) = rest.find("href=\"") else { break };
        let start = rel + 6;
        let after = &rest[start..];
        let Some(end) = after.find('"') else { break };
        let href = &after[..end];
        pos += start + end + 1;
        let base = href.split('#').next().unwrap_or(href);
        if !base.ends_with(".whl") {
            continue;
        }
        let file = base.rsplit('/').next().unwrap_or(base);
        if file.contains(&prefix) && file.contains("cp311") && file.contains("win_amd64") {
            let sha = href
                .split("#sha256=")
                .nth(1)
                .map(|s| {
                    s.split(['"', '\'', ' ', '>'])
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string()
                })
                .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()));
            let url = if href.starts_with("http") {
                href.to_string()
            } else {
                format!("{TORCH_INDEX}/{}", href.trim_start_matches('/'))
            };
            return Some((url, sha));
        }
    }
    None
}

/// Nama file lokal dari URL wheel (`%2B` dikembalikan jadi `+` yang sah di
/// nama file Windows; fragment `#sha256=...` dibuang).
fn url_filename(url: &str) -> String {
    let base = url.split('#').next().unwrap_or(url).rsplit('/').next().unwrap_or("torch-cuda.whl");
    base.replace("%2B", "+").replace("%2b", "+")
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("gagal buka {path:?}: {e}"))?;
    let mut h = sha2::Sha256::new();
    std::io::copy(&mut f, &mut h).map_err(|e| format!("gagal hash: {e}"))?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// True bila file wheel utuh: ada isinya, dan cocok sha index bila ada.
fn verify_wheel(path: &Path, sha: Option<&str>) -> bool {
    let Ok(meta) = fs::metadata(path) else { return false };
    if meta.len() == 0 {
        return false;
    }
    match sha {
        Some(want) => match sha256_file(path) {
            Ok(got) if got.eq_ignore_ascii_case(want) => true,
            Ok(got) => {
                setup_log(&format!(
                    "sha wheel tidak cocok (harap {want}, dapat {got}); unduhan korup, dibuang"
                ));
                false
            }
            Err(e) => {
                setup_log(&format!("gagal hash wheel: {e}"));
                false
            }
        },
        None => {
            setup_log("index tanpa sha wheel; terima apa adanya (pip memvalidasi ulang saat pasang)");
            true
        }
    }
}

/// True bila venv sudah berisi torch CUDA sesuai pin.
fn torch_probe_ok(vpy: &Path) -> bool {
    let want = torch_pin_full();
    let probe = format!("import torch; assert torch.__version__.startswith('{want}')");
    Command::new(vpy)
        .args(["-c", &probe])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Unduh wheel torch lewat curl (IPv4 paksa + resume) ke cache pip.
///
/// Mengapa bukan pip langsung: pip memakai satu koneksi tanpa resume dan
/// mengikuti urutan DNS sistem (IPv6 dulu); di rute IPv6 yang flaky, koneksi
/// tersambung lalu mati suri selamanya (terverifikasi: 0 KB/menit ke CDN
/// PyTorch). curl `-4` memaksa jalur IPv4 yang terbukti bersih, dan `-C -`
/// melanjutkan angka (bukan mengulang dari nol) sehingga retry watchdog
/// bersifat kumulatif. Progres, watchdog stall, dan cancel ikut lewat Runner
/// karena file ditulis di dalam venv.
///
/// Gagal di tahap mana pun jatuh balik ke `pip install` biasa — tidak pernah
/// lebih buruk dari perilaku lama.
fn fetch_torch_wheel(runner: &Runner) -> Result<PathBuf, String> {
    // 1. Petakan pin -> URL dari index kecil (56 KB — lolos di rute yang
    // bahkan menggagalkan wheel 2,5 GB). curl langsung agar tanpa dependensi
    // HTTP baru; `--fail` supaya halaman error tidak dianggap index.
    let index_url = format!("{TORCH_INDEX}/torch/");
    let mut html = String::new();
    for attempt in 1..=3u32 {
        if CANCELLED.load(Ordering::Relaxed) {
            return Err("dibatalkan".to_string());
        }
        let out = std::process::Command::new("curl.exe")
            .args(["-4", "-sS", "-L", "--fail", "--max-time", "30", &index_url])
            .output()
            .map_err(|e| format!("curl tidak tersedia: {e}"))?;
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            if pick_torch_wheel(&text).is_some() {
                html = text;
                break;
            }
        }
        setup_log(&format!("ambil index torch gagal (coba {attempt}/3)"));
        std::thread::sleep(Duration::from_secs(3));
    }
    let (url, sha) = pick_torch_wheel(&html)
        .ok_or_else(|| "index torch tidak memuat wheel yang cocok".to_string())?;
    // 2. Unduh dengan resume; heartbeat + watchdog + cancel ikut via Runner.
    let file = url_filename(&url);
    let dir = pip_cache_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("gagal buat cache: {e}"))?;
    let dest = dir.join(&file);
    if dest.is_file() {
        // Lengkap dari run sebelumnya — verifikasi lalu pakai ulang.
        if verify_wheel(&dest, sha.as_deref()) {
            setup_log(&format!("pakai ulang wheel {file} yang sudah lengkap"));
            return Ok(dest);
        }
        let _ = fs::remove_file(&dest);
    }
    setup_log(&format!("mengunduh {file} via curl -4 (resume)"));
    let part = dir.join(format!("{file}.part"));
    let o = part.to_string_lossy().to_string();
    let args = ["-4", "-sS", "-L", "--fail", "--retry", "5", "--retry-all-errors",
        "--retry-delay", "5", "-C", "-", "-o", &o, &url];
    match runner.run(Path::new("curl.exe"), &args, "torch", None) {
        Err(e) if e == "dibatalkan" => return Err(e),
        Err(e) => return Err(format!("unduh curl gagal: {e}")),
        Ok(()) => {}
    }
    if !verify_wheel(&part, sha.as_deref()) {
        let _ = fs::remove_file(&part);
        return Err("wheel hasil unduhan korup".to_string());
    }
    fs::rename(&part, &dest).map_err(|e| format!("gagal simpan wheel: {e}"))?;
    setup_log(&format!("wheel {file} lengkap dan terverifikasi"));
    Ok(dest)
}

fn worker(app: AppHandle) {    let root = venv_root();
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

    // 2. torch CUDA (paket terbesar). Jalur utama: wheel diambil lewat curl
    // -4 ber-resume lalu dipasang lokal (dependensi kecil yang kurang tetap
    // dari index); jatuh balik ke pip langsung bila fetch gagal.
    emit_progress(&app, "torch", dir_size(&root), EST_TOTAL_BYTES);
    if !torch_probe_ok(&vpy) {
        let mut done = false;
        match fetch_torch_wheel(&runner) {
            Err(e) if e == "dibatalkan" => {
                if !guard(Err(e)) {
                    return;
                }
            }
            Err(e) => setup_log(&format!("fetch wheel gagal, pakai pip langsung: {e}")),
            Ok(wheel) => {
                let w = wheel.to_string_lossy().to_string();
                let args = pip_args(&["install", "--extra-index-url", TORCH_INDEX, &w]);
                if guard(runner.run(&vpy, &args, "torch", None)) && torch_probe_ok(&vpy) {
                    done = true;
                } else {
                    setup_log("install lokal belum melengkapi torch, pakai pip langsung...");
                }
            }
        }
        if !done {
            let idx = format!("--index-url={TORCH_INDEX}");
            let args = pip_args(&["install", &idx, TORCH_PIN]);
            if !guard(runner.run(&vpy, &args, "torch", None)) {
                return;
            }
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
    // Wheel di cache sudah tak dibutuhkan (instalasi selesai); hapus untuk
    // merebut kembali ±2,5 GB. Sengaja hanya di jalur sukses: instalasi yang
    // dibatalkan/gagal menyimpan cache untuk resume run berikutnya.
    match fs::remove_dir_all(pip_cache_dir()) {
        Ok(_) => setup_log("cache pip dibersihkan"),
        Err(e) => setup_log(&format!("cache pip gagal dibersihkan (abaikan): {e}")),
    }
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

    #[test]
    fn pip_progress_parses_meter() {
        let gb = 1024u64 * 1024 * 1024;
        let mb = 1024u64 * 1024;
        // Bentuk kanonik pip: satuan ditulis sekali di kanan.
        assert_eq!(
            parse_pip_progress("━━━━━━━━━━━━━ 1,2/2,5 GB  12,3 MB/s eta 0:03:12"),
            Some(((1.2 * gb as f64) as u64, (2.5 * gb as f64) as u64))
        );
        assert_eq!(
            parse_pip_progress("114,3/300,2 MB  8,1 MB/s eta 0:00:24"),
            Some(((114.3 * mb as f64) as u64, (300.2 * mb as f64) as u64))
        );
        // Satuan campuran tetap dikonversi mandiri.
        assert_eq!(
            parse_pip_progress("512 kB/2,5 GB"),
            Some((512 * 1024, (2.5 * gb as f64) as u64))
        );
        // Bukan meter: pesan biasa, URL, kecepatan — semuanya None supaya
        // heartbeat ukuran direktori yang dipakai, bukan angka sampah.
        assert_eq!(parse_pip_progress("Collecting torch==2.5.1+cu121"), None);
        assert_eq!(parse_pip_progress("https://download.pytorch.org/whl/cu121/"), None);
        assert_eq!(parse_pip_progress("12,3 MB/s eta 0:03:12"), None);
        assert_eq!(parse_pip_progress(""), None);
        assert_eq!(parse_pip_progress("9,9/2,5 GB"), None);
    }

    #[test]
    fn watchdog_covers_network_stages_only() {
        // Tahap sunyi yang sah tidak boleh diawasi: di sana tidak ada byte
        // yang diharapkan sehingga watchdog akan membunuh proses sehat.
        for s in ["pip", "torch", "deps"] {
            assert!(stage_uses_network(s), "{s} memakai jaringan");
        }
        for s in ["precheck", "venv", "verify"] {
            assert!(!stage_uses_network(s), "{s} tidak memakai jaringan");
        }
        assert!(STALL_TIMEOUT_SECS >= 60, "watchdog tidak boleh agresif");
        assert!(STALL_MAX_ATTEMPTS >= 2, "stall dapat retry sebelum menyerah");
    }

    #[test]
    fn torch_wheel_pick() {
        assert_eq!(torch_pin_full(), "2.5.1+cu121");
        assert_eq!(torch_file_prefix(), "torch-2.5.1");
        let html = concat!(
            "<a href=\"https://download-r2.pytorch.org/whl/cu121/torch-2.5.1%2Bcu121-cp312-cp312-win_amd64.whl#sha256=",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "\">x</a><br/>\n",
            "<a href=\"https://download-r2.pytorch.org/whl/cu121/torch-2.5.1%2Bcu121-cp311-cp311-win32.whl\">x</a><br/>\n",
            "<a href=\"https://download-r2.pytorch.org/whl/cu121/torch-2.5.1%2Bcu121-cp311-cp311-win_amd64.whl#sha256=",
            "4bcee18f00c43c815efad8efaa3bca584ffdc8d2cd35ef4c44c814f2739d9191",
            "\">torch-2.5.1+cu121-cp311-cp311-win_amd64.whl</a><br/>\n",
            "<a href=\"https://download-r2.pytorch.org/whl/cu121/numpy-2.1.2-cp311-cp311-win_amd64.whl\">x</a><br/>\n",
        );
        let (url, sha) = pick_torch_wheel(html).expect("wheel cocok harus ketemu");
        assert!(url.contains("cp311-cp311-win_amd64.whl"), "decoy cp312/win32/numpy ditolak: {url}");
        assert_eq!(
            sha.as_deref(),
            Some("4bcee18f00c43c815efad8efaa3bca584ffdc8d2cd35ef4c44c814f2739d9191")
        );
        assert_eq!(
            url_filename(&url),
            "torch-2.5.1+cu121-cp311-cp311-win_amd64.whl"
        );
        assert_eq!(pick_torch_wheel("tidak ada link"), None);
        assert_eq!(pick_torch_wheel(""), None);
    }
}
