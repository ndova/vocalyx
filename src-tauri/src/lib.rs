use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lofty::prelude::*;
use lofty::probe::Probe;
use serde::Serialize;
use std::path::Path;
use tauri::Manager;

mod engine;
mod runtime;
mod smtc;

#[derive(Debug, Serialize, Clone)]
pub struct TrackMeta {
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub ext: String,
    pub size: u64,
    pub size_str: String,
    pub dur: String,
    pub duration: Option<f64>,
    pub lyric_path: Option<String>,
    pub cover: Option<String>,
    pub karaoke_path: Option<String>,
}

const SUPPORTED: [&str; 6] = ["mp3", "m4a", "aac", "wav", "flac", "ogg"];

fn is_artifact_name(name_l: &str) -> bool {
    name_l.contains(".enh.tmp.")
        || name_l.contains(".dz.tmp.")
        || name_l.contains(".prem.")
        || name_l.contains(".tmp.")
        || name_l.contains(".tmp dl")
        || name_l.contains(".part")
        || name_l.contains(".ytdl")
}

fn try_find_stem(parent: &Path, stem: &str) -> Option<String> {
    let same = parent.join(format!("{}.lrc", stem));
    if same.exists() {
        return Some(same.to_string_lossy().to_string());
    }
    for folder_name in ["Lyrics", "lyrics", "LYRICS", "Lirik", "lirik"] {
        let cand = parent.join(folder_name).join(format!("{}.lrc", stem));
        if cand.exists() {
            return Some(cand.to_string_lossy().to_string());
        }
        let dir = parent.join(folder_name);
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.filter_map(|e| e.ok()) {
                    let p = e.path();
                    if p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase() == "lrc").unwrap_or(false) {
                        if let Some(s) = p.file_stem().and_then(|s| s.to_str()) {
                            if s.eq_ignore_ascii_case(stem) {
                                return Some(p.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn find_lyric_for_track(track_path: &Path) -> Option<String> {
    let stem = track_path.file_stem()?.to_str()?;
    let parent = track_path.parent()?;
    if let Some(p) = try_find_stem(parent, stem) {
        return Some(p);
    }
    if let Some((_, title)) = stem.split_once(" - ") {
        let title = title.trim();
        if !title.is_empty() {
            if let Some(p) = try_find_stem(parent, title) {
                return Some(p);
            }
        }
    }
    let normalized = stem.trim();
    if normalized != stem {
        if let Some(p) = try_find_stem(parent, normalized) {
            return Some(p);
        }
    }
    None
}

fn extract_cover(path: &Path) -> Option<String> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged
        .primary_tag()
        .or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().iter().max_by_key(|p| p.data().len())?;
    let mime = pic
        .mime_type()
        .map(|m| m.as_str())
        .unwrap_or("image/jpeg");
    let b64 = BASE64.encode(pic.data());
    Some(format!("data:{};base64,{}", mime, b64))
}

fn extract_album(path: &Path) -> String {
    Probe::open(path)
        .ok()
        .and_then(|p| p.read().ok())
        .and_then(|tagged| {
            let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
            tag.album().map(|a| a.trim().to_string())
        })
        .filter(|a| !a.is_empty())
        .unwrap_or_default()
}

fn extract_duration(path: &Path) -> (Option<f64>, String) {
    if let Ok(tagged) = Probe::open(path).and_then(|p| p.read()) {
        let dur = tagged.properties().duration();
        let secs = dur.as_secs_f64();
        if secs > 0.0 && secs < 36000.0 {
            let s = secs as u64;
            let m = s / 60;
            let sec = s % 60;
            return (Some(secs), format!("{}:{:02}", m, sec));
        }
    }
    (None, "--:--".to_string())
}

fn find_karaoke_for_track(track_path: &Path) -> Option<String> {
    let stem = track_path.file_stem()?.to_str()?;
    let parent = track_path.parent()?;
    let mdx_dir = {
        let direct = parent.join("mdx_extra");
        if direct.exists() {
            Some(direct)
        } else {
            let mut found = None;
            if let Ok(entries) = std::fs::read_dir(parent) {
                for e in entries.filter_map(|e| e.ok()) {
                    let p = e.path();
                    if p.is_dir() {
                        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                            if name.eq_ignore_ascii_case("mdx_extra") {
                                found = Some(p);
                                break;
                            }
                        }
                    }
                }
            }
            found
        }
    }?;
    let try_stem = |s: &str| -> Option<std::path::PathBuf> {
        let cand = mdx_dir.join(s);
        if cand.exists() && cand.is_dir() {
            return Some(cand);
        }
        if let Ok(entries) = std::fs::read_dir(&mdx_dir) {
            for e in entries.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() {
                    if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
                        if n.eq_ignore_ascii_case(s) {
                            return Some(p);
                        }
                    }
                }
            }
        }
        None
    };
    let track_dir = try_stem(stem).or_else(|| {
        if let Some((_, title)) = stem.split_once(" - ") {
            try_stem(title.trim())
        } else {
            None
        }
    })?;
    let mut best: Option<(u8, std::path::PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(&track_dir) {
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            if !["flac", "wav", "mp3", "m4a", "ogg"].contains(&ext.as_str()) {
                continue;
            }
            if !fname.contains("no_vocals") && !fname.contains("no-vocals") && !fname.contains("instrumental") {
                continue;
            }
            let priority = match ext.as_str() {
                "flac" => 4,
                "wav" => 3,
                "ogg" => 2,
                "mp3" => 1,
                _ => 0,
            };
            if best.as_ref().map_or(true, |(pr, _)| priority > *pr) {
                best = Some((priority, p));
            }
        }
        if best.is_none() {
            let audio_files: Vec<_> = std::fs::read_dir(&track_dir)
                .ok()?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && p.extension()
                            .and_then(|s| s.to_str())
                            .map(|s| ["flac", "wav", "mp3", "m4a", "ogg"].contains(&s.to_lowercase().as_str()))
                            .unwrap_or(false)
                })
                .collect();
            if audio_files.len() == 1 {
                best = Some((0, audio_files[0].clone()));
            }
        }
    }
    best.map(|(_, p)| p.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_music(dir: String) -> Vec<TrackMeta> {
    let mut out = Vec::new();
    let root = Path::new(&dir);
    if !root.exists() {
        return out;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !SUPPORTED.contains(&ext.as_str()) {
            continue;
        }
        let name_l = p
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if is_artifact_name(&name_l) {
            continue;
        }
        let file_name = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();
        let (artist, title) = if let Some((a, t)) = file_name.split_once(" - ") {
            (a.trim().to_string(), t.trim().to_string())
        } else {
            ("Unknown".to_string(), file_name.clone())
        };
        let lyric_path = find_lyric_for_track(&p);
        let cover = extract_cover(&p);
        let album = extract_album(&p);
        let karaoke_path = find_karaoke_for_track(&p);
        let (size, size_str) = match std::fs::metadata(&p) {
            Ok(m) => {
                let s = m.len();
                let fmt = if s >= 1024 * 1024 {
                    format!("{:.1} MB", s as f64 / (1024.0 * 1024.0))
                } else if s >= 1024 {
                    format!("{:.0} KB", s as f64 / 1024.0)
                } else {
                    format!("{} B", s)
                };
                (s, fmt)
            }
            Err(_) => (0, "--".to_string()),
        };
        let (duration, dur) = extract_duration(&p);
        out.push(TrackMeta {
            path: p.to_string_lossy().to_string(),
            file_name,
            title,
            artist,
            album,
            ext,
            size,
            size_str,
            dur,
            duration,
            lyric_path,
            cover,
            karaoke_path,
        });
    }
    out.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    out
}

#[tauri::command]
fn save_lyric(track_path: String, lrc_text: String) -> Result<String, String> {
    let track = Path::new(&track_path);
    let parent = track.parent().ok_or_else(|| "parent folder not found".to_string())?;
    let stem = track
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "file stem not found".to_string())?;
    let lyrics_dir = parent.join("Lyrics");
    std::fs::create_dir_all(&lyrics_dir).map_err(|e| format!("create Lyrics folder failed: {}", e))?;
    let save_path = lyrics_dir.join(format!("{}.lrc", stem));
    std::fs::write(&save_path, lrc_text).map_err(|e| format!("write .lrc failed: {}", e))?;
    Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_lyric_to(target_path: String, lrc_text: String) -> Result<String, String> {
    let target = Path::new(&target_path);
    if target.file_name().is_none() {
        return Err("target path has no file name".to_string());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create parent folder failed: {}", e))?;
        }
    }
    std::fs::write(target, lrc_text).map_err(|e| format!("write .lrc failed: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn save_karaoke(track_path: String, b64_data: String, ext: String) -> Result<String, String> {
    let track = Path::new(&track_path);
    let parent = track.parent().ok_or_else(|| "parent folder not found".to_string())?;
    let stem = track
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "file stem not found".to_string())?;
    let mdx_dir = parent.join("mdx_extra");
    let track_dir = mdx_dir.join(stem);
    std::fs::create_dir_all(&track_dir).map_err(|e| format!("create mdx_extra folder failed: {}", e))?;
    let save_path = track_dir.join(format!("no_vocals.{}", ext.to_lowercase()));
    let data = BASE64
        .decode(b64_data.trim())
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    std::fs::write(&save_path, data).map_err(|e| format!("write karaoke failed: {}", e))?;
    Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
fn smtc_available(window: tauri::Window) -> bool {
    smtc::ensure_init(&window)
}

#[tauri::command]
fn smtc_set_metadata(
    title: String,
    artist: String,
    album: String,
    cover: String,
    duration_secs: f64,
) {
    smtc::set_metadata(&title, &artist, &album, &cover, duration_secs);
}

#[tauri::command]
fn smtc_set_playback(playing: bool, position_secs: f64) {
    smtc::set_playback(playing, position_secs);
}

#[tauri::command]
fn cleanup_artifacts(dir: String, min_age_secs: u64) -> Vec<String> {
    let mut removed = Vec::new();
    if dir.trim().is_empty() {
        return removed;
    }
    let root = Path::new(&dir);
    if !root.is_dir() {
        return removed;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return removed,
    };
    let now = std::time::SystemTime::now();
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name_l = p
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !is_artifact_name(&name_l) {
            continue;
        }
        let age_ok = p
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mt| now.duration_since(mt).ok())
            .map(|d| d.as_secs() >= min_age_secs)
            .unwrap_or(false);
        if !age_ok {
            continue;
        }
        if std::fs::remove_file(&p).is_ok() {
            removed.push(p.to_string_lossy().to_string());
        }
    }
    removed
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::Engine::new())
        .manage(engine::EngineChoice::new())
        .invoke_handler(tauri::generate_handler![
            scan_music,
            save_lyric,
            write_lyric_to,
            save_karaoke,
            cleanup_artifacts,
            smtc_available,
            smtc_set_metadata,
            smtc_set_playback,
            runtime::runtime_status,
            runtime::runtime_install,
            runtime::runtime_remove,
            runtime::runtime_extract_bundled,
            runtime::apple_driver_status,
            engine::detect_pythons,
            engine::detect_pythons_async,
            engine::get_engine_config,
            engine::set_engine_config
        ])
        .setup(|app| {
            runtime::spawn_ensure_and_start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building VocaLyx")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<engine::Engine>() {
                    state.shutdown();
                }
            }
        });
}
