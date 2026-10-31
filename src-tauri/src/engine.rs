






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

    
    
    pub fn shutdown(&self) {
        let child = { self.0.lock().ok().and_then(|mut g| g.take()) };
        if let Some(mut child) = child {
            log_line!("shutdown engine (pid {})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}



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






static START_LOCK: Mutex<()> = Mutex::new(());

pub fn start(app: &AppHandle) {
    let _guard = match START_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if engine_alive() {
        
        
        
        
        
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









fn engine_alive() -> bool {
    health_body().is_some()
}


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



fn engine_has_premium_backend() -> bool {
    health_body().map(|b| b.contains("\"premium_backend\"")).unwrap_or(false)
}















fn apply_runtime_env(cmd: &mut Command, py: &str, cwd: &Path, script: &Path) {
    let mut paths: Vec<String> = Vec::new();
    if let Some(dir) = script.parent() {
        paths.push(dir.to_string_lossy().to_string());
    }
    
    
    
    
    
    
    
    
    
    
    
    
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
    
    
    
    
    
    
    let mut path_prepend: Vec<String> = Vec::new();
    {
        let exe = Path::new(py);
        if let Some(parent) = exe.parent() {
            for d in [parent.to_path_buf(), parent.join("Scripts")] {
                if d.is_dir() {
                    let s = d.to_string_lossy().to_string();
                    if !path_prepend.contains(&s) {
                        path_prepend.push(s);
                    }
                }
            }
        }
    }
    let ffmpeg_bin = runtime_dirs
        .iter()
        .map(|d| d.join("ffmpeg").join("bin"))
        .find(|d| d.join("ffmpeg.exe").is_file() || d.join("ffmpeg").is_file());
    if let Some(fb) = &ffmpeg_bin {
        path_prepend.push(fb.to_string_lossy().to_string());
        cmd.env("FFMPEG_BINARY", fb.join("ffmpeg.exe"));
    }
    if !path_prepend.is_empty() {
        let existing_path = std::env::var("PATH").unwrap_or_default();
        let mut value = path_prepend.join(";");
        if !existing_path.is_empty() {
            value.push(';');
            value.push_str(&existing_path);
        }
        cmd.env("PATH", value);
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










fn find_engine_script(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    
    
    for name in ["server.pyc", "server.py"] {
        if let Ok(p) = app.path().resolve(
            format!("python-engine/{name}"),
            BaseDirectory::Resource,
        ) {
            cands.push(p);
        }
    }
    
    
    
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
    
    
    
    
    cands.push(crate::runtime::runtime_root());
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("build/runtime"));
        cands.push(cwd.join("runtime"));
    }
    cands
        .into_iter()
        .find(|d| d.join("python.exe").is_file() || d.join("pythonw.exe").is_file())
}










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



pub fn detect() -> Vec<PythonInfo> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(custom) = std::env::var("VOCALYX_PYTHON") {
        cands.push(PathBuf::from(custom));
    }
    
    
    
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
        
        out.sort_by(|a, b| {
            b.cuda.cmp(&a.cuda)
                .then(b.has_deps.cmp(&a.has_deps))
                .then(a.path.cmp(&b.path))
        });
        out
    }

    
    
    
    
    
    
    
    static CACHE: Mutex<Option<(std::time::Instant, Vec<PythonInfo>)>> = Mutex::new(None);
    const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

    
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


fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}


#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct EngineConfig {
    pub device: String,
    pub gpu_python: String,
    pub active_python: String,
    pub active_cuda: bool,
}

pub struct EngineChoice(pub Mutex<EngineConfig>);






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







fn resolve_interpreter(
    device: &str,
    gpu_python: &str,
    detected: &[gpu::PythonInfo],
) -> Result<PathBuf, String> {
    let dev = device.to_ascii_lowercase();
    let chosen = if dev == "cuda" {
        let usable = |i: &&gpu::PythonInfo| i.cuda && i.has_deps;
        
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




fn chosen_python(app: &AppHandle) -> Option<PathBuf> {
    let cfg = EngineChoice::snapshot(app);
    let device = cfg.as_ref().map(|c| c.device.clone()).unwrap_or_else(|| "auto".into());
    let gpu_python = cfg.as_ref().map(|c| c.gpu_python.clone()).unwrap_or_default();
    let dev = device.to_ascii_lowercase();

    
    
    
    if dev == "cuda" {
        if let Some(c) = cfg.as_ref() {
            let p = PathBuf::from(&c.active_python);
            if !c.active_python.is_empty() && p.is_file() {
                log_line!("pakai interpreter tersimpan: {}", p.display());
                return Some(p);
            }
        }
    }

    
    
    let detected = if dev == "cuda" {
        gpu::detect_cached(false)
    } else {
        Vec::new()
    };
    resolve_interpreter(&dev, &gpu_python, &detected).ok()
}







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





#[tauri::command]
pub async fn restart_engine(app: AppHandle) -> Result<bool, String> {
    
    
    
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




#[tauri::command]
pub async fn detect_pythons_async(force: Option<bool>) -> Vec<gpu::PythonInfo> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || gpu::detect_cached(force))
        .await
        .unwrap_or_default()
}





#[tauri::command]
pub fn gpu_probe_cached(max_age_secs: Option<u64>) -> Option<gpu::ProbeSummary> {
    gpu::load_summary(max_age_secs.unwrap_or(86_400))
}

#[tauri::command]
pub fn get_engine_config(app: AppHandle) -> EngineConfig {
    EngineChoice::snapshot(&app).unwrap_or_else(default_config)
}












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














#[tauri::command]
pub async fn set_engine_config(
    app: AppHandle,
    device: String,
    gpu_python: String,
) -> Result<EngineConfig, String> {
    let dev = normalize_device(&device);
    let gpu_py = gpu_python.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        
        
        
        
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
