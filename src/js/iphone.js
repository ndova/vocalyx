import { S } from './state.js';
import { sortIPhoneTracks } from './sorting.js';
import { fmt, coverHtml } from './format.js';
import { ICON } from './icons.js';
import { applyGridWidths } from './grid.js';
import { clearActiveCoverDrop, wireCoverDrop } from './download-start.js';
import { showToast } from './engine.js';
import { showConfirm } from './modal.js';
import { invokeTauri } from './tauri.js';
import { AUDIO_EXT_RE, closePortalMenu, handleLibraryDrop, openPortalMenu } from '../app.js';

async function checkIPhoneConnected() {
  try {
    const r = await fetch('http://127.0.0.1:8001/iphone/devices');
    const j = await r.json();
    const connected = !!(j.ok && j.devices?.length);
    const statusEl = document.getElementById('deviceStatusText');
    const metaEl = document.getElementById('deviceMeta');
    const dot = document.getElementById('deviceConnDot');
    const badge = document.getElementById('iphoneLibraryCount');
    const listEl = document.getElementById('iphoneTrackList');
    const countEl = document.getElementById('iphoneTrackCount');
    if (connected) {
      if (dot) dot.style.background = 'var(--accent)';
      if (statusEl) statusEl.textContent = `Terhubung: ${j.devices[0].name} • iOS ${j.devices[0].ios}`;
      if (metaEl) metaEl.textContent = `${j.devices[0].model} • ${j.devices[0].identifier.slice(0,8)}…`;
      try {
        const lr = await fetch('http://127.0.0.1:8001/iphone/library');
        const lj = await lr.json();
        if (badge && lj.ok) {
          badge.style.display = '';
          badge.textContent = `iPhone • ${lj.library_count} lagu • ${j.devices[0].ios}`;
        }
      } catch {}
      if (S._prevIPhoneConnected === false && S.activeView === 'device') loadIPhoneLibrary();
    } else {
      if (dot) dot.style.background = 'var(--muted)';
      if (statusEl) statusEl.textContent = 'Tidak terhubung — hubungkan iPhone via USB';
      if (metaEl) metaEl.textContent = '';
      if (badge) badge.style.display = 'none';
      if (listEl) listEl.innerHTML = `<div style="padding:12px; text-align:center; color:var(--muted); font-size:11px">Hubungkan iPhone via USB untuk lihat library</div>`;
      if (countEl) countEl.textContent = '';
      S.iphoneTracks = [];
      S.iphoneSelected.clear();
      const exp = document.getElementById('btnDeviceExportSelected');
      const del = document.getElementById('btnDeviceDeleteSelected');
      if (exp) exp.disabled = true;
      if (del) del.disabled = true;
    }
    S._prevIPhoneConnected = connected;
    return connected;
  } catch {
    const statusEl = document.getElementById('deviceStatusText');
    if (statusEl) statusEl.textContent = 'Engine offline — jalankan `npm run engine`';
    S._prevIPhoneConnected = false;
    return false;
  }
}
export async function renderDeviceView(){
  const connected = await checkIPhoneConnected();
  if (connected) loadIPhoneLibrary();
  else {
    const listEl = document.getElementById('iphoneTrackList');
    if (listEl && !listEl.innerHTML) listEl.innerHTML = `<div style="padding:12px; text-align:center; color:var(--muted); font-size:11px">Hubungkan iPhone via USB untuk lihat library</div>`;
  }
}
function setupIPhoneCoverLazy(root) {
  if (S._iphCoverObs) { S._iphCoverObs.disconnect(); S._iphCoverObs = null; }
  if (!root || !('IntersectionObserver' in window)) return;
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      obs.unobserve(el);
      const pid = el.dataset.iphCover;
      if (!pid) continue;
      const img = new Image();
      img.className = 't-cover';
      img.alt = 'cover';
      img.src = `http://127.0.0.1:8001/iphone/track/cover?item_pid=${pid}&v=${el.dataset.iphCoverV || 0}`;
      img.onload = () => el.replaceWith(img);
    }
  }, { root, rootMargin: '80px' });
  root.querySelectorAll('[data-iph-cover]').forEach(el => obs.observe(el));
  S._iphCoverObs = obs;
}
function setIPhoneHeadVisible(on){
  const head = document.getElementById('iphoneTableHead');
  if (head) head.style.display = on ? '' : 'none';
}
export function iphoneTypeOf(t){
  const p = t.location || t.full_path || '';
  const dot = p.lastIndexOf('.');
  return dot >= 0 ? p.slice(dot + 1).toUpperCase() : '';
}
function iphoneSizeStr(bytes){
  if (!bytes) return '--';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
export async function loadIPhoneLibrary(){
  const listEl = document.getElementById('iphoneTrackList');
  const countEl = document.getElementById('iphoneTrackCount');
  if (!listEl) return;
  setIPhoneHeadVisible(false);
  listEl.innerHTML = `<div style="padding:12px; text-align:center; color:var(--muted); font-size:11px"><div class="spinner small"></div> Memuat...</div>`;
  try {
    const r = await fetch('http://127.0.0.1:8001/iphone/library/tracks?limit=500');
    const j = await r.json();
    if (!j.ok) { listEl.innerHTML = `<div style="padding:12px; text-align:center; color:var(--muted)">Gagal: ${j.error||''}</div>`; return; }
    S.iphoneTracks = j.tracks || [];
    sortIPhoneTracks();
    const withFile = S.iphoneTracks.filter(t => t.full_path).length;
    if (countEl) countEl.textContent = `(${S.iphoneTracks.length} lagu, ${withFile} dengan file)`;
    S.iphoneSelected.clear();
    updateIPhoneSelectionUI();
    if (!S.iphoneTracks.length) { listEl.innerHTML = `<div style="padding:48px 12px;text-align:center;color:var(--muted)">Library kosong<div style="font-size:11px;margin-top:6px">Seret &amp; letakkan file musik ke area ini untuk import ke iPhone</div></div>`; return; }
    setIPhoneHeadVisible(true);
    listEl.innerHTML = '';
    const hdrCb = document.querySelector('#iphoneTableHead [data-iphone-sel-all]');
    if (hdrCb) {
      hdrCb.checked = false;
      hdrCb.onchange = () => {
        if (hdrCb.checked) { S.iphoneTracks.forEach(t => { if (t.full_path) S.iphoneSelected.add(String(t.item_pid)); }); }
        else { S.iphoneSelected.clear(); }
        listEl.querySelectorAll('[data-iphone-sel]').forEach(cb => { cb.checked = S.iphoneSelected.has(cb.dataset.iphoneSel); });
        updateIPhoneSelectionUI();
      };
    }
    S.iphoneTracks.forEach((t) => {
      const b = document.createElement('div');
      b.className = 'track';
      b.dataset.pid = t.item_pid;
      const dur = t.duration_ms ? fmt(Math.floor(t.duration_ms/1000)) : '--:--';
      const hasFile = !!t.full_path;
      const type = iphoneTypeOf(t);
      const sizeStr = iphoneSizeStr(t.file_size);
      const statusIcon = hasFile ? '' : '<span style="color:var(--muted); font-size:10px; margin-left:4px" title="File tidak ada di device">⊘</span>';
      b.style.opacity = hasFile ? '1' : '0.5';
      let cov = coverHtml(t);
      if (hasFile) {
        cov = cov.replace('class="t-cover placeholder"',
          `class="t-cover placeholder" data-iph-cover="${t.item_pid}" data-iph-cover-v="${t.file_size || 0}"`);
      }
      b.innerHTML = `<input type="checkbox" data-iphone-sel="${t.item_pid}" ${S.iphoneSelected.has(String(t.item_pid))?'checked':''} ${hasFile ? '' : 'disabled'}><span class="t-main">${cov}<span><div class="t-title">${t.title}${statusIcon}</div><div class="t-sub">${t.artist} • ${t.album}</div></span></span><span class="c-type">${type}</span><span class="c-size">${sizeStr}</span><span class="c-dur">${dur}</span>${hasFile ? `<span class="c-more"><div class="more-menu" data-iph-menum="${t.item_pid}"><button data-iph-edit="${t.item_pid}">${ICON.pencil} Edit info & cover</button></div></span>` : `<span class="c-more"></span>`}`;
      const cb = b.querySelector('[data-iphone-sel]');
      if (cb) {
        cb.onchange = ()=>{ const pid=String(t.item_pid); if (cb.checked) S.iphoneSelected.add(pid); else S.iphoneSelected.delete(pid); updateIPhoneSelectionUI(); };
      }
      b.onclick = (e)=>{ if (e.target.closest('input') || e.target.closest('.more-menu') || !hasFile) return; const pid=String(t.item_pid); if (S.iphoneSelected.has(pid)) S.iphoneSelected.delete(pid); else S.iphoneSelected.add(pid); const c=b.querySelector('[data-iphone-sel]'); if(c) c.checked=S.iphoneSelected.has(pid); updateIPhoneSelectionUI(); };
      listEl.appendChild(b);
    });
    applyGridWidths();
    setupIPhoneCoverLazy(listEl);
  } catch (e) {
    setIPhoneHeadVisible(false);
    listEl.innerHTML = `<div style="padding:12px; text-align:center; color:var(--muted)">Gagal load: ${e.message}</div>`;
  }
}
function updateIPhoneSelectionUI(){
  const exp = document.getElementById('btnDeviceExportSelected');
  const del = document.getElementById('btnDeviceDeleteSelected');
  const n = S.iphoneSelected.size;
  if (exp) exp.disabled = n===0;
  if (del) del.disabled = n===0;
  if (exp) exp.innerHTML = n ? `${ICON.download} Export Terpilih (${n})` : `${ICON.download} Export Terpilih`;
  const selectable = S.iphoneTracks.filter(t => t.full_path).length;
  const hdrCb = document.querySelector('#iphoneTableHead [data-iphone-sel-all]');
  if (hdrCb && selectable) hdrCb.checked = n === selectable;
}
function iphoneTrackByPid(pid) {
  return S.iphoneTracks.find(t => String(t.item_pid) === String(pid));
}
const iphMenuScopeOk = (el) => {
  const list = document.getElementById('iphoneTrackList');
  return !!el && ((!!list && list.contains(el)) || !!el.closest('#menuPortal'));
};
document.addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-iph-edit]');
  if (editBtn && !iphMenuScopeOk(editBtn)) return;
  if (editBtn) {
    e.stopPropagation();
    editBtn.closest('.more-menu')?.classList.remove('open');
    closePortalMenu();
    openIPhoneEditModal(editBtn.dataset.iphEdit);
    return;
  }
});
const _iphModalEls = () => ({
  modal: document.getElementById('appModal'),
  tEl: document.getElementById('modalTitle'),
  mEl: document.getElementById('modalMessage'),
  formWrap: document.getElementById('modalFormWrap'),
  btnCancel: document.getElementById('modalCancel'),
  btnConfirm: document.getElementById('modalConfirm'),
  closeBtn: document.getElementById('modalClose'),
  backdrop: document.getElementById('modalBackdrop'),
});
const _iphEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function _iphModalShell(title, formHtml, onConfirm) {
  const { modal, tEl, mEl, formWrap, btnCancel, btnConfirm, closeBtn, backdrop } = _iphModalEls();
  if (!modal || !formWrap) return;
  formWrap.style.display = 'block';
  formWrap.innerHTML = formHtml;
  tEl.textContent = title;
  mEl.style.display = 'none';
  btnCancel.style.display = 'block';
  btnCancel.textContent = 'Batal';
  btnConfirm.textContent = 'Simpan';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  const cleanup = () => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    btnConfirm.removeEventListener('click', onConfirmWrap);
    btnCancel.removeEventListener('click', onCancel);
    closeBtn.removeEventListener('click', onCancel);
    backdrop.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKey);
    clearActiveCoverDrop();
    formWrap.style.display = 'none';
  };
  const onCancel = () => { cleanup(); };
  const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
  const onConfirmWrap = () => { onConfirm(cleanup); };
  btnConfirm.addEventListener('click', onConfirmWrap);
  btnCancel.addEventListener('click', onCancel);
  closeBtn.addEventListener('click', onCancel);
  backdrop.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey);
  return cleanup;
}
async function openIPhoneEditModal(pid) {
  const t = iphoneTrackByPid(pid);
  if (!t) return;
  let pendingIphDrop = null;
  const cleanupForm = _iphModalShell('Edit Info & Cover (iPhone)', `
    <div style="display:flex; flex-direction:column; gap:8px;">
      <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Judul<input class="modal-input" id="iphEditTitle" value="${_iphEsc(t.title)}" /></label>
      <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Artis<input class="modal-input" id="iphEditArtist" value="${_iphEsc(t.artist)}" /></label>
      <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Album<input class="modal-input" id="iphEditAlbum" value="${_iphEsc(t.album)}" /></label>
    </div>
    <div style="padding-top:8px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:10px; margin-top:8px;">
      <div>
        <label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">Cover Saat Ini</label>
        <div id="iphCoverPrev" style="display:flex; align-items:center; gap:8px;">
          <span id="iphCoverSpin" style="font-size:11px; color:var(--muted);">Memuat cover…</span>
          <img src="http://127.0.0.1:8001/iphone/track/cover?item_pid=${Number(pid)}&v=${t.file_size || 0}" alt="cover" style="max-width:120px; max-height:120px; border-radius:8px; border:1px solid var(--line);" onload="__iphCoverLoaded(this)" onerror="__iphCoverFallback(this)" />
        </div>
        <input type="file" id="iphCoverFileInput" accept="image/jpeg,image/png,image/webp" hidden>
      </div>
      <div>
        <label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">URL Cover Manual (opsional)</label>
        <input type="url" id="iphCoverUrlInput" class="modal-input" placeholder="https://...jpg atau https://...png" style="width:100%;">
        <div style="font-size:11px; color:var(--muted); margin-top:4px;">Kosongkan untuk auto-resolve via iTunes/Deezer</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="iphAutoResolveCover" checked>
        <label for="iphAutoResolveCover" style="font-size:12px; cursor:pointer">Auto-resolve bila URL kosong</label>
      </div>
      <button id="iphBtnRemoveCover" class="btn-more" style="background:var(--card2); color:var(--muted); border:1px solid var(--line);">${ICON.trash} Hapus Cover</button>
    </div>`, async (cleanup) => {
    const title = document.getElementById('iphEditTitle')?.value?.trim() || '';
    const artist = document.getElementById('iphEditArtist')?.value?.trim() || '';
    const album = document.getElementById('iphEditAlbum')?.value?.trim() || '';
    const url = document.getElementById('iphCoverUrlInput')?.value?.trim() || '';
    const auto = document.getElementById('iphAutoResolveCover')?.checked !== false;
    cleanup();
    if (!title) { showToast('Judul tidak boleh kosong', 3000); return; }
    try {
      const r = await fetch('http://127.0.0.1:8001/iphone/track/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_pid: Number(pid), title, artist, album }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '');
      if (j.changed !== false) showToast('Info lagu diperbarui', 3000);
      const coverData = pendingIphDrop || undefined;
      if (url || auto || coverData) {
        const rc = await fetch('http://127.0.0.1:8001/iphone/track/cover', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_pid: Number(pid), mode: coverData ? 'url' : (url ? 'url' : 'auto'), coverUrl: url || undefined, coverData, title, artist, album, spotifyClientId: localStorage.getItem('spotify_client_id') || '', spotifyClientSecret: localStorage.getItem('spotify_client_secret') || '' }),
        });
        const jc = await rc.json();
        if (!jc.ok) throw new Error(jc.error || '');
        t._iphHasCover = true;
        showToast('Cover diperbarui — force-quit lalu buka lagi app Music iPhone', 5000);
      } else if (j.changed === false) {
        showToast('Tidak ada perubahan', 3000);
      }
      loadIPhoneLibrary();
    } catch (e) {
      const msg = String(e.message || e);
      const stale = !!pendingIphDrop && /tidak ditemukan|auto-resolve|not found/i.test(msg);
      showToast('Gagal simpan: ' + msg + (stale ? ' — engine Python versi lama, restart python-engine/server.py' : ''), 5000);
    }
  });
  setTimeout(() => document.getElementById('iphEditTitle')?.focus(), 50);
  document.getElementById('iphBtnRemoveCover')?.addEventListener('click', async () => {
    if (document.getElementById('iphBtnRemoveCover')?.disabled) return;
    cleanupForm();
    const sure = await showConfirm('Hapus Cover', `Hapus cover "${_iphEsc(t.title)}"?`);
    if (!sure) return;
    try {
      const r = await fetch('http://127.0.0.1:8001/iphone/track/cover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_pid: Number(pid), mode: 'remove' }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '');
      t._iphHasCover = false;
      showToast('Cover dihapus', 3000);
      loadIPhoneLibrary();
    } catch (e) { showToast('Gagal hapus cover: ' + e.message, 4000); }
  });
  try {
    const iphRmBtn = document.getElementById('iphBtnRemoveCover');
    if (iphRmBtn) {
      const setIphRmBtn = (has, checking) => {
        if (!iphRmBtn.isConnected) return;
        iphRmBtn.disabled = !has;
        iphRmBtn.innerHTML = `${ICON.trash} ${checking ? 'Cek cover…' : 'Hapus Cover'}`;
        if (!has && !checking) iphRmBtn.title = 'Belum ada cover';
        else iphRmBtn.removeAttribute('title');
      };
      const listEl = document.getElementById('iphoneTrackList');
      const imgDone = !!(listEl && listEl.querySelector(`img.t-cover[src*="item_pid=${pid}"]`));
      if (t._iphHasCover === true || imgDone) {
        if (t._iphHasCover !== true) t._iphHasCover = true;
        setIphRmBtn(true, false);
      } else if (t._iphHasCover === false) {
        setIphRmBtn(false, false);
      } else {
        setIphRmBtn(false, true);
        const probe = new Image();
        let settled = false;
        const finish = (has) => {
          if (settled) return; settled = true;
          clearTimeout(timer);
          t._iphHasCover = has;
          setIphRmBtn(has, false);
        };
        const timer = setTimeout(() => finish(false), 10000);
        probe.onload = () => finish(true);
        probe.onerror = () => finish(false);
        probe.src = `http://127.0.0.1:8001/iphone/track/cover?item_pid=${pid}&v=${t.file_size || 0}`;
      }
    }
  } catch {}
  wireCoverDrop(document.getElementById('iphCoverPrev'), document.getElementById('iphCoverFileInput'), (url) => {
    if (!String(url || '').startsWith('data:image/')) return;
    pendingIphDrop = url;
    const box = document.getElementById('iphCoverPrev');
    if (box) box.innerHTML = `<img src="${url}" alt="cover" style="max-width:120px; max-height:120px; border-radius:8px; border:1px solid var(--line);" />`;
  });
}
checkIPhoneConnected();
setInterval(checkIPhoneConnected, 15000);
document.getElementById('btnDeviceRefresh')?.addEventListener('click', () => { checkIPhoneConnected(); loadIPhoneLibrary(); showToast('Refresh...', 2000); });

function setExportProgress(pct, text) {
  const bar = document.getElementById('exportProgressBar');
  const fill = document.getElementById('exportProgressFill');
  const txt = document.getElementById('exportProgressText');
  const cancel = document.getElementById('btnCancelExport');
  if (bar) bar.style.display = pct >= 0 ? '' : 'none';
  if (fill) fill.style.width = Math.min(100, pct) + '%';
  if (txt) txt.textContent = text || '';
  if (cancel) cancel.style.display = pct >= 0 && pct < 100 ? '' : 'none';
}

function pollExportJob(jobId) {
  if (S._exportPollTimer) clearInterval(S._exportPollTimer);
  S._exportJobId = jobId;
  S._exportPollTimer = setInterval(async () => {
    try {
      const r = await fetch('http://127.0.0.1:8001/iphone/export_progress?job_id=' + jobId);
      const j = await r.json();
      if (j.status === 'done') {
        clearInterval(S._exportPollTimer); S._exportPollTimer = null; S._exportJobId = null;
        const ok = (j.results || []).filter(r => r.ok).length;
        const fail = (j.results || []).filter(r => !r.ok).length;
        setExportProgress(100, `Selesai: ${ok} berhasil${fail ? `, ${fail} gagal` : ''}`);
        showToast(`Export selesai: ${ok} file`, 4000);
        setTimeout(() => setExportProgress(-1, ''), 4000);
      } else if (j.status === 'error') {
        clearInterval(S._exportPollTimer); S._exportPollTimer = null; S._exportJobId = null;
        setExportProgress(0, 'Error: ' + (j.error || 'Unknown'));
      } else if (j.status === 'cancelled') {
        clearInterval(S._exportPollTimer); S._exportPollTimer = null; S._exportJobId = null;
        setExportProgress(0, 'Dibatalkan');
        setTimeout(() => setExportProgress(-1, ''), 2000);
      } else {
        const total = j.total || 1, done = j.done || 0;
        const pct = j.pct || 0;
        const cur = j.current ? ` — ${j.current}` : '';
        setExportProgress(pct, `Export ${done}/${total}${cur}`);
      }
    } catch {}
  }, 800);
}

async function exportBatchToDir(pids, dir) {
  if (!pids.length) return;
  setExportProgress(0, `Menyiapkan export ${pids.length} lagu...`);
  try {
    const r = await fetch('http://127.0.0.1:8001/iphone/export_batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pids, output_dir: dir })
    });
    const j = await r.json();
    if (!j.ok) { setExportProgress(0, 'Gagal: ' + (j.error || '')); return; }
    pollExportJob(j.job_id);
  } catch (e) { setExportProgress(0, 'Error: ' + e.message); }
}

document.getElementById('btnCancelExport')?.addEventListener('click', async () => {
  if (S._exportJobId) {
    try { await fetch('http://127.0.0.1:8001/iphone/export_cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: S._exportJobId }) }); } catch {}
  }
});

document.getElementById('btnDeviceExportAll')?.addEventListener('click', async () => {
  if (!S.iphoneTracks.length) { showToast('Library kosong', 3000); return; }
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, title: 'Pilih folder export' });
    if (!dir) return;
    const pids = S.iphoneTracks.filter(t => t.full_path).map(t => t.item_pid);
    if (!pids.length) { showToast('Tidak ada lagu dengan file di device', 3000); return; }
    exportBatchToDir(pids, dir);
  } catch (e) { showToast('Error: ' + e.message, 4000); }
});

document.getElementById('btnDeviceExportSelected')?.addEventListener('click', async () => {
  const pids = [...S.iphoneSelected];
  if (!pids.length) { showToast('Pilih lagu dulu (centang ☑)', 3000); return; }
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, title: 'Pilih folder export' });
    if (!dir) return;
    exportBatchToDir(pids.map(Number), dir);
  } catch (e) { showToast('Error: ' + e.message, 4000); }
});

document.getElementById('btnDeviceDeleteSelected')?.addEventListener('click', async () => {
  const pids = [...S.iphoneSelected];
  if (!pids.length) return;
  const ok = await showConfirm('Hapus dari iPhone', `Hapus ${pids.length} lagu dari iPhone?`);
  if (!ok) return;
  for (const pid of pids) {
    try {
      const r = await fetch('http://127.0.0.1:8001/iphone/track?item_pid=' + pid, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error||'');
    } catch (e) { showToast('Hapus gagal: ' + e.message, 4000); }
  }
  showToast(`${pids.length} lagu dihapus`, 3000);
  S.iphoneSelected.clear();
  loadIPhoneLibrary();
  checkIPhoneConnected();
});

{
  const btn = document.getElementById('btnDeviceImport');
  const menu = document.getElementById('deviceImportMenu');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu && !menu.classList.contains('open');
    closePortalMenu();
    if (willOpen) openPortalMenu(menu, btn);
  });
  document.getElementById('btnImportFile')?.addEventListener('click', async () => {
    closePortalMenu();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const sel = await open({
        multiple: true,
        title: 'Pilih file audio',
        filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac', 'wma'] }],
      });
      if (!sel) return;
      const paths = Array.isArray(sel) ? sel : [sel];
      if (!paths.length) return;
      await handleLibraryDrop(paths);
    } catch (e) {
      showToast('Import file dibatalkan: ' + ((e && e.message) || e), 3000);
    }
  });
  document.getElementById('btnImportFolder')?.addEventListener('click', async () => {
    closePortalMenu();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false, title: 'Pilih folder musik' });
      if (!dir) return;
      const files = await invokeTauri('scan_music', { dir });
      const paths = (files || []).map(f => f.path).filter(p => AUDIO_EXT_RE.test(p));
      if (!paths.length) { showToast('Tidak ada file audio di folder itu', 3000); return; }
      await handleLibraryDrop(paths);
    } catch (e) {
      showToast('Import folder gagal: ' + ((e && e.message) || e), 4000);
    }
  });
}
export { checkIPhoneConnected, setupIPhoneCoverLazy, setIPhoneHeadVisible, iphoneSizeStr, updateIPhoneSelectionUI, iphoneTrackByPid, iphMenuScopeOk, _iphModalEls, _iphEsc, _iphModalShell, openIPhoneEditModal, setExportProgress, pollExportJob, exportBatchToDir };
