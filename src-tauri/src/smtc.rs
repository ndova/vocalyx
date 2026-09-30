use std::sync::Mutex;
use tauri::Window;

static SMTC_READY: Mutex<bool> = Mutex::new(false);

pub fn ensure_init(window: &Window) -> bool {
    if *SMTC_READY.lock().unwrap_or_else(|e| e.into_inner()) {
        return true;
    }
    if imp::init(window) {
        *SMTC_READY.lock().unwrap_or_else(|e| e.into_inner()) = true;
        return true;
    }
    false
}

pub fn set_metadata(title: &str, artist: &str, album: &str, cover: &str, duration_secs: f64) {
    imp::set_metadata(title, artist, album, cover, duration_secs);
}

pub fn set_playback(playing: bool, position_secs: f64) {
    imp::set_playback(playing, position_secs);
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use souvlaki::{
        MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
        SeekDirection,
    };
    use std::time::Duration;
    use tauri::Emitter;

    static CONTROLS: Mutex<Option<MediaControls>> = Mutex::new(None);

    struct OwnedMeta {
        title: String,
        artist: String,
        album: String,
        cover_uri: String,
        duration_secs: f64,
    }
    static LAST_META: Mutex<OwnedMeta> = Mutex::new(OwnedMeta {
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        cover_uri: String::new(),
        duration_secs: 0.0,
    });

    fn hwnd_of(window: &Window) -> Option<*mut std::ffi::c_void> {
        let handle = window.window_handle().ok()?;
        match handle.as_raw() {
            RawWindowHandle::Win32(h) => Some(h.hwnd.get() as *mut std::ffi::c_void),
            _ => None,
        }
    }

    fn cover_uri_for(cover: &str) -> Option<String> {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        let c = cover.trim();
        if c.is_empty() {
            return None;
        }
        if c.starts_with("http://") || c.starts_with("https://") || c.starts_with("file://") {
            return Some(c.to_string());
        }
        let (head, b64) = c.split_once(',')?;
        let mime = head.split(';').next().unwrap_or("");
        let ext = if mime.contains("png") {
            "png"
        } else if mime.contains("webp") {
            "webp"
        } else {
            "jpg"
        };
        let bytes = BASE64.decode(b64.trim()).ok()?;
        if bytes.is_empty() {
            return None;
        }
        let path = std::env::temp_dir().join(format!("vocalyx-cover.{ext}"));
        std::fs::write(&path, &bytes).ok()?;
        let s = path.to_string_lossy().replace('\\', "/");
        Some(format!("file:///{}", s.trim_start_matches('/')))
    }

    pub(super) fn init(window: &Window) -> bool {
        if CONTROLS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            return true;
        }
        let hwnd = match hwnd_of(window) {
            Some(h) => h,
            None => return false,
        };
        let mut controls = match MediaControls::new(PlatformConfig {
            dbus_name: "vocalyx",
            display_name: "VocaLyx",
            hwnd: Some(hwnd),
        }) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let win = window.clone();
        let attached = controls
            .attach(move |ev: MediaControlEvent| {
                let (action, position): (&str, Option<f64>) = match ev {
                    MediaControlEvent::Play => ("play", None),
                    MediaControlEvent::Pause => ("pause", None),
                    MediaControlEvent::Toggle => ("toggle", None),
                    MediaControlEvent::Stop => ("stop", None),
                    MediaControlEvent::Next => ("next", None),
                    MediaControlEvent::Previous => ("prev", None),
                    MediaControlEvent::Seek(SeekDirection::Forward) => ("seek-fwd", None),
                    MediaControlEvent::Seek(SeekDirection::Backward) => ("seek-back", None),
                    MediaControlEvent::SeekBy(SeekDirection::Forward, d) => {
                        ("seek-by", Some(d.as_secs_f64()))
                    }
                    MediaControlEvent::SeekBy(SeekDirection::Backward, d) => {
                        ("seek-by", Some(-d.as_secs_f64()))
                    }
                    MediaControlEvent::SetPosition(p) => ("seek-to", Some(p.0.as_secs_f64())),
                    _ => return,
                };
                let _ = win.emit(
                    "smtc-button",
                    serde_json::json!({ "action": action, "position": position }),
                );
            })
            .is_ok();
        if !attached {
            return false;
        }
        *CONTROLS.lock().unwrap_or_else(|e| e.into_inner()) = Some(controls);
        true
    }

    pub(super) fn set_metadata(
        title: &str,
        artist: &str,
        album: &str,
        cover: &str,
        duration_secs: f64,
    ) {
        let cover_uri = cover_uri_for(cover).unwrap_or_default();
        let mut meta = LAST_META.lock().unwrap_or_else(|e| e.into_inner());
        meta.title = title.to_string();
        meta.artist = artist.to_string();
        meta.album = album.to_string();
        meta.cover_uri = cover_uri;
        meta.duration_secs = if duration_secs.is_finite() && duration_secs > 0.0 {
            duration_secs
        } else {
            0.0
        };
        let md = MediaMetadata {
            title: if meta.title.is_empty() {
                None
            } else {
                Some(meta.title.as_str())
            },
            artist: if meta.artist.is_empty() {
                None
            } else {
                Some(meta.artist.as_str())
            },
            album: if meta.album.is_empty() {
                None
            } else {
                Some(meta.album.as_str())
            },
            cover_url: if meta.cover_uri.is_empty() {
                None
            } else {
                Some(meta.cover_uri.as_str())
            },
            duration: if meta.duration_secs > 0.0 {
                Some(Duration::from_secs_f64(meta.duration_secs))
            } else {
                None
            },
        };
        if let Some(c) = CONTROLS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            let _ = c.set_metadata(md);
        }
    }

    pub(super) fn set_playback(playing: bool, position_secs: f64) {
        let progress = if position_secs.is_finite() && position_secs >= 0.0 {
            Some(MediaPosition(Duration::from_secs_f64(position_secs)))
        } else {
            None
        };
        let status = if playing {
            MediaPlayback::Playing { progress }
        } else {
            MediaPlayback::Paused { progress }
        };
        if let Some(c) = CONTROLS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            let _ = c.set_playback(status);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::Window;

    pub(super) fn init(_window: &Window) -> bool {
        false
    }

    pub(super) fn set_metadata(
        _title: &str,
        _artist: &str,
        _album: &str,
        _cover: &str,
        _duration_secs: f64,
    ) {
    }

    pub(super) fn set_playback(_playing: bool, _position_secs: f64) {}
}
