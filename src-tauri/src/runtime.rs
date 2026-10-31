










use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

pub const PROGRESS_EVENT: &str = "runtime://progress";
const RUNTIME_DIRNAME: &str = "runtime";
const PY_MARKER: &str = "Lib/site-packages";








const READY_MARKER: &str = ".ready";
const FAILED_MARKER: &str = ".failed";

static EXTRACTING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub installed: bool,
    pub variant: String,
    pub path: String,
    pub python: bool,
    pub engine: bool,
    pub cuda: bool,
    
    pub bundled: bool,
    
    pub extracting: bool,
    
    pub failed: bool,
}

#[derive(Serialize, Clone)]
pub struct Progress {
    pub received: u64,
    pub total: u64,
    pub percent: f64,
    pub stage: String,
}

pub fn app_data_dir() -> PathBuf {
    data_root().join(APP_DIRNAME)
}


fn data_root() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}




const APP_DIRNAME: &str = "VocaLyx";
const LEGACY_APPNAME: &str = "NetKara";






pub fn migrate_legacy_data_dir() {
    let legacy = data_root().join(LEGACY_APPNAME);
    if !legacy.is_dir() {
        return;
    }
    let current = data_root().join(APP_DIRNAME);
    let mut moved: Vec<String> = Vec::new();
    for name in ["runtime", "models", "downloads"] {
        let from = legacy.join(name);
        let to = current.join(name);
        if !from.exists() || to.exists() {
            continue;
        }
        if let Some(parent) = to.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::rename(&from, &to).is_ok() {
            moved.push(name.to_string());
        }
    }
    
    
    let old_log = legacy.join("engine.log");
    if old_log.is_file() {
        if let Ok(text) = fs::read_to_string(&old_log) {
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(current.join("engine.log"))
                .and_then(|mut f| f.write_all(text.as_bytes()));
        }
        let _ = fs::remove_file(&old_log);
        moved.push("engine.log".to_string());
    }
    for name in moved {
        crate::engine::write_log_note(&format!("migrasi {LEGACY_APPNAME}/{name} -> {APP_DIRNAME}/{name}"));
    }
    
    if fs::read_dir(&legacy).map(|mut d| d.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(&legacy);
    }
}

pub fn runtime_root() -> PathBuf {
    app_data_dir().join(RUNTIME_DIRNAME)
}



fn python_ok(root: &Path) -> bool {
    root.join("python.exe").is_file() || root.join("pythonw.exe").is_file()
}

fn site_packages_ok(root: &Path) -> bool {
    root.join(PY_MARKER).is_dir()
}




fn engine_ok(root: &Path) -> bool {
    let e = root.join("engine");
    e.join("server.pyc").is_file() || e.join("server.py").is_file()
}

fn cuda_available(root: &Path) -> bool {
    root.join("Lib")
        .join("site-packages")
        .join("nvidia")
        .is_dir()
}




fn looks_complete(root: &Path) -> bool {
    python_ok(root)
        && root.join(PY_MARKER).join("torch").is_dir()
        && root.join("Scripts").is_dir()
        && root.join("ffmpeg").join("bin").join("ffmpeg.exe").is_file()
}

fn mark_ready(root: &Path) {
    let _ = fs::write(root.join(READY_MARKER), b"v1\n");
    let _ = fs::remove_file(root.join(FAILED_MARKER));
}





fn bundle_fingerprint(zip: &Path) -> String {
    match fs::metadata(zip) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos().to_string())
                .unwrap_or_default();
            format!("{}:{}", m.len(), mtime)
        }
        Err(_) => String::new(),
    }
}

fn marker_fingerprint(root: &Path) -> String {
    fs::read_to_string(root.join(READY_MARKER))
        .unwrap_or_default()
        .lines()
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn mark_ready_fp(root: &Path, fp: &str) {
    let body = if fp.is_empty() {
        "v1\n".to_string()
    } else {
        format!("v2\n{fp}\n")
    };
    let _ = fs::write(root.join(READY_MARKER), body);
    let _ = fs::remove_file(root.join(FAILED_MARKER));
}

fn installed_now() -> bool {
    runtime_root().join(READY_MARKER).is_file() || looks_complete(&runtime_root())
}




fn needs_bundled_extract(app: &AppHandle) -> bool {
    if installed_now() {
        match bundled_zip(app) {
            Some(zip) => {
                let want = bundle_fingerprint(&zip);
                !want.is_empty() && marker_fingerprint(&runtime_root()) != want
            }
            None => false,
        }
    } else {
        bundled_zip(app).is_some()
    }
}



fn mark_failed(root: &Path) {
    if root.is_dir() {
        let _ = fs::write(root.join(FAILED_MARKER), b"v1\n");
    }
}




pub fn status_with(app: Option<&AppHandle>) -> RuntimeStatus {
    migrate_legacy_data_dir();
    let root = runtime_root();
    let marker = root.join(READY_MARKER).is_file();
    let installed = marker || looks_complete(&root);
    if installed && !marker && root.is_dir() {
        mark_ready(&root);
    }
    RuntimeStatus {
        installed,
        variant: if cuda_available(&root) { "cuda" } else { "cpu" }.to_string(),
        path: root.to_string_lossy().to_string(),
        python: python_ok(&root),
        engine: engine_ok(&root),
        cuda: cuda_available(&root),
        bundled: app.and_then(|a| bundled_zip(a)).is_some(),
        extracting: EXTRACTING.load(Ordering::Relaxed),
        failed: root.join(FAILED_MARKER).is_file(),
    }
}

#[tauri::command]
pub fn runtime_status(app: AppHandle) -> RuntimeStatus {
    status_with(Some(&app))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("gagal buka {path:?}: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| format!("gagal hash: {e}"))?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<u64, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("gagal buka zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip rusak: {e}"))?;

    
    
    
    
    
    let strip = common_prefix_dir(&mut archive);

    fs::create_dir_all(dest).map_err(|e| format!("gagal buat folder: {e}"))?;
    let mut count = 0u64;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(rel) = entry.enclosed_name() else { continue };
        let rel: PathBuf = match &strip {
            Some(p) => match rel.strip_prefix(p) {
                Ok(r) if r.as_os_str().is_empty() => continue,
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            },
            None => rel,
        };
        let out = dest.join(&rel);
        if entry.is_dir() {
            let _ = fs::create_dir_all(&out);
            continue;
        }
        if let Some(parent) = out.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut target = fs::File::create(&out).map_err(|e| format!("gagal tulis {out:?}: {e}"))?;
        std::io::copy(&mut entry, &mut target).map_err(|e| format!("gagal ekstrak: {e}"))?;
        count += 1;
    }
    Ok(count)
}






fn common_prefix_dir<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Option<PathBuf> {
    let mut prefix: Option<PathBuf> = None;
    for i in 0..archive.len() {
        let entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(name) = entry.enclosed_name() else { continue };
        let first = name.components().next()?.as_os_str().to_os_string();
        let first = PathBuf::from(first);
        match &prefix {
            Some(p) if p != &first => return None,
            Some(_) => {}
            None => prefix = Some(first),
        }
    }
    prefix
}



#[tauri::command]
pub async fn runtime_install(app: AppHandle, url: String, sha256: String) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("URL runtime kosong".to_string());
    }
    let root = runtime_root();
    let dl_dir = app_data_dir().join("downloads");
    fs::create_dir_all(&dl_dir).map_err(|e| format!("gagal buat folder unduhan: {e}"))?;
    let zip_path = dl_dir.join("runtime-cpu.zip");

    let emit = |received: u64, total: u64, stage: &str| {
        let percent = if total > 0 {
            (received as f64 * 100.0 / total as f64).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let _ = app.emit(
            PROGRESS_EVENT,
            Progress { received, total, percent, stage: stage.to_string() },
        );
    };

    emit(0, 0, "download");
    let client = reqwest::Client::builder()
        .user_agent("VocaLyx/0.1 runtime-installer")
        .build()
        .map_err(|e| format!("HTTP client gagal: {e}"))?;

    
    
    
    let want = resolve_expected_hash(&client, &sha256).await?;

    
    
    
    
    let tmp = zip_path.with_extension("part");
    let mut resume_from = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    let mut resp = {
        let mut req = client.get(&url);
        if resume_from > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }
        req.send()
            .await
            .map_err(|e| format!("gagal mengunduh runtime: {e}"))?
    };
    let mut finished = false;
    if resp.status().as_u16() == 416 && resume_from > 0 {
        if let Some(want) = &want {
            if let Ok(got) = sha256_file(&tmp) {
                if &got == want {
                    finished = true;
                }
            }
        }
        if !finished {
            let _ = fs::remove_file(&tmp);
            resume_from = 0;
            resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("gagal mengunduh runtime: {e}"))?;
        }
    }
    if !finished && !resp.status().is_success() {
        return Err(format!("server membalas {}", resp.status()));
    }
    let mut received = resume_from;
    let mut total = 0u64;
    if !finished {
        let append = resp.status().as_u16() == 206 && resume_from > 0;
        if !append {
            resume_from = 0;
            received = 0;
        }
        total = resp.content_length().map(|l| l + resume_from).unwrap_or(0);
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("gagal buat file: {e}"))?;
        if append {
            file.seek(SeekFrom::End(0)).ok();
        } else {
            file.set_len(0).ok();
        }
        emit(received, total, "download");
        let mut stream = resp.bytes_stream();
        use futures_util::StreamExt;
        let mut last_emit = received;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("unduhan terputus: {e}"))?;
            file.write_all(&chunk).map_err(|e| format!("gagal menulis: {e}"))?;
            received += chunk.len() as u64;
            if received - last_emit >= 4 * 1024 * 1024 {
                last_emit = received;
                emit(received, total, "download");
            }
        }
        file.flush().ok();
        drop(file);
        emit(received, total, "verify");
    } else {
        emit(received, received, "verify");
    }

    if let Some(want) = &want {
        let got = sha256_file(&tmp)?;
        if &got != want {
            let _ = fs::remove_file(&tmp);
            return Err(format!("sha256 tidak cocok (harap: {want}, dapat: {got})"));
        }
    }
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| format!("gagal bersihkan runtime lama: {e}"))?;
    }
    emit(received, total, "extract");
    EXTRACTING.store(true, Ordering::Relaxed);
    let result = extract_zip(&tmp, &root);
    EXTRACTING.store(false, Ordering::Relaxed);
    result?;
    let _ = fs::remove_file(&tmp);
    if !python_ok(&root) || !site_packages_ok(&root) {
        return Err("paket runtime ter ekstrak tapi python/site-packages tidak ditemukan".to_string());
    }
    mark_ready(&root);
    emit(received, total, "done");
    Ok(())
}

#[tauri::command]
pub fn runtime_remove() -> Result<(), String> {
    let root = runtime_root();
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| format!("gagal hapus runtime: {e}"))?;
    }
    Ok(())
}






async fn resolve_expected_hash(client: &reqwest::Client, raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(Some(raw.to_ascii_lowercase()));
    }
    if !raw.starts_with("http://") && !raw.starts_with("https://") {
        return Err(format!("referensi sha256 tidak valid: {raw}"));
    }
    let text = client
        .get(raw)
        .send()
        .await
        .map_err(|e| format!("gagal mengunduh {raw}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("checksum membalas error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("gagal membaca checksum: {e}"))?;
    let digest = parse_sha256sum(&text)
        .ok_or_else(|| format!("tidak ada digest sha256 di {raw}"))?;
    Ok(Some(digest))
}


fn parse_sha256sum(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(token.to_ascii_lowercase());
        }
    }
    None
}








#[derive(Serialize)]
pub struct AppleDriverStatus {
    pub ready: bool,
    pub service: bool,
    pub executable: bool,
    pub port: u16,
    pub code: String,
}

#[cfg(windows)]
fn apple_usbmux_listening() -> bool {
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 27015));
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(600)).is_ok()
}

#[cfg(not(windows))]
fn apple_usbmux_listening() -> bool {
    false
}

fn apple_service_candidates() -> Vec<PathBuf> {
    
    
    
    
    let mut roots: Vec<PathBuf> = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "CommonProgramFiles(x86)"] {
        if let Some(v) = std::env::var_os(key) {
            let p = PathBuf::from(v);
            if !roots.contains(&p) {
                roots.push(p);
            }
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for r in &roots {
        let base = if r.ends_with("Common Files") || r.ends_with("Common Files (x86)") {
            r.clone()
        } else {
            r.join("Common Files")
        };
        out.push(
            base.join("Apple")
                .join("Mobile Device Support")
                .join("AppleMobileDeviceService.exe"),
        );
    }
    out
}

#[allow(dead_code)]
fn apple_service_exe() -> PathBuf {
    for cand in apple_service_candidates() {
        if cand.is_file() {
            return cand;
        }
    }
    
    apple_service_candidates().into_iter().next().unwrap_or_else(std::env::temp_dir)
}

#[tauri::command]
pub fn apple_driver_status() -> AppleDriverStatus {
    let listening = apple_usbmux_listening();
    let executable = apple_service_candidates().iter().any(|p| p.is_file());
    AppleDriverStatus {
        ready: listening,
        service: listening,
        executable,
        port: 27015,
        code: if listening {
            String::new()
        } else {
            "ERR_APPLE_DRIVER_MISSING".to_string()
        },
    }
}


















const VC_DLLS: [&str; 4] = [
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcruntime140_threads.dll",
];



const VC_RESOURCE: &str = "assets/vcredist/vc_redist.x64.exe";

fn system32_dir() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
}

fn vc_runtime_present() -> bool {
    let dir = system32_dir();
    VC_DLLS.iter().all(|d| dir.join(d).is_file())
}

fn bundled_vcredist(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app.path().resolve(VC_RESOURCE, tauri::path::BaseDirectory::Resource) {
        if p.is_file() {
            return Some(p);
        }
    }
    
    
    
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in ["", "_up_/", "../", "../../"] {
                for rel in ["assets/vcredist/vc_redist.x64.exe", "vcredist/vc_redist.x64.exe"] {
                    let p = dir.join(base).join(rel);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for rel in ["assets/vcredist/vc_redist.x64.exe", "vcredist/vc_redist.x64.exe"] {
            let p = cwd.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct VcRuntimeStatus {
    pub present: bool,
    pub installer_bundled: bool,
}

#[tauri::command]
pub fn vc_runtime_status(app: AppHandle) -> VcRuntimeStatus {
    VcRuntimeStatus {
        present: vc_runtime_present(),
        installer_bundled: bundled_vcredist(&app).is_some(),
    }
}














pub fn ensure_vc_runtime(app: &AppHandle) -> bool {
    if vc_runtime_present() {
        return true;
    }
    let Some(installer) = bundled_vcredist(app) else {
        crate::engine::write_log_note("MSVC runtime hilang dan installer terbundel tak ditemukan");
        return false;
    };
    
    
    let staged = std::env::temp_dir().join("vocalyx-vc_redist.x64.exe");
    let target = if same_file(&installer, &staged) {
        installer
    } else {
        match fs::copy(&installer, &staged) {
            Ok(_) => staged,
            Err(e) => {
                crate::engine::write_log_note(&format!(
                    "VC Redist gagal disalin ke TEMP ({e}), pakai path asli"
                ));
                installer
            }
        }
    };
    crate::engine::write_log_note("MSVC runtime hilang/tak lengkap, memasang VC Redist terbundel...");
    
    
    
    
    
    
    fn run_vcredist(installer: &Path, verb: &str) -> bool {
        let ps = format!(
            "Start-Process -FilePath '{}' -ArgumentList '/{}','/quiet','/norestart' -Verb RunAs -Wait",
            installer.to_string_lossy().replace('\'', "''"),
            verb
        );
        match std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .output()
        {
            Ok(o) => {
                crate::engine::write_log_note(&format!(
                    "VC Redist {verb} exit {} (runtime hadir: {})",
                    o.status.code().unwrap_or(-1),
                    vc_runtime_present()
                ));
                o.status.success()
            }
            Err(e) => {
                crate::engine::write_log_note(&format!("VC Redist {verb} gagal dijalankan: {e}"));
                false
            }
        }
    }
    if run_vcredist(&target, "install") && vc_runtime_present() {
        crate::engine::write_log_note("VC Redist terpasang");
        return true;
    }
    
    
    if !vc_runtime_present() {
        crate::engine::write_log_note("VC Redist install tidak melengkapi runtime, mencoba repair...");
        run_vcredist(&target, "repair");
    }
    if vc_runtime_present() {
        crate::engine::write_log_note("VC Redist pulih lewat repair");
        true
    } else {
        crate::engine::write_log_note(
            "VC Redist tetap tak lengkap sesudah install+repair; \
             bila versi yang terdaftar lebih baru dari bundel, unduh VC Redist \
             terbaru dari situs Microsoft dan pasang manual",
        );
        false
    }
}


fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}






#[tauri::command]
pub async fn vc_runtime_install(app: AppHandle) -> Result<bool, String> {
    if vc_runtime_present() {
        return Ok(true);
    }
    tauri::async_runtime::spawn_blocking(move || {
        if ensure_vc_runtime(&app) {
            Ok(true)
        } else {
            Err("instalasi VC Redist gagal atau ditolak (lihat %APPDATA%\\VocaLyx\\engine.log)".to_string())
        }
    })
    .await
    .map_err(|e| format!("gagal menjalankan perintah: {e}"))?
}


fn bundled_zip(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("runtime-bundle.zip", tauri::path::BaseDirectory::Resource) {
        cands.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in ["", "_up_/", "../", "../../"] {
                cands.push(dir.join(base).join("runtime-bundle.zip"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("build/runtime-bundle.zip"));
    }
    cands.into_iter().find(|p| p.is_file())
}

fn emit_progress(app: &AppHandle, stage: &str, received: u64, total: u64) {
    let percent = if total > 0 {
        (received as f64 * 100.0 / total as f64).clamp(0.0, 100.0)
    } else {
        0.0
    };
    let _ = app.emit(
        PROGRESS_EVENT,
        Progress { received, total, percent, stage: stage.to_string() },
    );
}




pub fn extract_bundled(app: &AppHandle) -> Result<bool, String> {
    let root = runtime_root();
    if root.join(READY_MARKER).is_file() || looks_complete(&root) {
        
        if !needs_bundled_extract(app) {
            if !root.join(READY_MARKER).is_file() {
                mark_ready(&root);
            }
            return Ok(false);
        }
    }
    let Some(zip) = bundled_zip(app) else {
        return Ok(false);
    };
    EXTRACTING.store(true, Ordering::Relaxed);
    let _ = fs::remove_file(root.join(FAILED_MARKER));
    let total = fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
    emit_progress(app, "extract", 0, total);
    let _ = fs::remove_dir_all(&root);
    let result = extract_zip(&zip, &root);
    EXTRACTING.store(false, Ordering::Relaxed);
    if let Err(e) = result {
        mark_failed(&root);
        return Err(e);
    }
    if !python_ok(&root) || !site_packages_ok(&root) {
        mark_failed(&root);
        return Err("runtime ter-ekstrak tapi python/site-packages tidak ditemukan".to_string());
    }
    mark_ready_fp(&root, &bundle_fingerprint(&zip));
    emit_progress(app, "done", total, total);
    Ok(true)
}


#[tauri::command]
pub fn runtime_extract_bundled(app: AppHandle) -> Result<bool, String> {
    extract_bundled(&app)
}




pub fn spawn_ensure_and_start(app: AppHandle) {
    migrate_legacy_data_dir();
    
    
    
    
    
    if needs_bundled_extract(&app) {
        EXTRACTING.store(true, Ordering::Relaxed);
    } else if installed_now() && !runtime_root().join(READY_MARKER).is_file() {
        mark_ready(&runtime_root());
    }
    tauri::async_runtime::spawn_blocking(move || {
        
        ensure_vc_runtime(&app);
        match extract_bundled(&app) {
            Ok(true) => crate::engine::write_log_note("runtime terbundul diekstrak"),
            Ok(false) => {}
            Err(e) => crate::engine::write_log_note(&format!("runtime terbundul gagal: {e}")),
        }
        crate::engine::start(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vocalyx-zip-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_zip(path: &Path, names: &[&str]) {
        let file = fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        for name in names {
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            w.start_file(*name, opts).unwrap();
            w.write_all(b"x").unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn strips_single_top_level_dir() {
        let dir = scratch("prefix");
        let zip_path = dir.join("in.zip");
        make_zip(
            &zip_path,
            &[
                "runtime/python.exe",
                "runtime/python311._pth",
                "runtime/engine/server.pyc",
                "runtime/Lib/site-packages/torch/__init__.py",
            ],
        );
        let out = dir.join("out");
        let n = extract_zip(&zip_path, &out).unwrap();
        assert_eq!(n, 4, "semua file harus ikut terekstrak");
        assert!(out.join("python.exe").is_file(), "prefix harus dilepas");
        assert!(out.join("engine/server.pyc").is_file());
        assert!(out.join("Lib/site-packages/torch/__init__.py").is_file());
        assert!(
            !out.join("runtime").exists(),
            "tidak boleh ada folder runtime/ di dalam runtime"
        );
        assert!(python_ok(&out), "python_ok harus true setelah ekstrak");
        assert!(site_packages_ok(&out), "site_packages_ok harus true");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_flat_zip_intact() {
        let dir = scratch("flat");
        let zip_path = dir.join("in.zip");
        make_zip(&zip_path, &["a.txt", "b/c.txt"]);
        let out = dir.join("out");
        extract_zip(&zip_path, &out).unwrap();
        assert!(out.join("a.txt").is_file(), "zip datar tidak boleh diratakan");
        assert!(out.join("b/c.txt").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn marker_fingerprint_roundtrip() {
        let dir = scratch("markerfp");
        assert_eq!(marker_fingerprint(&dir), "", "tanpa marker = sidik kosong");
        mark_ready(&dir);
        assert_eq!(marker_fingerprint(&dir), "", "marker legacy v1 = sidik kosong (dianggap basi)");
        mark_ready_fp(&dir, "123:456");
        assert_eq!(marker_fingerprint(&dir), "123:456", "marker v2 menyimpan sidik");
        assert!(dir.join(READY_MARKER).is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_fingerprint_changes_with_content() {
        let dir = scratch("bundlefp");
        let zip_path = dir.join("b.zip");
        make_zip(&zip_path, &["a.txt"]);
        let fp1 = bundle_fingerprint(&zip_path);
        assert!(!fp1.is_empty());
        std::thread::sleep(std::time::Duration::from_millis(5));
        make_zip(&zip_path, &["a.txt", "b.txt"]);
        let fp2 = bundle_fingerprint(&zip_path);
        assert_ne!(fp1, fp2, "bundel berubah = sidik berubah");
        assert_eq!(bundle_fingerprint(&dir.join("tak-ada.zip")), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_sha256sum_text() {
        let d = "a".repeat(64);
        assert_eq!(parse_sha256sum(&format!("{d}  runtime-cpu.zip\n")), Some(d.clone()));
        assert_eq!(parse_sha256sum(&d), Some(d));
        assert_eq!(parse_sha256sum("ganti_release\n"), None);
        assert_eq!(parse_sha256sum(""), None);
    }

    #[test]
    fn rejects_nested_traversal() {
        let dir = scratch("evil");
        let zip_path = dir.join("in.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        w.start_file("../escaped.txt", opts).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
        let out = dir.join("out");
        extract_zip(&zip_path, &out).unwrap();
        assert!(!dir.join("escaped.txt").exists(), "path keluar zip harus diabaikan");
        let _ = fs::remove_dir_all(&dir);
    }

    
    fn fake_complete(root: &Path) {
        fs::create_dir_all(root.join("Lib").join("site-packages").join("torch")).unwrap();
        fs::create_dir_all(root.join("Scripts")).unwrap();
        fs::create_dir_all(root.join("ffmpeg").join("bin")).unwrap();
        fs::write(root.join("python.exe"), b"x").unwrap();
        fs::write(root.join("ffmpeg").join("bin").join("ffmpeg.exe"), b"x").unwrap();
    }

    #[test]
    fn looks_complete_needs_torch_scripts_ffmpeg() {
        let dir = scratch("complete");
        let root = dir.join("runtime");
        fs::create_dir_all(&root).unwrap();

        
        fs::write(root.join("python.exe"), b"x").unwrap();
        assert!(!looks_complete(&root), "python.exe saja tidak boleh dianggap utuh");

        
        fs::create_dir_all(root.join("Lib").join("site-packages").join("torch")).unwrap();
        assert!(!looks_complete(&root), "site-packages tanpa Scripts/ffmpeg belum utuh");

        fake_complete(&root);
        assert!(looks_complete(&root), "lengkap harus terdeteksi utuh");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn markers_control_installed_state() {
        let dir = scratch("marker");
        let root = dir.join("runtime");
        fs::create_dir_all(&root).unwrap();
        fake_complete(&root);

        
        assert!(looks_complete(&root));

        
        mark_ready(&root);
        assert!(root.join(READY_MARKER).is_file());
        assert!(!root.join(FAILED_MARKER).is_file());

        
        mark_failed(&root);
        assert!(root.join(FAILED_MARKER).is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_ready_clears_failed() {
        let dir = scratch("clears");
        let root = dir.join("runtime");
        fs::create_dir_all(&root).unwrap();
        mark_failed(&root);
        assert!(root.join(FAILED_MARKER).is_file());
        mark_ready(&root);
        assert!(root.join(READY_MARKER).is_file());
        assert!(!root.join(FAILED_MARKER).is_file(), "sukses harus menghapus marker gagal");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vc_detection_agrees_with_fs() {
        assert_eq!(VC_DLLS.len(), 4, "daftar DLL MSVC harus empat");
        assert!(system32_dir().ends_with("System32"), "pencarian di System32");
        let dir = system32_dir();
        let manual = VC_DLLS.iter().all(|d| dir.join(d).is_file());
        assert_eq!(vc_runtime_present(), manual, "deteksi harus sama dengan cek file langsung");
    }

    
    
    
    
    
    #[test]
    fn vc_list_covers_torch_static_imports() {
        for d in ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcruntime140_threads.dll"] {
            assert!(VC_DLLS.contains(&d), "torch butuh {d} untuk load");
        }
    }
}