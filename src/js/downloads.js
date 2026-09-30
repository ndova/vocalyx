import { S } from './state.js';
import { $, audio } from './dom.js';
import { escAttr } from './format.js';
import { isTauri, invokeTauri } from './tauri.js';
import { isArtifactFileName } from './folders.js';
import { statLocal, enhanceOneFile, pruneEnhMarker } from './enhance.js';
import { sortDownloadRows } from './sorting.js';
import { ICON } from './icons.js';
import { showToast } from './engine.js';
import { pruneLyricOffset } from './lyrics.js';
import { showConfirm } from './modal.js';
import { rescanMusicFolders } from './local.js';
import { _redlBusy, activeDownloadIds, clearDownloadPlayback, closePortalMenu, editDownloaded, getDownloadFolderEffective, getMusicFolders, handleLibraryDrop, load, pause, playDownloaded, renderTracks, saveDownloadPlayback, saveDownloads, selKeyDL, setSelectMode, startTrackDownload, syncPlayerState, syncSelHeader, toggleSelDL } from '../app.js';

export async function requestDlRender(){
  if (S.activeView !== 'downloads') return;
  const now = Date.now();
  if (now - S._dlRenderAt < 1000) {
    if (!S._dlRenderPending) { S._dlRenderPending = true; setTimeout(()=>{ S._dlRenderPending = false; requestDlRender(); }, Math.max(100, 1100 - (now - S._dlRenderAt))); }
    return;
  }
  S._dlRenderAt = now;
  try { await renderDownloads(); } catch {}
}
async function ensureDlWatcher(){
  if (!isTauri()) return;
  let folder = '';
  try { folder = await getDownloadFolderEffective(); } catch { return; }
  if (!folder || folder === S._dlWatchFolder) return;
  try { if (S._dlWatchStop) await S._dlWatchStop(); } catch {}
  S._dlWatchStop = null; S._dlWatchFolder = '';
  try {
    const { watchImmediate } = await import('@tauri-apps/plugin-fs');
    S._dlWatchStop = await watchImmediate(folder, ()=>{ requestDlRender(); });
    S._dlWatchFolder = folder;
  } catch {}
}
window.addEventListener('focus', ()=>{ if (S.activeView === 'downloads') requestDlRender(); });
document.addEventListener('visibilitychange', ()=>{ if (!document.hidden && S.activeView === 'downloads') requestDlRender(); });
setInterval(()=>{
  if (S.activeView !== 'downloads' || document.hidden) return;
  if (document.querySelector('#appModal.open')) return;
  if (document.querySelector('#downloadList:hover')) return;
  requestDlRender();
}, 5000);
function _isUnderFolder(p, folder){
  if (!folder || !p) return true;
  const norm = s => String(s||'').replace(/\//g,'\\').toLowerCase().replace(/\\+$/,'');
  const np = norm(p), nf = norm(folder);
  return np === nf || np.startsWith(nf + '\\');
}
export async function renderDownloads(force=false){
  try { await _renderDownloads(force); }
  catch (err) {
    console.error('[dl] render error', err);
    const listEl = document.getElementById('downloadList');
    if (listEl) listEl.innerHTML = `<div style="padding:24px; text-align:center; color:#ff6b6b">⚠ Gagal render daftar download: ${escAttr(String(err?.message || err))}<br><span style="font-size:11px;color:var(--muted)">Lihat console (F12) untuk detail</span></div>`;
  }
}
async function _renderDownloads(force=false){
  const listEl = document.getElementById('downloadList');
  const countEl = document.getElementById('downloadCount');
  if (!listEl) return;
  ensureDlWatcher().catch(()=>{});
  const rows = [];
  const seenPaths = new Set();
  const seenDlPaths = new Set();
  let folder = '';
  let scanCount = 0;
  if (isTauri()) {
    folder = await getDownloadFolderEffective();
    if (countEl) countEl.title = folder || '';
    if (folder) {
      try {
        const files = await invokeTauri('scan_music', { dir: folder });
        scanCount = (files || []).length;
        for (const f of (files || [])) {
          if (!f || !f.path || seenPaths.has(f.path) || isArtifactFileName(f.path)) continue;
          seenPaths.add(f.path);
          const hists = S.downloads.filter(h => h.path === f.path);
          const hist = hists.find(h => h.downloadedFrom && h.downloadedFrom !== 'cache-hit') || hists[0] || null;
          let scanVia = hist?.downloadedFrom || '';
          let scanNotice = hist?.audioNotice || null;
          if (scanVia === 'cache-hit') {
            const prior = hists.find(h => h.downloadedFrom && h.downloadedFrom !== 'cache-hit');
            if (prior) { scanVia = prior.downloadedFrom; scanNotice = prior.audioNotice || scanNotice; }
          }
          rows.push({
            d: { title: f.title, artist: f.artist, format: f.ext, bitrate: '', status: 'done', progress: 100, path: f.path, size_str: f.size_str, dur: f.dur, cover: f.cover || null, source: hist?.source || '', downloadedFrom: scanVia, audioNotice: scanNotice },
            pct: 100, status: 'done', ready: true,
          });
        }
      } catch {}
    }
  }
  let pruned = false;
  let existsFn = null;
  if (isTauri()) {
    try { ({ exists: existsFn } = await import('@tauri-apps/plugin-fs')); } catch { existsFn = null; }
  }
  for (const d of S.downloads) {
    if (d.path && seenPaths.has(d.path)) continue;
    if (d.path && seenDlPaths.has(d.path)) continue;
    if (d.path) seenDlPaths.add(d.path);
    if (isArtifactFileName(d.path)) { d._gone = true; pruned = true; continue; }
    const pct = d.progress || 0;
    const status = d.status || 'done';
    if (status === 'failed') {
      rows.push({ d, pct, status, ready: false });
      continue;
    }
    if (d.path && folder && !activeDownloadIds.has(d.id) && !_isUnderFolder(d.path, folder)) {
      continue;
    }
    if (d.path && existsFn) {
      try {
        if (!(await existsFn(d.path))) {
          d._gone = true;
          pruned = true;
          continue;
        }
      } catch {
      }
    } else if (!d.path && !activeDownloadIds.has(d.id)) {
      if (d.status === 'downloading' && (d.progress || 0) < 100) {
        rows.push({ d, pct: d.progress || 0, status: d.status, ready: false });
        continue;
      }
      d._gone = true;
      pruned = true;
      continue;
    }
    rows.push({ d, pct, status, ready: status === 'done' && !!d.path });
  }
  if (pruned) {
    S.downloads = S.downloads.filter(d => !d._gone);
    saveDownloads();
  }
  S._visibleDL = rows.map(r=>selKeyDL(r.d));
  syncSelHeader('downloads');
  const _sigHist = S.downloads.map(d=>`${d.id}:${d.progress||0}:${d.status||''}:${d.path||''}`).join(';')
    + '|sel:' + [...S.selectedPaths.downloads].sort().join(',')
    + '|sm:' + (S.selectMode.downloads?1:0);
  let _needRender = force || (_sigHist !== S._dlHistSig);
  let _sigFile = S._dlFileSig || '';
  if (!_needRender) {
    try {
      const _stats = await Promise.all(rows.map(r => statLocal(r.d.path).catch(()=>null)));
      _sigFile = rows.map((r,i)=>`${r.d.path}|${_stats[i]?_stats[i].size+'|'+_stats[i].mtimeMs:'?'}|${r.pct}|${r.status}`).join(';');
    } catch {
      _sigFile = rows.map(r=>`${r.d.path}|?|${r.pct}|${r.status}`).join(';');
    }
    _needRender = (_sigFile !== S._dlFileSig);
  }
  if (!_needRender) return;
  S._dlHistSig = _sigHist; S._dlFileSig = _sigFile;
  if (countEl) countEl.textContent = rows.length ? `${rows.length} file` : '';
  S.lastDownloadPaths = rows.map(r=> r.d.path);
  if (S.downloadPlayback) {
    const pruned = S.downloadPlayback.paths.filter(p=> S.lastDownloadPaths.includes(p));
    if (pruned.length !== S.downloadPlayback.paths.length) {
      S.downloadPlayback.paths = pruned;
      if (!pruned.length) clearDownloadPlayback(); else saveDownloadPlayback();
    }
  }
  sortDownloadRows(rows);
  if (!rows.length) {
    const diag = [
      isTauri() ? `folder yang di-scan: ${folder || '(default)'}` : 'mode browser: scan folder nonaktif',
      `file ter-scan: ${scanCount}`,
      `riwayat tersimpan: ${S.downloads.length}`,
    ].join(' • ');
    listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">Belum ada download<br><span style="font-size:11px">Hasil download dari Pencarian Lagu akan muncul di sini (format ${S.downloadOptions.format.toUpperCase()}, kualitas asli sumber)</span><br><span style="font-size:10px; color:#8b93a9">${escAttr(diag)}</span></div>`;
    return;
  }
  listEl.innerHTML = '';
  rows.forEach(({ d, pct, status, ready }, i)=>{
    const b = document.createElement('div');
    b.className = 'track' + (ready && d.path && d.path === S.tracks[S.idx]?.path ? ' active' : '');
    b.style.cursor = ready ? 'pointer' : 'default';
    const cover = d.cover
      ? `<img src="${d.cover}" alt="cover" class="t-cover" loading="lazy" />`
      : `<div class="t-cover placeholder" style="background:var(--card2); display:grid; place-items:center">${ICON.download}</div>`;
    const kbpsTag = (d.audioNotice && d.audioNotice.actualKbps) ? ` • ${d.audioNotice.actualKbps}kbps${d.audioNotice.passthrough ? ' asli' : ''}` : '';
    const errTag = (status === 'failed' && d.error) ? ` • ${String(d.error).slice(0, 80)}` : '';
    const sub = d.bitrate ? `${d.artist} • ${d.format?.toUpperCase()||''} ${d.bitrate}kbps • ${status}${errTag}`
      : (d.size_str ? `${d.artist} • ${d.size_str}${kbpsTag}` : `${d.artist} • ${d.format?.toUpperCase()||''}${kbpsTag} • ${status}${errTag}`);
    const dirOnly = d.path ? String(d.path).split(/[\\/]/).slice(0, -1).join('\\') : '';
    const subLoc = dirOnly ? `<div class="t-sub dl-loc"><strong>Source</strong>:${escAttr(dirOnly)}</div>` : '';
    const durTxt = (d.dur && d.dur !== '--:--') ? d.dur : status;
    const checkCell = S.selectMode.downloads
      ? `<input type="checkbox" data-sel-dl="${i}" ${S.selectedPaths.downloads.has(selKeyDL(d))?'checked':''} title="Pilih">`
      : `<span style="color:#8b93a9">${i+1}</span>`;
    const failStyle = status === 'failed' ? ';color:#ff6b6b' : '';
    b.innerHTML = `${checkCell}<span class="t-main">${cover}<span><div class="t-title"${failStyle}>${d.title}${downloadProvenanceHtml(d)}</div><div class="t-sub">${sub}</div>${subLoc}</span></span><span class="c-type">${(d.format||'').toUpperCase()}</span><span class="c-size">${pct}%</span><span class="c-dur"${failStyle}>${durTxt}</span><span class="c-more"><div class="more-menu" data-dlmenu="${i}"><button data-edit-dl="${i}" title="Edit info lagu">${ICON.pencil} Edit info lagu</button><button data-enhance-dl="${i}">${ICON.sparkles} Enhance file</button>${d.path ? `<button data-iphone-dl="${i}" title="Import ke iPhone">${ICON.upload} Import to iPhone</button>` : ''}${d.path ? `<button data-reveal-dl="${i}" title="Buka lokasi file di Explorer">${ICON.folder} Buka lokasi file</button>` : ''}${(status === 'failed' && d.track) ? `<button data-redl="${i}" title="Download ulang dari sumber">${ICON.download} Download ulang</button>` : ''}</div></span>`;
    b.ondblclick = (e)=>{
      if (e.target.closest('[data-sel-dl]') || e.target.closest('.more-menu')) return;
      if (S.selectMode.downloads) { toggleSelDL(d); return; }
      if (ready) playDownloaded(d);
    };
    const selBox = b.querySelector('[data-sel-dl]');
    if (selBox) selBox.onchange = ()=>{ toggleSelDL(d); };
    const dlMenu = b.querySelector('.more-menu');
    if (dlMenu) dlMenu._dlRow = { d, ready };
    const editBtn = b.querySelector('[data-edit-dl]');
    if (editBtn) editBtn.onclick = (e)=>{ e.stopPropagation(); closePortalMenu(); editDownloaded(d); };
    const enhBtn = b.querySelector('[data-enhance-dl]');
    if (enhBtn) enhBtn.onclick = (e)=>{ e.stopPropagation(); if (enhBtn.disabled) return; closePortalMenu(); if (d.path) enhanceOneFile(d.path, `${d.artist || ''} - ${d.title || ''}`); };
    const iphDlBtn = b.querySelector('[data-iphone-dl]');
    if (iphDlBtn) iphDlBtn.onclick = (e)=>{ e.stopPropagation(); closePortalMenu(); if (d.path) handleLibraryDrop([d.path]); };
    const revealBtn = b.querySelector('[data-reveal-dl]');
    if (revealBtn) revealBtn.onclick = async (e)=>{
      e.stopPropagation();
      closePortalMenu();
      if (!d.path) return;
      try {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
        await revealItemInDir(d.path);
      } catch(err) {
        showToast('Gagal buka lokasi: ' + (err?.message || err), 4000);
      }
    };
    const redlBtn = b.querySelector('[data-redl]');
    if (redlBtn) redlBtn.onclick = async (e)=>{
      e.stopPropagation();
      closePortalMenu();
      if (!d.track) { showToast('Data track tidak tersimpan — cari ulang lagu lalu download', 4000); return; }
      if (d.status !== 'failed' || activeDownloadIds.has(d.id) || _redlBusy.has(d)) return;
      _redlBusy.add(d);
      try {
        const t = { ...d.track, title: d.track.title || d.title, artist: d.track.artist || d.artist };
        await startTrackDownload(t, { reuseEntry: d });
      } catch(err) {
        showToast('Download gagal: ' + (err?.message || err), 5000);
      } finally {
        _redlBusy.delete(d);
      }
    };
    listEl.appendChild(b);
  });
}
function applyDownloadedFrom(entry, cur){
  if (!entry || !cur) return;
  const next = String(cur.downloadedFrom || '');
  if (!next) return;
  if (next !== 'cache-hit') { entry.downloadedFrom = next; return; }
  if (entry.downloadedFrom && entry.downloadedFrom !== 'cache-hit') return;
  if (cur.path) {
    const prior = S.downloads.find(h => h !== entry && h.path === cur.path && h.downloadedFrom && h.downloadedFrom !== 'cache-hit');
    if (prior) { entry.downloadedFrom = prior.downloadedFrom; if (!entry.audioNotice && prior.audioNotice) entry.audioNotice = prior.audioNotice; return; }
  }
  entry.downloadedFrom = 'cache-hit';
}
function downloadProvenance(d){
  if (!d) return null;
  const via = String(d.downloadedFrom || '').toLowerCase();
  const noticeSrc = String(d.audioNotice?.source || '').toLowerCase();
  const orig = String(d.source || '').toLowerCase();
  let key = '';
  if (via && via !== 'cache-hit') key = via;
  else if (via === 'cache-hit') {
    if (noticeSrc && noticeSrc !== orig) key = noticeSrc;
    else return null;
  }
  else if (noticeSrc) key = noticeSrc;
  else if (orig) key = orig;
  if (!key) return null;
  let cls = '';
  let label = '';
  if (key.startsWith('spotify')) { cls = 'src-spotify'; label = 'Spotify'; }
  else if (key.startsWith('deezer')) { cls = 'src-deezer'; label = 'Deezer'; }
  else if (key.startsWith('soundcloud')) { cls = 'src-soundcloud'; label = 'SoundCloud'; }
  else if (key.startsWith('archive')) { cls = 'src-archive'; label = 'Archive'; }
  else if (key.startsWith('4shared')) { cls = 'src-4shared'; label = '4shared'; }
  else if (key.startsWith('youtube') || key.startsWith('ytmusic') || key === 'yt') { cls = 'src-youtube'; label = 'YouTube'; }
  else if (key.startsWith('itunes') || key.startsWith('apple')) { cls = 'src-itunes'; label = 'iTunes'; }
  else {
    const base = key.split('-')[0].replace(/[^a-z0-9]/g, '');
    if (!base) return null;
    cls = 'src-' + base;
    label = base.charAt(0).toUpperCase() + base.slice(1);
  }
  const title = via === 'cache-hit' ? `File sudah ada (${label})` : `Sumber unduhan: ${label}${via && via !== label.toLowerCase() ? ' · ' + via : ''}`;
  return { label, cls, title };
}
function downloadProvenanceHtml(d){
  const p = downloadProvenance(d);
  if (!p) return '';
  return `<span class="src-badge ${p.cls}" title="${p.title}">${p.label}</span>`;
}
async function trashPathToBin(p){
  if (!p || !isTauri()) return true;
  try {
    const r = await fetch('http://127.0.0.1:8001/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    const j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    return true;
  } catch (err) {
    try {
      const { exists, remove } = await import('@tauri-apps/plugin-fs');
      if (await exists(p)) await remove(p);
      return true;
    } catch { return false; }
  }
}
async function deleteSelectedPaths(scope, keys){
  let done = 0, failed = 0;
  const curPath = S.tracks[S.idx]?.path;
  let curDeleted = false;
  for (const key of keys) {
    const p = key.startsWith('p:') ? key.slice(2) : (scope === 'local' && key ? key : null);
    if (p) {
      if (!(await trashPathToBin(p))) {
        try {
          const { exists } = await import('@tauri-apps/plugin-fs');
          if (await exists(p)) { failed++; continue; }
        } catch { failed++; continue; }
      }
      pruneEnhMarker(p);
      pruneLyricOffset(p);
      if (p === curPath) curDeleted = true;
    }
    if (scope === 'downloads') {
      S.downloads = S.downloads.filter(x => selKeyDL(x) !== key);
    } else {
      const ti = S.tracks.findIndex(t => t.path === p);
      if (ti >= 0) S.tracks.splice(ti, 1);
      if (p) S.downloads = S.downloads.filter(x => x.path !== p);
    }
    done++;
  }
  saveDownloads();
  S.selectedPaths[scope].clear();
  if (S.downloadPlayback) {
    S.downloadPlayback.paths = S.downloadPlayback.paths.filter(p => !keys.includes('p:' + p));
    if (!S.downloadPlayback.paths.length) clearDownloadPlayback(); else saveDownloadPlayback();
  }
  for (const cp of [S.albumPlayback, S.artistPlayback]) {
    if (cp) cp.paths = cp.paths.filter(p => !keys.includes('p:' + p));
  }
  if (S.idx >= S.tracks.length) S.idx = Math.max(0, S.tracks.length - 1);
  if (curDeleted) {
    pause();
    if (S.tracks.length) load(S.idx, false);
    else { try { audio.removeAttribute('src'); audio.load(); } catch {} }
  }
  syncPlayerState();
  renderDownloads();
  renderTracks($('#globalSearch')?.value || '');
  showToast(`Hapus: ${done} berhasil${failed ? `, ${failed} gagal` : ''}`, 4000);
}
document.getElementById('btnDeleteSelected')?.addEventListener('click', async ()=>{
  const scope = S.activeView === 'downloads' ? 'downloads' : (S.activeView === 'local' ? 'local' : null);
  if (!scope) { showToast('Buka Local Music atau Downloads untuk menghapus seleksi', 2500); return; }
  const keys = [...S.selectedPaths[scope]];
  if (!keys.length) { showToast('Belum ada yang dipilih — aktifkan ☑ Select lalu centang lagu', 3000); return; }
  const ok = await showConfirm('Hapus File', `Hapus ${keys.length} file terpilih?\nFile fisik dipindahkan ke Recycle Bin.`);
  if (!ok) return;
  await deleteSelectedPaths(scope, keys);
});
document.getElementById('btnSelectLocal')?.addEventListener('click', ()=>{
  setSelectMode('local', !S.selectMode.local);
  renderTracks($('#globalSearch')?.value || '');
});
document.getElementById('btnRefreshLocal')?.addEventListener('click', async ()=>{
  const btn = document.getElementById('btnRefreshLocal');
  if (btn?.dataset.busy) return;
  if (!isTauri()) { showToast('Refresh hanya tersedia di aplikasi Tauri', 2500); return; }
  if (!getMusicFolders().length) { showToast('Belum ada folder — klik Add Folder dulu', 3000); return; }
  try {
    if (btn) { btn.dataset.busy = '1'; btn.classList.add('spinning'); }
    S._musicRescanAt = 0;
    await rescanMusicFolders();
    renderTracks($('#globalSearch')?.value || '');
    showToast('Library di-refresh', 2500);
  } catch {} finally {
    if (btn) { delete btn.dataset.busy; btn.classList.remove('spinning'); }
  }
});
document.getElementById('btnSelectDownloads')?.addEventListener('click', ()=>{
  setSelectMode('downloads', !S.selectMode.downloads);
  renderDownloads();
});
export { ensureDlWatcher, _isUnderFolder, applyDownloadedFrom, downloadProvenance, downloadProvenanceHtml, trashPathToBin, deleteSelectedPaths };
