//! Runtime portable untuk installer Lite (Fase 3b).
//!
//! Installer Full (Fase 3a) sudah memaketkan runtime, jadi tidak perlu apa-apa.
//! Installer Lite hanya membawa shell aplikasi; saat pertama jalan engine tidak
//! ada karena PC user belum punya Python + torch. Modul ini mengunduh paket
//! runtime dari repo rilis, memverifikasi sha256, lalu mengekstraknya ke
//! `%APPDATA%\VocaLyx\runtime` supaya `engine.rs` memakainya otomatis.
//!
//! Alur: `runtime_status` -> (kalau belum ada) `runtime_install` -> event
//! `runtime://progress` -> `runtime_status` lagi sampai `installed: true`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

pub const PROGRESS_EVENT: &str = "runtime://progress";
const RUNTIME_DIRNAME: &str = "runtime";
const PY_MARKER: &str = "Lib/site-packages";

/// Penanda runtime yang sudah selesai diekstrak utuh.
///
/// Dulu `installed` hanya mengecek `python.exe` + folder `Lib/site-packages`.
/// Itu terlalu dangkal: menutup app saat ekstraksi berjalan bisa meninggalkan
/// dua item itu sudah ada sementara ribuan file lain belum, sehingga banner
/// disembunyikan padahal engine tidak bisa jalan. Marker ini hanya ditulis
/// setelah `extract_zip` selesai tanpa error.
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
    /// Ada `runtime-bundle.zip` di paket installer (installer Full).
    pub bundled: bool,
    /// Ekstraksi terbundul sedang berjalan di thread startup.
    pub extracting: bool,
    /// Ekstraksi terakhir gagal; banner menawarkan ekstrak ulang.
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

/// `%APPDATA%` tempat folder data aplikasi hidup.
fn data_root() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Nama folder data aplikasi. Dulu `NetKara` (nama proyek sebelumnya), lalu
/// diganti ke `VocaLyx` supaya tidak ada sisa nama proyek lama. Data lama
/// dipindahkan sekali oleh `migrate_legacy_data_dir`.
const APP_DIRNAME: &str = "VocaLyx";
const LEGACY_APPNAME: &str = "NetKara";

/// Pindahkan sisa data dari nama folder lama ke yang sekarang.
///
/// Dipakai `rename`, jadi untuk folder 1,9 GB di drive yang sama hanya_metadata
/// yang berubah — tidak ada salinan file. Item yang sudah ada di tujuan tidak
/// ditimpa supaya data terbaru tidak hilang.
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
    // Log lama digabung ke log yang sekarang, bukan dibuang, lalu sumbernya
    // dihapus supaya folder lama benar-benar habis dan tidak menyesatkan.
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
    // Folder lama yang sudah kosong ikut dibuang supaya tidak menyesatkan.
    if fs::read_dir(&legacy).map(|mut d| d.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(&legacy);
    }
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

/// Tanda runtime sudah utuh, dipakai untuk略带-sdk install lama yang belum
/// punya marker: kalau semua penanda besar ada, marker ditulis agar user tidak
/// dipaksa ekstrak ulang 1,9 GB.
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

/// Ekstraksi terakhir gagal. Dipakai supaya banner bisa menawarkan "coba lagi"
/// alih-alih tampil "menyiapkan" selamanya tanpa tombol apa pun.
fn mark_failed(root: &Path) {
    if root.is_dir() {
        let _ = fs::write(root.join(FAILED_MARKER), b"v1\n");
    }
}

/// Status installation. Menyentuh marker berarti `installed` hanya true kalau
/// ekstraksi selesai; instalasi lama yang sudah utuh dituliskan marker-nya di
/// sini supaya tidak perlu ekstrak ulang.
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

    // `build_runtime.py` menulis archive dengan satu folder teratas (`runtime/`)
    // supaya zip bisa dipakai seperti folder biasa. Karena kita ekstrak ke
    // `%APPDATA%\VocaLyx/runtime`, prefix itu harus dilepas; kalau tidak,
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
    if root.join(READY_MARKER).is_file() || looks_complete(&root) {
        if !root.join(READY_MARKER).is_file() {
            mark_ready(&root);
        }
        return Ok(false);
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
    mark_ready(&root);
    emit_progress(app, "done", total, total);
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
    migrate_legacy_data_dir();
    // Ditandai sebelum thread dibuat: kalau tidak, frontend bisa membaca status
    // "tidak sedang apa-apa" tepat di sela sebelum ekstraksi berjalan, lalu
    // menampilkan "menyiapkan" tanpa progres atau tombol apa pun.
    if runtime_root().join(READY_MARKER).is_file() || looks_complete(&runtime_root()) {
        mark_ready(&runtime_root());
    } else if bundled_zip(&app).is_some() {
        EXTRACTING.store(true, Ordering::Relaxed);
    }
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

    /// Susun folder runtime minimal yang dianggap utuh oleh `looks_complete`.
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

        // Hanya python.exe: belum utuh (kasus ekstraksi terputus).
        fs::write(root.join("python.exe"), b"x").unwrap();
        assert!(!looks_complete(&root), "python.exe saja tidak boleh dianggap utuh");

        // Tambah site-packages tapi tanpa Scripts/ffmpeg: masih belum utuh.
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

        // Tanpa marker tapi utuh ->looks_complete true (installer lama).
        assert!(looks_complete(&root));

        // Tulis marker.
        mark_ready(&root);
        assert!(root.join(READY_MARKER).is_file());
        assert!(!root.join(FAILED_MARKER).is_file());

        // Tandai gagal -> marker failed ada (untuk banner "coba lagi").
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
}