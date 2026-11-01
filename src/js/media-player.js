// Popup media player for iPhone (Device) music + video, and local music/video files.
// Uses a compact custom control bar (mini player style) instead of bulky native controls.

import { t } from './i18n/core.js';
import { showToast } from './engine.js';
import { escAttr } from './format.js';

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'wma', 'opus', 'm4b']);
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'mpeg', 'mpg']);

let _refs = null;
let _row = null;
let _mediaEl = null;   // current active <audio> or <video>
let _seekDragging = false;
let _volDragging = false;
let _updateTimer = null;
let _durationTimeout = null;

function refs() {
  if (_refs) return _refs;
  _refs = {
    modal: document.getElementById('mediaPlayerModal'),
    backdrop: document.getElementById('mediaPlayerBackdrop'),
    close: document.getElementById('mediaPlayerClose'),
    title: document.getElementById('mediaPlayerTitle'),
    meta: document.getElementById('mediaPlayerMeta'),
    sub: document.getElementById('mediaPlayerSub'),
    art: document.getElementById('mediaPlayerArt'),
    audio: document.getElementById('mediaPlayerAudio'),
    video: document.getElementById('mediaPlayerVideo'),
    bar: document.getElementById('mediaBar'),
    btnPlay: document.getElementById('mediaBtnPlay'),
    btnVol: document.getElementById('mediaBtnVol'),
    btnMore: document.getElementById('mediaBtnMore'),
    icoPlay: document.querySelector('.media-ico-play'),
    icoPause: document.querySelector('.media-ico-pause'),
    timeCur: document.getElementById('mediaTimeCur'),
    timeDur: document.getElementById('mediaTimeDur'),
    seek: document.getElementById('mediaSeek'),
    vol: document.getElementById('mediaVol'),
  };
  if (_refs.modal && !_refs.modal.dataset.wired) {
    _refs.modal.dataset.wired = '1';
    wireEvents();
  }
  return _refs;
}

function wireEvents() {
  const r = refs();
  // Close actions.
  r.close?.addEventListener('click', () => closeMediaPlayer());
  r.backdrop?.addEventListener('click', () => closeMediaPlayer());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _refs.modal?.classList.contains('open')) closeMediaPlayer();
  });

  // Play / pause.
  r.btnPlay?.addEventListener('click', () => togglePlay());

  // Volume toggle (click) / slider (drag).
  r.btnVol?.addEventListener('click', () => toggleMute());
  r.vol?.addEventListener('input', (e) => setVolume(Number(r.vol.value)));
  r.vol?.addEventListener('mousedown', () => { _volDragging = true; });
  r.vol?.addEventListener('mouseup', () => { _volDragging = false; });
  r.vol?.addEventListener('mouseleave', () => { _volDragging = false; });

  // Seek bar drag.
  r.seek?.addEventListener('input', (e) => {
    if (!_mediaEl) return;
    _seekDragging = true;
    const pct = Number(r.seek.value) / 100;
    r.seek.style.background = `linear-gradient(to right, var(--accent) 0 var(--p,${pct * 100}%), var(--line) var(--p,${pct * 100}%) 100%)`;
  });
  r.seek?.addEventListener('change', (e) => {
    if (!_mediaEl) return;
    _seekDragging = false;
    const pct = Number(r.seek.value) / 100;
    _mediaEl.currentTime = pct * _mediaEl.duration;
  });
  r.seek?.addEventListener('mousedown', () => { _seekDragging = true; });
  r.seek?.addEventListener('mouseup', () => { _seekDragging = false; });
  r.seek?.addEventListener('mouseleave', () => { _seekDragging = false; });

  // Error -> detailed toast + popup message.
  const fail = (el) => {
    const detail = _mediaErrorDetail(el);
    console.error('[media-player] media error:', { detail, src: el && el.currentSrc, title: r.title?.textContent });
    showToast(
      t('player.playFail', { n: r.title?.textContent || '' }) +
      (detail ? ` — ${detail}` : ''), 8000);
    r.sub.textContent = detail || t('player.playFail', { n: r.title?.textContent || '' });
  };
  r.audio?.addEventListener('error', () => fail(r.audio));
  r.video?.addEventListener('error', () => fail(r.video));
}

function _stop(el) {
  if (!el) return;
  try { el.pause(); } catch {}
  try { el.removeAttribute('src'); el.load(); } catch {}
}

function _fmtTime(sec) {
  const n = Number(sec || 0);
  if (!isFinite(n) || n < 0) return '0:00';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function _fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const _MEDIA_ERR = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src_not_supported' };
function _mediaErrorDetail(el) {
  const err = el && el.error;
  if (!err) return '';
  return [_MEDIA_ERR[err.code] || `code ${err.code}`, err.message]
    .filter(Boolean).join(' — ');
}

function extOf(pathOrName) {
  const dot = String(pathOrName || '').lastIndexOf('.');
  return dot >= 0 ? String(pathOrName).slice(dot + 1).toLowerCase() : '';
}

export function isVideoExt(ext) { return VIDEO_EXTS.has(String(ext || '').toLowerCase()); }
export function isAudioExt(ext) { return AUDIO_EXTS.has(String(ext || '').toLowerCase()); }

async function mediaUrlForPath(path) {
  if (!path) return path;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    // Tauri's convertFileSrc already encodeURIComponent()s the whole path
    // (C:\x\y [720p].mp4 -> http://asset.localhost/C%3A%5Cx%5Cy%20%5B720p%5D.mp4).
    // Re-encoding here used to turn %5C into %255C, so the asset protocol
    // could no longer find the file and every local video/audio failed.
    return convertFileSrc(path);
  } catch {}
  return path;
}

function _placeholder(text) {
  const s = String(text || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `<div class="media-art-ph" style="background: hsl(${hue} 55% 22%); color: hsl(${hue} 70% 85%);">${s[0].toUpperCase()}</div>`;
}

function setPlayIcon(playing) {
  const r = refs();
  if (!r.icoPlay || !r.icoPause) return;
  r.icoPlay.style.display = playing ? 'none' : 'block';
  r.icoPause.style.display = playing ? 'block' : 'none';
}

function updateTimes() {
  const r = refs();
  if (!_mediaEl) return;
  const cur = _mediaEl.currentTime || 0;
  const dur = _mediaEl.duration || 0;
  r.timeCur.textContent = _fmtTime(cur);
  r.timeDur.textContent = _fmtTime(dur);
  if (!_seekDragging && dur > 0) {
    const pct = cur / dur;
    r.seek.value = (pct * 100).toFixed(2);
    r.seek.style.background = `linear-gradient(to right, var(--accent) 0 ${pct * 100}%, var(--line) ${pct * 100}% 100%)`;
  }
}

function startTimeLoop() {
  stopTimeLoop();
  _updateTimer = setInterval(() => {
    if (_mediaEl && !_seekDragging) updateTimes();
    if (_mediaEl && _mediaEl.ended) {
      stopTimeLoop();
      setPlayIcon(false);
    }
  }, 250);
}

function stopTimeLoop() {
  if (_updateTimer) { clearInterval(_updateTimer); _updateTimer = null; }
  if (_durationTimeout) { clearTimeout(_durationTimeout); _durationTimeout = null; }
}

async function togglePlay() {
  const r = refs();
  if (!_mediaEl) return;
  try {
    if (_mediaEl.paused) {
      await _mediaEl.play();
    } else {
      _mediaEl.pause();
    }
  } catch (e) {
    showToast(t('player.playFail', { n: r.title?.textContent || '' }), 6000);
  }
}

function toggleMute() {
  const r = refs();
  if (!_mediaEl) return;
  _mediaEl.muted = !_mediaEl.muted;
  updateVolUI();
}

function setVolume(v) {
  const r = refs();
  if (!_mediaEl) return;
  v = Math.max(0, Math.min(1, v));
  _mediaEl.volume = v;
  _mediaEl.muted = v === 0;
  r.vol.value = v;
  updateVolUI();
}

function updateVolUI() {
  const r = refs();
  if (!_mediaEl || !r.btnVol) return;
  const vol = _mediaEl.muted ? 0 : _mediaEl.volume;
  r.vol.value = vol;
}

function startMediaEvents(el) {
  if (!el || el.dataset.mediaWired === '1') return;
  el.dataset.mediaWired = '1';
  el.addEventListener('loadedmetadata', () => {
    updateTimes();
    // Clear any pending duration timeout now that metadata loaded.
    if (_durationTimeout) { clearTimeout(_durationTimeout); _durationTimeout = null; }
  });
  el.addEventListener('timeupdate', () => { if (!_seekDragging) updateTimes(); });
  el.addEventListener('durationchange', () => { updateTimes(); });
  el.addEventListener('play', () => { setPlayIcon(true); startTimeLoop(); });
  el.addEventListener('pause', () => { setPlayIcon(false); stopTimeLoop(); });
  el.addEventListener('ended', () => { setPlayIcon(false); stopTimeLoop(); });
  el.addEventListener('error', () => {
    const r = refs();
    const detail = _mediaErrorDetail(el);
    console.error('[media-player] media error:', { detail, src: el.currentSrc, title: r.title?.textContent });
    showToast(
      t('player.playFail', { n: r.title?.textContent || '' }) +
      (detail ? ` — ${detail}` : ''), 8000);
    r.sub.textContent = detail || t('player.playFail', { n: r.title?.textContent || '' });
    setPlayIcon(false);
    stopTimeLoop();
  });
}

function stopMediaEvents(el) {
  // Intentionally no-op: listeners are wired once per element and reused.
}

export function closeMediaPlayer() {
  const r = refs();
  if (!r.modal) return;
  stopTimeLoop();
  if (_mediaEl) { _stop(_mediaEl); _mediaEl = null; }
  if (r.audio) r.audio.style.display = 'none';
  if (r.video) r.video.style.display = 'none';
  r.modal.classList.remove('open');
  r.modal.setAttribute('aria-hidden', 'true');
  if (_row) { _row.classList.remove('playing'); _row = null; }
  document.querySelectorAll('.track.playing').forEach((el) => el.classList.remove('playing'));
  setPlayIcon(false);
  if (r.seek) { r.seek.value = '0'; r.seek.style.background = ''; }
  if (r.timeCur) r.timeCur.textContent = '0:00';
  if (r.timeDur) r.timeDur.textContent = '0:00';
  if (r.meta) r.meta.textContent = '';
  if (r.sub) r.sub.textContent = '';
}

export async function openMediaPlayer(item, opts = {}) {
  if (!item) return;
  const r = refs();
  if (!r.modal) return;

  const title = String(item.title || item.name || 'Media');
  const path = item.path || item.full_path || '';
  const size = item.file_size || item.size || 0;
  const ext = extOf(path || item.ext || item.name || '');
  const isVideo = !!opts.isVideo || isVideoExt(ext);

  // Reset whatever was open (keeps one player instance at a time).
  closeMediaPlayer();

  r.title.textContent = title;
  r.meta.textContent = [item.artist, item.album].filter(Boolean).join(' • ');
  r.sub.textContent = '';
  r.modal.classList.add('open');
  r.modal.setAttribute('aria-hidden', 'false');
  r.bar.style.display = 'flex';

  if (path && !item.item_pid && !item.id) {
    // LOCAL FILE: stream via Tauri convertFileSrc.
    const src = await mediaUrlForPath(path);
    const info = [item.album, _fmtSize(size)].filter(Boolean).join(' • ') || t('player.loadingLocal');
    // Show metadata before playback starts, so a later error message is not
    // overwritten by this line.
    r.sub.textContent = info;

    if (isVideo) {
      r.art.style.display = 'none';
      r.art.innerHTML = '';
      r.audio.style.display = 'none';
      r.video.style.display = '';
      r.video.poster = item.cover || '';
      r.video.src = src;
      _mediaEl = r.video;
      startMediaEvents(r.video);
      try { await r.video.play(); } catch {}
      updateTimes();

      // If duration is still 0 after 3 seconds, the codec or URL is likely
      // unsupported. Only warn when no real error has been shown meanwhile.
      _durationTimeout = setTimeout(() => {
        if (_mediaEl === r.video && r.video.duration === 0 && !r.video.ended
            && !r.video.error && r.sub.textContent === info) {
          r.sub.textContent = t('player.codecUnsupported', { n: title });
        }
      }, 3000);
    } else {
      r.video.style.display = 'none';
      r.audio.style.display = '';
      r.art.style.display = '';
      if (item.cover) {
        r.art.innerHTML = `<img src="${escAttr(item.cover)}" alt="cover" />`;
        const img = r.art.querySelector('img');
        if (img) img.onerror = () => { r.art.innerHTML = _placeholder(title); };
      } else {
        r.art.innerHTML = _placeholder(title);
      }
      r.audio.src = src;
      _mediaEl = r.audio;
      startMediaEvents(r.audio);
      try { await r.audio.play(); } catch {}
      updateTimes();
    }
  } else {
    // IPHONE DEVICE file (existing behaviour: stream via engine).
    const pid = Number(item.item_pid || item.id || 0);
    if (!pid) {
      r.sub.textContent = t('player.playFail', { n: title });
      r.bar.style.display = 'none';
      return;
    }
    const q = `item_pid=${pid}&v=${Number(item.file_size || 0)}`;
    const src = `http://127.0.0.1:8001/iphone/track/file?${q}`;
    const cover = `http://127.0.0.1:8001/iphone/track/cover?${q}`;

    if (isVideo) {
      r.art.style.display = 'none';
      r.art.innerHTML = '';
      r.audio.style.display = 'none';
      r.video.style.display = '';
      r.video.poster = cover;
      r.video.src = src;
      _mediaEl = r.video;
      startMediaEvents(r.video);
      try { await r.video.play(); } catch {}
      updateTimes();

      _durationTimeout = setTimeout(() => {
        if (_mediaEl === r.video && r.video.duration === 0 && !r.video.ended
            && !r.video.error && !r.sub.textContent) {
          r.sub.textContent = t('player.codecUnsupported', { n: title });
        }
      }, 3000);
    } else {
      r.video.style.display = 'none';
      r.audio.style.display = '';
      r.art.style.display = '';
      r.art.innerHTML = `<img src="${cover}" alt="cover" />`;
      const img = r.art.querySelector('img');
      if (img) img.onerror = () => { r.art.innerHTML = _placeholder(title); };
      r.audio.src = src;
      _mediaEl = r.audio;
      startMediaEvents(r.audio);
      try { await r.audio.play(); } catch {}
      updateTimes();
    }
    r.sub.textContent = '';
  }

  if (opts.rowEl) {
    _row = opts.rowEl;
    _row.classList.add('playing');
  }
}
