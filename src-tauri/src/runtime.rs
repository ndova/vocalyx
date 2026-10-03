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

    // `build_runtime.py` menulis archive dengan satu folder teratas (`runtime/`)
    // supaya zip bisa dipakai seperti folder biasa. Karena kita ekstrak ke
    // `%APPDATA%\NetKara/runtime`, prefix itu harus dilepas; kalau tidak,
    // interpreter mendarat di `runtime/runtime/python.exe` dan `runtime_status`
    // selalu melaporkan runtime belum terpasang.
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

/// Satu folder teratas yang sama untuk semua entri, kalau ada.
///
/// Untuk zip dari `build_runtime.py` hasilnya `Some("runtime")` supaya
/// `extract_zip` melepasnya. Kalau zip sudah datar, entri pertama berbeda-beda
/// sehingga hasilnya `None` dan tidak ada yang dibuang.
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

/// Unduh paket runtime, verifikasi sha256, ekstrak. Perintah Tauri sudah
/// async, jadi jaringan tidak memblokir loop UI.
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

    // `sha256` boleh berupa digest langsung (64 hex) atau URL file `.sha256`.
    // Frontend mengirim URL supaya tidak perlu tahu digest saat build, jadi
    // dua bentuk ini diterima di sini.
    let want = resolve_expected_hash(&client, &sha256).await?;

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

/// Terima digest sha256 langsung (64 hex) atau URL file `.sha256`.
///
/// Releases hanya menaruh file teks berisi `<digest>  <nama file>` (format
/// `sha256sum`), jadi URL harus diunduh lebih dulu. Kalau tidak ada referensi
/// digest, hasilnya `None` dan verifikasi dilewati.
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

/// Ambil token hex 64 karakter pertama, mengabaikan format lain.
fn parse_sha256sum(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(token.to_ascii_lowercase());
        }
    }
    None
}

/// Status prasyarat driver Apple untuk iPhone.
///
/// `pymobiledevice3` bicara lewat usbmux, dan di Windows service itu adalah
/// "Apple Mobile Device Service" yang grudup di 127.0.0.1:27015. Driver-nya
/// berasal dari paket resmi Apple Mobile Device Support / iTunes dan tidak
/// boleh di-bundel ulang (batasan lisensi), jadi kita hanya mendeteksi dan
/// menampilkan panduan, bukan memasangnya diam-diam.
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

fn apple_service_exe() -> PathBuf {
    let base = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Common Files")
        .join("Apple")
        .join("Mobile Device Support")
        .join("AppleMobileDeviceService.exe")
}

#[tauri::command]
pub fn apple_driver_status() -> AppleDriverStatus {
    let listening = apple_usbmux_listening();
    let executable = apple_service_exe().is_file();
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
                "runtime/engine/server.py",
                "runtime/Lib/site-packages/torch/__init__.py",
            ],
        );
        let out = dir.join("out");
        let n = extract_zip(&zip_path, &out).unwrap();
        assert_eq!(n, 4, "semua file harus ikut terekstrak");
        assert!(out.join("python.exe").is_file(), "prefix harus dilepas");
        assert!(out.join("engine/server.py").is_file());
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
}