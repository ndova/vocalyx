import { t } from './i18n/core.js';
import { S } from './state.js';
import { $, audio } from './dom.js';
import { showAlert } from './modal.js';
import { isTauri } from './tauri.js';
import { paintRangeFill } from './eq.js';
import { syncKaraokeBtn, refreshCudaStatus } from './engine.js';
import { hashStr } from './format.js';
import { ICON } from './icons.js';
import { pushOsTrack, getNextIndex } from './os-media.js';
import { loadLyricOffset, renderLyrics, fetchAndSaveLrclib } from './lyrics.js';
import { parseLRC, defaultLyrics } from './lrc.js';
import { renderDownloads } from './downloads.js';
import { _downloadFolderNorm, normalizeSeparationFlags } from './folders.js';
import { applyEnhanceState, applyKaraokeMakeup, clearCollectionPlayback, clearPlaylistPlayback, ensureGraph, ensureVolumeGain, getMusicFolders, prefetchVolumeGain, renderAlbumDetail, renderArtistDetail, renderPlaylistDetail, renderTracks, setDownloadPlayback, stopPreview } from '../app.js';

async function ensureDownloadTrack(d){
  if (!d || d.status !== 'done' || !d.path) {
    await showAlert(t('topbar.downloads'), t('player.notDoneFull'));
    return -1;
  }
  if (isTauri()) {
    try {
      const { exists } = await import('@tauri-apps/plugin-fs');
      if (!(await exists(d.path))) {
        await showAlert(t('topbar.downloads'), t('player.notFoundFile', { n: d.path }));
        return -1;
      }
    } catch {}
  }
  let ti = S.tracks.findIndex(t => t.path === d.path);
  if (ti >= 0 && S.tracks[ti] && !S.tracks[ti].fromDownloads) {
    try {
      const dl = await _downloadFolderNorm();
      if (dl) {
        normalizeSeparationFlags(dl, getMusicFolders());
        ti = S.tracks.findIndex(t => t.path === d.path);
      }
    } catch {}
  }
  if (ti >= 0) {
    const tr = S.tracks[ti];
    if (tr && d) {
      const sep2 = d.path.includes('\\') ? '\\' : '/';
      const base2 = d.path.split(sep2).pop() || '';
      if (!tr.cover && d.cover) tr.cover = d.cover;
      if (d.title && (!tr.title || tr.title === base2)) tr.title = d.title;
      if (d.artist && (!tr.artist || tr.artist === 'Unknown')) tr.artist = d.artist;
      if (d.dur && (!tr.dur || tr.dur === '--:--')) tr.dur = d.dur;
    }
  }
  if (ti === -1) {
    const sep = d.path.includes('\\') ? '\\' : '/';
    const base = d.path.split(sep).pop() || d.title;
    const dot = base.lastIndexOf('.');
    const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : (d.format || 'mp3');
    let url = null;
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      url = convertFileSrc(d.path);
    } catch { url = d.path; }
    ti = S.tracks.findIndex(t => t.path === d.path);
    if (ti >= 0) return ti;
    S.tracks.push({
      title: d.title || base,
      artist: d.artist || 'Unknown',
      album: d.album || '',
      dur: d.dur || '--:--',
      duration: null,
      url,
      name: base,
      path: d.path,
      ext,
      size: 0,
      size_str: d.size_str || `${(d.format || '').toUpperCase()} ${d.bitrate || ''}kbps`.trim() || '--',
      lyric_path: null,
      cover: d.cover || null,
      karaoke_path: null,
      file: null,
      fromDownloads: true
    });
    ti = S.tracks.length - 1;
  }
  return ti;
}
export async function playDownloaded(d){
  const ti = await ensureDownloadTrack(d);
  if (ti < 0) return;
  clearPlaylistPlayback();
  clearCollectionPlayback();
  setDownloadPlayback(S.lastDownloadPaths.length ? S.lastDownloadPaths : [d.path]);
  load(ti, true);
}
function loadSettingsUI(){
  const fmtBtns = document.querySelectorAll('.dl-format');
  fmtBtns.forEach(b=> b.classList.toggle('active', b.dataset.format===S.downloadOptions.format));
  document.querySelectorAll('[data-strict-src]').forEach(el=>{
    el.checked = !!(S.downloadOptions.strictSources && S.downloadOptions.strictSources[el.dataset.strictSrc]);
  });
  const enhEl = document.getElementById('dlEnhance');
  if (enhEl) enhEl.checked = !!S.downloadOptions.audioEnhance;
  const normEl = document.getElementById('dlNormalize');
  if (normEl) {
    normEl.checked = !!S.downloadOptions.normalizeVolume;
    normEl.disabled = false;
  }
  const lufsEl = document.getElementById('dlTargetLufs');
  if (lufsEl) lufsEl.value = S.downloadOptions.targetLufs || -14;
  const vgOn = document.getElementById('vgEnabled');
  if (vgOn) vgOn.checked = !!S.downloadOptions.replayGainEnabled;
  const vgT = document.getElementById('vgTarget');
  const vgTv = document.getElementById('vgTargetVal');
  if (vgT) vgT.value = S.downloadOptions.replayGainTarget ?? -14;
  if (vgT) paintRangeFill(vgT);
  if (vgTv) vgTv.textContent = (S.downloadOptions.replayGainTarget ?? -14) + ' LUFS';
  const vgP = document.getElementById('vgPreamp');
  const vgPv = document.getElementById('vgPreampVal');
  const preAmp = parseFloat(S.downloadOptions.replayGainPreAmp) || 0;
  if (vgP) vgP.value = preAmp;
  if (vgP) paintRangeFill(vgP);
  if (vgPv) vgPv.textContent = (preAmp > 0 ? '+' : '') + preAmp + ' dB';
  const vgClip = document.getElementById('vgClip');
  if (vgClip) vgClip.checked = S.downloadOptions.replayGainClipPrevention !== false;
  const vgFolder = document.getElementById('vgFolder');
  if (vgFolder) vgFolder.value = localStorage.getItem('vocalyx_gainFolder') || S.downloadFolder || 'Default: ./downloads';
  const kDev = document.getElementById('karaokeDevice');
  if (kDev) kDev.value = S.downloadOptions.karaokeDevice || 'cpu';
  const kQ = document.getElementById('karaokeQuality');
  if (kQ) kQ.value = S.downloadOptions.karaokeQuality || 'karaoke_aufr33';
  const kF = document.getElementById('karaokeFormat');
  if (kF) kF.value = S.downloadOptions.karaokeFormat || 'flac';
  const yc = document.getElementById('ytCookies');
  if (yc) yc.value = S.downloadOptions.ytCookies || 'off';
  const ycp = document.getElementById('ytCookiesPath');
  if (ycp) ycp.value = S.downloadOptions.ytCookiesPath || '';
  try { refreshCudaStatus().catch(() => {}); } catch {}
  const folderEl = document.getElementById('dlFolder');
  if (folderEl) folderEl.value = S.downloadFolder || 'Default: ./downloads';
  const arlEl = document.getElementById('dzArl');
  if (arlEl) arlEl.value = localStorage.getItem('deezer_arl')||'';
  const idEl = document.getElementById('spClientId');
  const secEl = document.getElementById('spClientSecret');
  const userEl = document.getElementById('spUser');
  const passEl = document.getElementById('spPass');
  if (idEl) idEl.value = localStorage.getItem('spotify_client_id')||'';
  if (secEl) secEl.value = localStorage.getItem('spotify_client_secret')||'';
  if (userEl) userEl.value = localStorage.getItem('spotify_premium_user')||'';
  if (passEl) passEl.value = localStorage.getItem('spotify_premium_pass')||'';
}

function updateNpCover(t) {
  const el = $('#npCover');
  if (!el) return;
  if (t && t.cover) {
    el.innerHTML = `<img src="${t.cover}" alt="cover">`;
    el.classList.add('has-img');
    el.classList.remove('placeholder');
    el.style.background = '';
    el.style.color = '';
  } else if (t && t.title) {
    const initial = (t.title?.[0] || t.name?.[0] || '?').toUpperCase();
    const hue = Math.abs(hashStr((t.artist || '') + (t.title || ''))) % 360;
    el.innerHTML = initial;
    el.style.background = `hsl(${hue} 55% 22%)`;
    el.style.color = `hsl(${hue} 70% 85%)`;
    el.classList.add('placeholder');
    el.classList.remove('has-img');
  } else {
    el.innerHTML = ICON.music;
    el.style.background = 'var(--card2)';
    el.style.color = 'var(--muted)';
    el.classList.add('placeholder');
    el.classList.remove('has-img');
  }
}
export function refreshNpCoverIfCurrent(path) {
  try {
    if (!path) return;
    const cur = S.tracks[S.idx];
    if (!cur || cur.path !== path) return;
    updateNpCover(cur);
    try { if (typeof pushOsTrack === 'function') pushOsTrack(); } catch {}
  } catch {}
}
export async function load(i, autoplay = false) {
  if (S.tracks.length === 0) return;
  try { stopPreview(); } catch {}
  delete audio.dataset.previewCap;
  delete audio.dataset.previewNotified;
  delete audio.dataset.isPreview;
  S.idx = (i + S.tracks.length) % S.tracks.length;
  const t = S.tracks[S.idx];
  loadLyricOffset();
  $('#npTitle').textContent = t.title;
  $('#npArtist').textContent = t.artist;
  $('#lyTitle').textContent = t.title;
  $('#lyArtist').textContent = t.artist;
  updateNpCover(t);
  syncKaraokeBtn();
  if (S.karaokeOn && !t.karaoke_path) {
    S.karaokeOn = false;
    syncKaraokeBtn();
  }
  const wantKaraoke = S.karaokeOn && !!t.karaoke_path;
  const activeMode = S.karaokeOn ? 'karaoke' : '';
  if (wantKaraoke) {
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      audio.src = convertFileSrc(t.karaoke_path);
      audio.dataset.karaoke = 'true';
      audio.dataset.mode = activeMode;
      syncKaraokeBtn();
    } catch {
      audio.src = t.path ? (await import('@tauri-apps/api/core').then(m => m.convertFileSrc(t.path)).catch(()=>t.path)) : t.url;
      audio.dataset.karaoke = wantKaraoke ? 'true' : 'false';
      audio.dataset.mode = wantKaraoke ? activeMode : '';
    }
  } else {
    audio.dataset.karaoke = wantKaraoke ? 'true' : 'false';
    audio.dataset.mode = wantKaraoke ? activeMode : '';
    if (t.url) {
      audio.src = t.url;
    } else if (t.path) {
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        audio.src = convertFileSrc(t.path);
      } catch {
        audio.src = t.path;
      }
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
  }
  applyEnhanceState();
  applyKaraokeMakeup();
  prefetchVolumeGain(t.path);
  try {
    const ni = getNextIndex();
    if (ni >= 0 && ni !== S.idx) prefetchVolumeGain(S.tracks[ni]?.path);
  } catch {}
  renderTracks($('#globalSearch').value);

  let localLrcOk = false;
  if (t.lyric_path) {
    try {
      const { exists } = await import('@tauri-apps/plugin-fs');
      if (!(await exists(t.lyric_path))) {
        t.lyric_path = null;
        delete t._lrclibTried;
      }
    } catch {}
  }
  if (t.lyric_path) {
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const text = await readTextFile(t.lyric_path);
      S.lyricLines = parseLRC(text);
      renderLyrics();
      localLrcOk = true;
    } catch {
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const url = convertFileSrc(t.lyric_path);
        const text = await fetch(url).then(r => r.text());
        S.lyricLines = parseLRC(text);
        renderLyrics();
        localLrcOk = true;
      } catch {}
    }
    if (!localLrcOk) {
      t.lyric_path = null;
      delete t._lrclibTried;
      S.lyricLines = defaultLyrics();
      renderLyrics();
      await fetchAndSaveLrclib(t);
    }
  } else {
    const fetched = await fetchAndSaveLrclib(t);
    if (!fetched) {
      S.lyricLines = defaultLyrics();
      renderLyrics();
    }
  }

  if (autoplay && (t.url || t.path)) {
    if (!S.actx) ensureGraph();
    await ensureVolumeGain({ notify: true });
    play();
  }
  syncPlayerState();
  pushOsTrack();
  try {
    if (S.activeView.startsWith('album:')) renderAlbumDetail(S.activeAlbumKey);
    else if (S.activeView.startsWith('artist:')) renderArtistDetail(S.activeArtistKey);
    else if (S.activeView.startsWith('playlist:')) renderPlaylistDetail(S.activePlaylistId);
    else if (S.activeView === 'downloads') renderDownloads(true);
  } catch {}
}
export function syncPlayerState(){
  const hasMedia = !!(audio && audio.src);
  ['btnPlay','btnPrev','btnNext','btnShuffle','btnRepeat'].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.disabled = !hasMedia;
  });
  const sk = document.getElementById('seek');
  if (sk) sk.disabled = !hasMedia;
}

function updatePlayIcon(isPlaying) {
  const btn = $('#btnPlay');
  if (!btn) return;
  const playIcon = btn.querySelector('.icon-play');
  const pauseIcon = btn.querySelector('.icon-pause');
  if (playIcon && pauseIcon) {
    playIcon.style.display = isPlaying ? 'none' : 'block';
    pauseIcon.style.display = isPlaying ? 'block' : 'none';
  } else {
    btn.innerHTML = isPlaying ? ICON.pause : ICON.play;
  }
}
export function play() {
  try { stopPreview(); } catch {}
  ensureGraph();
  audio.play().catch(() => {});
  updatePlayIcon(true);
}
export function pause() {
  audio.pause();
  updatePlayIcon(false);
}
export { ensureDownloadTrack, loadSettingsUI, updateNpCover, updatePlayIcon };
