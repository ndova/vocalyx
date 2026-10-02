import { t } from './i18n/core.js';
import { S } from './state.js';
import { $, audio, seek, tCur, tLeft } from './dom.js';
import { _downloadFolderNorm, _inFolder, isArtifactFileName, normalizeSeparationFlags } from './folders.js';
import { applyLocalSort } from './sorting.js';
import { isTauri, invokeTauri } from './tauri.js';
import { paintRangeFill } from './eq.js';
import { syncLyrics } from './lyrics.js';
import { searchViewBox } from './theme.js';
import { fmt } from './format.js';
import { pushOsState, pushOsPosition, getNextIndex } from './os-media.js';
import { showToast, getMusicFolders, load, pause, play, refreshNpCoverIfCurrent, renderPlaylistDetail, renderPlaylistsOverview, renderSearchView, renderTracks, saveMusicFolder, savePlaylists, updatePlayIcon } from '../app.js';

const btnAddFolder = $('#btnAddFolder');
function dedupeByPath(list){
  const seen = new Set();
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    const k = t.path || t.name;
    if (k && seen.has(k)) { list.splice(i, 1); removed++; }
    else if (k) seen.add(k);
  }
  return removed;
}
let _scanApplyChain = Promise.resolve();
function applyScanResult(result){
  const run = _scanApplyChain.then(() => _applyScanResultNow(result));
  _scanApplyChain = run.catch(() => {});
  return run;
}
async function _applyScanResultNow(result){
  const dl = await _downloadFolderNorm();
  const dirs = getMusicFolders();
  const existing = new Set(S.tracks.map(t => t.path).filter(Boolean));
  let added = 0;
  for (const r of result) {
    if (isArtifactFileName(r.path || r.file_name)) continue;
    const inDl = _inFolder(r.path, dl);
    const inMusic = dirs.some(d => _inFolder(r.path, d));
    const hide = !!(inDl && !inMusic);
    const known = S.tracks.find(t => t.path === r.path);
    if (known) {
      if (!known.album && r.album) known.album = r.album;
      if (dl && !!known.fromDownloads !== hide) known.fromDownloads = hide;
      if (r.cover && r.cover !== known.cover) {
        known.cover = r.cover;
        refreshNpCoverIfCurrent(known.path);
      } else if (!r.cover && known.cover && known.cover.startsWith('data:')) {
        known.cover = null;
        refreshNpCoverIfCurrent(known.path);
      }
      if (r.dur && known.dur === '--:--') known.dur = r.dur;
      continue;
    }
    if (existing.has(r.path)) continue;
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    let url = null;
    try { url = convertFileSrc(r.path); } catch { url = null; }
    S.tracks.push({
      title: r.title,
      artist: r.artist,
      album: r.album || '',
      dur: r.dur || r.duration_str || '--:--',
      duration: r.duration || null,
      url,
      name: r.file_name,
      path: r.path,
      ext: r.ext || '',
      size: r.size || 0,
      size_str: r.size_str || '--',
      lyric_path: r.lyric_path || null,
      cover: r.cover || null,
      karaoke_path: r.karaoke_path || null,
      file: null,
      ...(hide ? { fromDownloads: true } : {})
    });
    existing.add(r.path);
    added++;
  }
  const removed = dedupeByPath(S.tracks);
  if (added > 0 || removed) applyLocalSort();
  return { added };
}
export function _viewNeedsTracks(){
  return S.activeView === 'local' || S.activeView === 'albums' || S.activeView === 'artists'
    || S.activeView.startsWith('album:') || S.activeView.startsWith('artist:')
    || S.activeView.startsWith('playlist:');
}
async function rescanMusicFolders(){
  if (!isTauri()) return;
  const now = Date.now();
  if (now - S._musicRescanAt < 10000) return;
  S._musicRescanAt = now;
  try {
    const dirs = getMusicFolders();
    const okDirs = [];
    const scanned = new Set();
    let added = 0;
    for (const dir of dirs) {
      try {
        const files = await invokeTauri('scan_music', { dir });
        okDirs.push(dir);
        for (const f of (files || [])) {
          if (f && f.path) { scanned.add(f.path); scanned.add(String(f.path).toLowerCase()); }
        }
        if (files && files.length) {
          const r = await applyScanResult(files);
          added += r.added || 0;
        }
      } catch {}
    }
    let removed = 0;
    if (okDirs.length) {
      const underOk = (p) => !!p && okDirs.some(d => _inFolder(p, d));
      const alive = (p) => !p || scanned.has(p) || scanned.has(String(p).toLowerCase());
      const before = S.tracks.length;
      S.tracks = S.tracks.filter(t => !t || !t.path || !underOk(t.path) || alive(t.path));
      removed += before - S.tracks.length;
      if (S.idx >= S.tracks.length) S.idx = Math.max(0, S.tracks.length - 1);
      let plTouched = false;
      for (const pl of (S.playlists || [])) {
        if (!pl || !Array.isArray(pl.trackPaths)) continue;
        const kept = pl.trackPaths.filter(pp => !underOk(pp) || alive(pp));
        if (kept.length !== pl.trackPaths.length) { pl.trackPaths = kept; plTouched = true; }
      }
      if (S.playlistPlayback && Array.isArray(S.playlistPlayback.paths)) {
        S.playlistPlayback.paths = S.playlistPlayback.paths.filter(pp => !underOk(pp) || alive(pp));
      }
      if (plTouched) {
        savePlaylists();
        try { renderPlaylistsOverview(); } catch {}
        try { if (String(S.activeView || '').startsWith('playlist:')) renderPlaylistDetail(S.activePlaylistId); } catch {}
      }
    }
    if ((added > 0 || removed > 0) && _viewNeedsTracks()) renderTracks($('#globalSearch')?.value || '');
  } catch {}
}
function requestMusicRescan(delayMs = 2000){
  if (S._musicRescanTimer) clearTimeout(S._musicRescanTimer);
  S._musicRescanTimer = setTimeout(()=>{ S._musicRescanTimer = null; rescanMusicFolders().catch(()=>{}); }, delayMs);
}
const _musicWatchers = new Map();
async function ensureMusicWatchers(){
  if (!isTauri()) return;
  let watchMod = null;
  try { watchMod = await import('@tauri-apps/plugin-fs'); } catch { return; }
  const dirs = getMusicFolders();
  const want = new Set(dirs.filter(Boolean));
  for (const [dir, stop] of _musicWatchers) {
    if (!want.has(dir)) {
      try { if (stop) await stop(); } catch {}
      _musicWatchers.delete(dir);
    }
  }
  for (const dir of want) {
    if (_musicWatchers.has(dir)) continue;
    try {
      const stop = await watchMod.watchImmediate(dir, ()=>{ requestMusicRescan(2000); });
      _musicWatchers.set(dir, stop);
    } catch {}
  }
}
window.addEventListener('focus', ()=>{ if (_viewNeedsTracks()) requestMusicRescan(3000); });
document.addEventListener('visibilitychange', ()=>{ if (!document.hidden && _viewNeedsTracks()) requestMusicRescan(3000); });
async function addFolder() {
  if (!isTauri()) {
    alert(t('local.tauriOnly'));
    return;
  }
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const folder = await open({ directory: true, multiple: false, title: t('btn.addFolderTitle') });
    if (!folder) return;
    const dl = await _downloadFolderNorm();
    const result = await invokeTauri('scan_music', { dir: folder });
    if (!result || result.length === 0) {
      alert(t('local.noAudio'));
      return;
    }
    saveMusicFolder(folder);
    if (dl && _inFolder(folder, dl)) showToast(t('local.folderAdded', { n: t('topbar.local') }), 3500);
    S.tracks = [];
    S.idx = 0;
    const { added } = await applyScanResult(result);
    normalizeSeparationFlags(dl, getMusicFolders());
    ensureMusicWatchers().catch(()=>{});
    renderTracks();
    if (added > 0) {
      load(S.tracks.length - added, false);
      S.idx = S.tracks.length - added;
      const t0 = S.tracks[S.idx];
      $('#npTitle').textContent = t0.title;
      $('#npArtist').textContent = t0.artist;
      renderTracks('');
    }
  } catch (e) {
    alert(t('loc.addFail', { n: e }));
  }
}
if (btnAddFolder) btnAddFolder.onclick = addFolder;
async function restoreMusicFolders(){
  if (!isTauri()) return;
  const dirs = getMusicFolders();
  if (dirs.length) {
    S._musicRescanAt = Date.now();
    try {
      for (const dir of dirs) {
        try {
          const result = await invokeTauri('scan_music', { dir });
          if (result && result.length) await applyScanResult(result);
        } catch {}
      }
      ensureMusicWatchers().catch(()=>{});
    } catch (e) {
      console.warn('restoreMusicFolders:', e);
    }
  }
  try {
    const changed = normalizeSeparationFlags(await _downloadFolderNorm(), getMusicFolders());
    if (dirs.length || changed) renderTracks();
  } catch {}
}

$('#globalSearch').oninput = (e) => {
  const v = e.target.value;
  const localInput = $('#localSearchInput');
  if (localInput && localInput.value !== v) localInput.value = v;
};
$('#globalSearch').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = e.target.value;
    const localInput = $('#localSearchInput');
    if (localInput && localInput.value !== v) localInput.value = v;
    renderTracks(v);
  }
};
const localSearchBox = $('#localSearchBox');
const localSearchInput = $('#localSearchInput');
const btnClearLocalSearch = $('#btnClearLocalSearch');
if (localSearchInput) {
  localSearchInput.oninput = (e) => {
    const v = e.target.value;
    const g = $('#globalSearch');
    if (g && g.value !== v) g.value = v;
  };
  localSearchInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      renderTracks(e.target.value);
    }
  };
}
$('#localSearchFilter')?.addEventListener('change', ()=>{
  renderTracks(($('#globalSearch')?.value || localSearchInput?.value || ''));
});
$('#btnListSearch').onclick = () => {
  if (!localSearchBox || !localSearchInput) { $('#globalSearch').focus(); return; }
  const willOpen = !localSearchBox.classList.contains('open');
  localSearchBox.classList.toggle('open', willOpen);
  if (willOpen) setTimeout(()=>localSearchInput.focus(), 180);
  else { localSearchInput.value=''; const g=$('#globalSearch'); if(g) g.value=''; renderTracks(''); }
};
if (btnClearLocalSearch) {
  btnClearLocalSearch.onclick = () => {
    if (localSearchInput) localSearchInput.value='';
    const g=$('#globalSearch'); if(g) g.value='';
    renderTracks('');
    if (localSearchInput) localSearchInput.focus();
  };
}
document.addEventListener('keydown', (e)=>{
  if (e.key==='Escape' && localSearchBox?.classList.contains('open')) {
    localSearchBox.classList.remove('open');
    if (localSearchInput) localSearchInput.value='';
    const g=$('#globalSearch'); if(g) g.value='';
    renderTracks('');
  }
  if (e.key==='Escape' && searchViewBox?.classList.contains('open')) {
    searchViewBox.classList.remove('open');
    const si = document.getElementById('searchViewInput'); if (si) si.value='';
    renderSearchView();
  }
});

audio.onloadedmetadata = () => {
  S.tracks[S.idx].dur = fmt(audio.duration);
  renderTracks($('#globalSearch').value);
};
audio.addEventListener('play', ()=>{ pushOsState(); });
audio.addEventListener('pause', ()=>{ pushOsState(); });
audio.addEventListener('seeked', ()=>{ pushOsPosition(true); });
audio.addEventListener('play', ()=>{ updatePlayIcon(true); });
audio.addEventListener('pause', ()=>{ updatePlayIcon(false); });
audio.onended = () => {
  if (!S.tracks.length) return;
  if (S.repeatMode === 'one') { audio.currentTime = 0; play(); return; }
  const ni = getNextIndex();
  if (ni === -1) return;
  load(ni, true);
};
audio.ontimeupdate = () => {
  if (audio.dataset.previewCap && audio.duration) {
    const cap = parseFloat(audio.dataset.previewCap) || 30;
    if (audio.currentTime >= cap) {
      try { audio.currentTime = cap; } catch {}
      pause();
      if (!audio.dataset.previewNotified) {
        audio.dataset.previewNotified = '1';
        showToast(t('ac.previewDone'), 4000);
      }
    }
  }
  if (audio.duration) {
    seek.value = Math.floor((audio.currentTime / audio.duration) * 1000);
    paintRangeFill(seek);
    tCur.textContent = fmt(audio.currentTime);
    tLeft.textContent = '-' + fmt(audio.duration - audio.currentTime);
    syncLyrics(audio.currentTime);
    if (S._smtcNative) pushOsPosition();
  }
};
seek.oninput = () => {
  if (!audio.duration) return;
  let pos = (seek.value / 1000) * audio.duration;
  if (audio.dataset.previewCap) pos = Math.min(pos, parseFloat(audio.dataset.previewCap) || 30);
  audio.currentTime = pos;
};
export { btnAddFolder, applyScanResult, dedupeByPath, rescanMusicFolders, requestMusicRescan, _musicWatchers, ensureMusicWatchers, addFolder, restoreMusicFolders, localSearchBox, localSearchInput, btnClearLocalSearch };
