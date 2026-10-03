//! Runtime portable untuk installer Lite (Fase 3b).
//!
//! Installer Full (Fase 3a) sudah memaketkan runtime, jadi tidak perlu apa-apa.
//! Installer Lite hanya membawa shell aplikasi; saat pertama jalan engine tidak
//! ada karena PC user belum punya Python + torch. Modul ini mengunduh paket
//! runtime dari repo rilis, memverifikasi sha256, lalu mengekstraknya ke
//! `%APPDATA%\NetKara\runtime` supaya `engine.rs` memakainya otomatis.
//!
//! Alur: `runtime_status` -> (kalau belum ada) `runtime_install` -> event
//! `runtime://progress` -> `runtime_status` lagi sampai `installed: true`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

pub const PROGRESS_EVENT: &str = "runtime://progress";
const RUNTIME_DIRNAME: &str = "runtime";
const PY_MARKER: &str = "Lib/site-packages";

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub installed: bool,
    pub variant: String,
    pub path: String,
    pub python: bool,
    pub engine: bool,
    pub cuda: bool,
}

#[derive(Serialize, Clone)]
pub struct Progress {
    pub received: u64,
    pub total: u64,
    pub percent: f64,
    pub stage: String,
}

fn app_data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("NetKara")
}

pub fn runtime_root() -> PathBuf {
    app_data_dir().join(RUNTIME_DIRNAME)
}

/// Terpasang kalau ada interpreter. `engine` dicek terpisah supaya UI bisa
/// membedakan "runtime ada tapi engine gagal" dari "runtime belum diunduh".
fn python_ok(root: &Path) -> bool {
    root.join("python.exe").is_file() || root.join("pythonw.exe").is_file()
}

fn site_packages_ok(root: &Path) -> bool {
    root.join(PY_MARKER).is_dir()
}

fn engine_ok(root: &Path) -> bool {
    root.join("engine").join("server.py").is_file()
}

fn cuda_available(root: &Path) -> bool {
    root.join("Lib")
        .join("site-packages")
        .join("nvidia")
        .is_dir()
}

#[tauri::command]
pub fn runtime_status() -> RuntimeStatus {
    let root = runtime_root();
    let installed = python_ok(&root) && site_packages_ok(&root);
    RuntimeStatus {
        installed,
        variant: if cuda_available(&root) { "cuda" } else { "cpu" }.to_string(),
        path: root.to_string_lossy().to_string(),
        python: python_ok(&root),
        engine: engine_ok(&root),
        cuda: cuda_available(&root),
    }
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
    fs::create_dir_all(dest).map_err(|e| format!("gagal buat folder: {e}"))?;
    let mut count = 0u64;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(rel) = entry.enclosed_name() else { continue };
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

/// Unduh paket runtime, verifikasi sha256, ekstrak. Perintah Tauri sudah
/// async, jadi jaringan tidak memblokir loop UI.
#[tauri::command]
pub async fn runtime_install(app: AppHandle, url: String, sha256: String) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("URL runtime kosong".to_string());
    }
    let want = sha256.trim().to_ascii_lowercase();
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
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("gagal mengunduh runtime: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("server membalas {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let tmp = zip_path.with_extension("part");
    let mut file = fs::File::create(&tmp).map_err(|e| format!("gagal buat file: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut received = 0u64;
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("unduhan terputus: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("gagal menulis: {e}"))?;
        received += chunk.len() as u64;
        if received % (4 * 1024 * 1024) < chunk.len() as u64 {
            emit(received, total, "download");
        }
    }
    file.flush().ok();
    drop(file);
    emit(received, total, "verify");

    if !want.is_empty() {
        let got = sha256_file(&tmp)?;
        if got != want {
            let _ = fs::remove_file(&tmp);
            return Err(format!("sha256 tidak cocok (harap: {want}, dapat: {got})"));
        }
    }
    let _ = fs::remove_file(&root);
    emit(received, total, "extract");
    extract_zip(&tmp, &root)?;
    let _ = fs::remove_file(&tmp);
    if !python_ok(&root) || !site_packages_ok(&root) {
        return Err("paket runtime ter ekstrak tapi python/site-packages tidak ditemukan".to_string());
    }
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

/// Lokasi zip runtime yang ikut dipaketkan installer Full.
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

/// Ekstrak runtime yang sudah dipaketkan. Dipakai installer Full supaya user
/// tidak perlu mengunduh apa pun; installer Lite tidak punya file ini sehingga
/// fungsi ini diam-diam dilewati dan banner unduh yang bekerja.
pub fn extract_bundled(app: &AppHandle) -> Result<bool, String> {
    let root = runtime_root();
    if python_ok(&root) && site_packages_ok(&root) {
        return Ok(false);
    }
    let Some(zip) = bundled_zip(app) else {
        return Ok(false);
    };
    let total = fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
    emit_progress(app, "extract", 0, total);
    let _ = fs::remove_dir_all(&root);
    extract_zip(&zip, &root)?;
    emit_progress(app, "done", total, total);
    if !python_ok(&root) || !site_packages_ok(&root) {
        return Err("runtime ter-ekstrak tapi python/site-packages tidak ditemukan".to_string());
    }
    Ok(true)
}

/// Command untuk dipakai frontend (mis. tombol "Pasang sekarang").
#[tauri::command]
pub fn runtime_extract_bundled(app: AppHandle) -> Result<bool, String> {
    extract_bundled(&app)
}

/// Dipanggil sekali saat start: ekstrak runtime terbundul bila ada, lalu start
/// engine. Dijalankan di thread terpisah supaya jendela tetap responsif saat
/// ekstrak ~1.9 GB pada installer Full.
pub fn spawn_ensure_and_start(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        match extract_bundled(&app) {
            Ok(true) => crate::engine::write_log_note("runtime terbundul diekstrak"),
            Ok(false) => {}
            Err(e) => crate::engine::write_log_note(&format!("runtime terbundul gagal: {e}")),
        }
        crate::engine::start(&app);
    });
}