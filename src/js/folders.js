import { S } from './state.js';
import { $ } from './dom.js';
import { isTauri, invokeTauri } from './tauri.js';
import { _viewNeedsTracks, activeDownloadIds, getDownloadFolderEffective, getMusicFolders, renderDownloads, renderTracks, saveDownloads } from '../app.js';

function _normPath(s){ return String(s||'').replace(/\//g,'\\').toLowerCase().replace(/\\+$/,''); }
function _inFolder(p, folder){
  if (!p || !folder) return false;
  const np = _normPath(p), nf = _normPath(folder);
  return np === nf || np.startsWith(nf + '\\');
}
async function _downloadFolderNorm(){
  if (!isTauri()) return '';
  try { const f = await getDownloadFolderEffective(); return f ? _normPath(f) : ''; } catch { return ''; }
}
function normalizeSeparationFlags(dl, dirs){
  if (!dl) return false;
  let changed = false;
  for (const t of S.tracks) {
    if (!t || !t.path || t.path === '.') continue;
    const hide = !!(dl && _inFolder(t.path, dl) && !(dirs || []).some(d => _inFolder(t.path, d)));
    if (!!t.fromDownloads !== hide) { t.fromDownloads = hide; changed = true; }
  }
  return changed;
}
export async function onDownloadFolderChanged(){
  if (!isTauri()) return;
  const dl = await _downloadFolderNorm();
  const dirs = getMusicFolders();
  const changed = normalizeSeparationFlags(dl, dirs);
  if (changed && _viewNeedsTracks()) renderTracks($('#globalSearch')?.value || '');
}
function isArtifactFileName(name){
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return n.includes('.enh.tmp.') || n.includes('.dz.tmp.') || n.includes('.prem.')
    || n.includes('.tmp.') || n.includes('.tmp dl') || n.includes('.part') || n.includes('.ytdl');
}
async function cleanupDownloadArtifacts(opts = {}){
  if (!isTauri()) return { removed: 0 };
  if (activeDownloadIds.size > 0) return { removed: 0, skipped: 'active' };
  const now = Date.now();
  if (!opts.force && now - S._artifactsSweepAt < 5 * 60 * 1000) return { removed: 0, skipped: 'throttled' };
  S._artifactsSweepAt = now;
  const folders = [];
  try { const dl = await getDownloadFolderEffective(); if (dl) folders.push(dl); } catch {}
  try {
    for (const d of getMusicFolders()) {
      if (d && !folders.some(f => _normPath(f) === _normPath(d))) folders.push(d);
    }
  } catch {}
  const removed = [];
  for (const folder of folders) {
    try {
      const names = await invokeTauri('cleanup_artifacts', { dir: folder, minAgeSecs: 600 });
      for (const p of (names || [])) if (p) removed.push(p);
    } catch {}
  }
  if (removed.length) {
    const t0 = S.tracks.length, d0 = S.downloads.length;
    S.tracks = S.tracks.filter(t => !isArtifactFileName(t?.path || t?.name));
    S.downloads = S.downloads.filter(d => !isArtifactFileName(d?.path));
    if (S.downloads.length !== d0) saveDownloads();
    if (S.idx >= S.tracks.length) S.idx = Math.max(0, S.tracks.length - 1);
    if (S.tracks.length !== t0 || S.downloads.length !== d0) {
      try { if (_viewNeedsTracks()) renderTracks($('#globalSearch')?.value || ''); } catch {}
      try { if (S.activeView === 'downloads') renderDownloads(); } catch {}
    }
  }
  return { removed: removed.length, paths: removed };
}
export { _normPath, _inFolder, _downloadFolderNorm, normalizeSeparationFlags, isArtifactFileName, cleanupDownloadArtifacts };
