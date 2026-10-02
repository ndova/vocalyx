import { t } from './i18n/core.js';
import { S } from './state.js';
import { showToast, showAudioNotice } from './engine.js';
import { escAttr } from './format.js';
import { renderDownloads, applyDownloadedFrom } from './downloads.js';
import { markEnhanced } from './enhance.js';
import { activeDownloadIds, saveDownloads } from '../app.js';

const COVER_DROP_MAX = 8 * 1024 * 1024;
function readCoverDropFile(file) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type || '')) { showToast(t('ds.notImage'), 3000); return resolve(null); }
    if ((file.size || 0) > COVER_DROP_MAX) { showToast(t('ds.imgTooBig'), 3000); return resolve(null); }
    try {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result || '') || null);
      rd.onerror = () => { showToast(t('ds.imgReadFail'), 3000); resolve(null); };
      rd.readAsDataURL(file);
    } catch { resolve(null); }
  });
}
async function readCoverPathDrop(path) {
  try {
    const lower = String(path || '').toLowerCase();
    const mime = lower.endsWith('.png') ? 'image/png'
      : lower.endsWith('.webp') ? 'image/webp'
      : (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ? 'image/jpeg' : null;
    if (!mime) { showToast(t('ds.notImage'), 3000); return null; }
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const bytes = await readFile(path);
    if (!bytes || !bytes.length) { showToast(t('ds.imgReadFail'), 3000); return null; }
    if (bytes.length > COVER_DROP_MAX) { showToast(t('ds.imgTooBig'), 3000); return null; }
    let bin = '';
    const CH = 8192;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
    return `data:${mime};base64,${btoa(bin)}`;
  } catch { showToast(t('ds.imgReadFail'), 3000); return null; }
}
export function wireCoverDrop(zone, fileInput, onPick) {
  if (!zone) return;
  zone.classList.add('cover-drop');
  zone.title = t('ds.dropHint');
  zone.addEventListener('click', () => { try { fileInput?.click(); } catch {} });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); zone.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const url = await readCoverDropFile(f);
    if (url) { try { onPick(url); } catch {} }
  });
  fileInput?.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    try { fileInput.value = ''; } catch {}
    if (!f) return;
    const url = await readCoverDropFile(f);
    if (url) { try { onPick(url); } catch {} }
  });
  try { window.__activeCoverDrop = { zone, onPick }; } catch {}
}
export function clearActiveCoverDrop(zone) {
  try {
    if (window.__activeCoverDrop && (!zone || window.__activeCoverDrop.zone === zone)) window.__activeCoverDrop = null;
  } catch {}
}
function onlineCoverHtml(t) {
  const initials = escAttr((t.title || '?').slice(0, 2).toUpperCase());
  if (!t.coverUrl) return `<div class="t-cover placeholder" style="background:var(--card2); font-size:10px">${initials}</div>`;
  return `<img src="${escAttr(t.coverUrl)}" alt="cover" class="t-cover" loading="lazy" data-initials="${initials}" onerror="__coverFallback(this)" />`;
}
function _trackSnapshot(t){
  if (!t || typeof t !== 'object') return null;
  const s = { ...t };
  delete s._previewUrl;
  return s;
}
export const _redlBusy = new WeakSet();
export async function startTrackDownload(tk, { reuseEntry = null, onTick = null, onFailed = null, onDone = null, onStale = null } = {}) {
  if (!tk) return null;
  const payload = { track: tk, options: { ...S.downloadOptions, downloadFolder: S.downloadFolder, deezerArl: localStorage.getItem('deezer_arl') || '', spotifyPremiumUser: localStorage.getItem('spotify_premium_user') || '', spotifyPremiumPass: localStorage.getItem('spotify_premium_pass') || '', spotifyClientId: localStorage.getItem('spotify_client_id') || '', spotifyClientSecret: localStorage.getItem('spotify_client_secret') || '' } };
  const rr = await fetch('http://127.0.0.1:8001/download', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const jj = await rr.json();
  if (!jj.downloadId) return null;
  let entry = reuseEntry || null;
  if (entry) {
    entry.id = jj.downloadId;
    entry.title = tk.title; entry.artist = tk.artist;
    entry.format = S.downloadOptions.format; entry.bitrate = '';
    entry.status = 'downloading'; entry.progress = 0; entry.path = '';
    entry.source = tk.source || entry.source || '';
    entry.downloadedFrom = ''; entry.audioNotice = null; entry.error = '';
    entry.track = _trackSnapshot(tk) || entry.track;
  } else {
    entry = { id: jj.downloadId, title: tk.title, artist: tk.artist, format: S.downloadOptions.format, bitrate: '', status:'downloading', progress:0, path:'', source: tk.source || '', downloadedFrom: '', audioNotice: null, track: _trackSnapshot(tk) };
    S.downloads.push(entry);
  }
  activeDownloadIds.add(jj.downloadId);
  saveDownloads(); renderDownloads();
  const poll = setInterval(async()=>{
    try{
      const pr = await fetch(`http://127.0.0.1:8001/download/progress?downloadId=${jj.downloadId}`);
      const pj = await pr.json();
      const cur = pj[jj.downloadId] || pj;
      const ent = S.downloads.find(d=> d.id===jj.downloadId);
      if (ent && cur) {
        const pct = cur.percent || 0;
        ent.progress = pct; ent.status = cur.status || 'downloading'; if(cur.path) ent.path = cur.path;
        applyDownloadedFrom(ent, cur);
        if(cur.audioNotice) ent.audioNotice = cur.audioNotice;
        saveDownloads(); renderDownloads();
        if (cur.status === 'failed') {
          clearInterval(poll); activeDownloadIds.delete(jj.downloadId);
          ent.error = cur.error || t('ds.dlFailed');
          saveDownloads(); renderDownloads();
          showToast(cur.error || t('std.failed'), 6000);
          if (onFailed) onFailed(ent);
        } else if (cur.status === 'done' || pct >= 100) {
          clearInterval(poll); activeDownloadIds.delete(jj.downloadId);
          if (cur.audioNotice) showAudioNotice(tk, cur.audioNotice, ent.downloadedFrom);
          if (cur.audioNotice && cur.audioNotice.enhanced && cur.path) { try { await markEnhanced(cur.path); } catch {}}
          if (onDone) onDone(ent);
        } else {
          if (onTick) onTick(pct);
        }
      }
    }catch{}
  }, 700);
  setTimeout(()=>{ clearInterval(poll); activeDownloadIds.delete(jj.downloadId); if (onStale) onStale(); }, 420000);
  return { downloadId: jj.downloadId, entry };
}
export { COVER_DROP_MAX, readCoverDropFile, readCoverPathDrop, onlineCoverHtml, _trackSnapshot };
