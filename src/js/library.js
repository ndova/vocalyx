import { S } from './state.js';

const STORAGE_PREFIX = 'vocalyx_';
const STORAGE_LEGACY_PREFIXES = ['netkara_', 'tunebox_'];
function cleanupLegacyStoreKeys(){
  try {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && STORAGE_LEGACY_PREFIXES.some((p) => k.startsWith(p))) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  } catch {}
}
cleanupLegacyStoreKeys();
const MUSIC_FOLDERS_KEY = 'vocalyx_musicFolders_v1';
export function getMusicFolders(){
  try { return JSON.parse(localStorage.getItem(MUSIC_FOLDERS_KEY) || '[]') || []; }
  catch { return []; }
}
export function saveMusicFolder(dir){
  if (!dir) return;
  try {
    localStorage.setItem(MUSIC_FOLDERS_KEY, JSON.stringify([dir]));
  } catch {}
}
function parentFolderName(p){
  if (!p) return '';
  const parts = String(p).split(/[/\\]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}
export function artistKeyOf(t){
  const a = String(t?.artist || '').trim();
  return a || 'Unknown';
}
export function albumKeyOf(t){
  const a = String(t?.album || t?.albumName || '').trim();
  if (a) return a;
  return parentFolderName(t?.path) || 'Unknown Album';
}
export function localLibraryTracks(){
  return S.tracks.filter(t => t && !t.fromDownloads);
}
export function savePlaylists(){
  localStorage.setItem('vocalyx_playlists_v1', JSON.stringify(S.playlists));
}
export function normPath(p){
  const s = String(p == null ? '' : p).trim();
  if (!s || s === '.' || s === './' || s === '.\\') return '';
  return s.replace(/\//g, '\\').toLowerCase();
}
export function trackIndexByPath(p, list){
  const np = normPath(p);
  if (!np) return -1;
  const src = Array.isArray(list) ? list : S.tracks;
  return src.findIndex(t => normPath(t && t.path) === np);
}
export function playlistTracks(pl, list){
  if (!pl || !Array.isArray(pl.trackPaths)) return [];
  const src = Array.isArray(list) ? list : S.tracks;
  return pl.trackPaths.map(pp => src[trackIndexByPath(pp, src)]).filter(Boolean);
}
export function plPathIndex(pl, path){
  const np = normPath(path);
  if (!np || !pl || !Array.isArray(pl.trackPaths)) return -1;
  return pl.trackPaths.findIndex(pp => normPath(pp) === np);
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
if (!S.downloadOptions.karaokeDevice) S.downloadOptions.karaokeDevice = 'auto';
if (!['karaoke_aufr33','cpu_inst_hq'].includes(S.downloadOptions.karaokeQuality)) S.downloadOptions.karaokeQuality = 'karaoke_aufr33';
if (!['flac','ogg','wav'].includes(S.downloadOptions.karaokeFormat)) S.downloadOptions.karaokeFormat = 'flac';
if (!['karaoke_aufr33', 'cpu_inst_hq'].includes(S.downloadOptions.karaokeQuality)) S.downloadOptions.karaokeQuality = 'karaoke_aufr33';
if (typeof S.downloadOptions.replayGainEnabled !== 'boolean') S.downloadOptions.replayGainEnabled = false;
if (!Number.isFinite(S.downloadOptions.replayGainTarget)) S.downloadOptions.replayGainTarget = -14;
S.downloadOptions.replayGainTarget = Math.max(-20, Math.min(-10, S.downloadOptions.replayGainTarget));
if (!Number.isFinite(S.downloadOptions.replayGainPreAmp)) S.downloadOptions.replayGainPreAmp = 0;
S.downloadOptions.replayGainPreAmp = Math.max(-6, Math.min(6, S.downloadOptions.replayGainPreAmp));
if (typeof S.downloadOptions.replayGainClipPrevention !== 'boolean') S.downloadOptions.replayGainClipPrevention = true;
if (!S.downloadOptions.strictSources || typeof S.downloadOptions.strictSources !== 'object') {
  S.downloadOptions.strictSources = { spotify:true, soundcloud:!!S.downloadOptions.scStrict, archive:false, deezer:false, '4shared':false };
  delete S.downloadOptions.scStrict;
  try { localStorage.setItem('vocalyx_downloadOptions', JSON.stringify(S.downloadOptions)); } catch {}
}
if (S.downloadOptions.strictV !== 2) {
  S.downloadOptions.strictSources = { ...(S.downloadOptions.strictSources || {}), spotify:true };
  S.downloadOptions.strictV = 2;
  try { localStorage.setItem('vocalyx_downloadOptions', JSON.stringify(S.downloadOptions)); } catch {}
}
if (!['off','auto','chrome','edge','firefox','brave','opera'].includes(S.downloadOptions.ytCookies)) S.downloadOptions.ytCookies = 'off';
if (typeof S.downloadOptions.ytCookiesPath !== 'string') S.downloadOptions.ytCookiesPath = '';
if (S.downloadOptions.audioSource !== 'youtube') S.downloadOptions.audioSource = 'youtube';
try { localStorage.setItem('vocalyx_downloadOptions', JSON.stringify(S.downloadOptions)); } catch {}
try { localStorage.removeItem('soundcloud_cookies'); } catch {}
export const activeDownloadIds = new Set();
export function saveDownloadOptions(o){ S.downloadOptions={...S.downloadOptions, ...o}; localStorage.setItem('vocalyx_downloadOptions', JSON.stringify(S.downloadOptions)); }
export function saveDownloadFolder(p){ S.downloadFolder=p; localStorage.setItem('vocalyx_downloadFolder', p); }
export function saveDownloads(){ localStorage.setItem('vocalyx_downloads', JSON.stringify(S.downloads)); }
export function setPlaylistPlayback(pid, startPath){
  const pl = S.playlists.find(p=>p.id===pid);
  if (!pl) { S.playlistPlayback=null; return; }
  S.playlistPlayback = { id: pid, paths: [...pl.trackPaths] };
  S.albumPlayback = null;
  S.artistPlayback = null;
  clearDownloadPlayback();
}
export function clearPlaylistPlayback(){ S.playlistPlayback=null; }
export function setAlbumPlayback(key, paths){
  S.albumPlayback = { key, paths: [...paths] };
  S.artistPlayback = null;
  S.playlistPlayback = null;
  clearDownloadPlayback();
}
export function setArtistPlayback(key, paths){
  S.artistPlayback = { key, paths: [...paths] };
  S.albumPlayback = null;
  S.playlistPlayback = null;
  clearDownloadPlayback();
}
export function clearCollectionPlayback(){ S.albumPlayback = null; S.artistPlayback = null; }
try {
  if (S.downloadPlayback && Array.isArray(S.downloadPlayback.paths) && S.downloadPlayback.paths.some(p => !p || p === "." || p === "./" || p === ".\\")) {
    console.warn("[sweep] clearing corrupt downloadPlayback", S.downloadPlayback);
    S.downloadPlayback = null;
    localStorage.removeItem('vocalyx_downloadPlayback_v1');
  }
} catch {}
export function saveDownloadPlayback(){
  try {
    if (S.downloadPlayback && S.downloadPlayback.paths && S.downloadPlayback.paths.length) localStorage.setItem('vocalyx_downloadPlayback_v1', JSON.stringify(S.downloadPlayback));
    else localStorage.removeItem('vocalyx_downloadPlayback_v1');
  } catch {}
}
export function setDownloadPlayback(paths){
  S.downloadPlayback = { paths: [...paths] };
  S.lastDownloadPaths = [...paths];
  clearPlaylistPlayback();
  clearCollectionPlayback();
  saveDownloadPlayback();
}
export function clearDownloadPlayback(){ S.downloadPlayback=null; S.lastDownloadPaths=[]; saveDownloadPlayback(); }
export function ensureTrackForPath(p){
  if (!p || p === "." || p === "./" || p === ".\\" || String(p).trim() === "") {
    console.warn("[ensureTrackForPath] invalid path skipped:", JSON.stringify(p));
    return -1;
  }
  let ti = S.tracks.findIndex(t=> t.path===p);
  if (ti >= 0) return ti;
  const sep = p.includes('\\') ? '\\' : '/';
  const base = p.split(sep).pop() || p;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot+1).toLowerCase() : 'mp3';
  S.tracks.push({ title: base, artist: 'Unknown', album: '', dur: '--:--', duration: null, url: null, name: base, path: p, ext, size: 0, size_str: '--', lyric_path: null, cover: null, karaoke_path: null, file: null, fromDownloads: true });
  return S.tracks.length - 1;
}
export { MUSIC_FOLDERS_KEY, parentFolderName, uid };
