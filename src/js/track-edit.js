import { t } from './i18n/core.js';
import { S } from './state.js';
import { $, audio } from './dom.js';
import { showAlert, showConfirm } from './modal.js';
import { ICON } from './icons.js';
import { migrateEnhMarker } from './enhance.js';
import { migrateLyricOffset } from './lyrics.js';
import { renderDownloads } from './downloads.js';
import { showToast } from './engine.js';
import { clearActiveCoverDrop, play, plPathIndex, refreshNpCoverIfCurrent, renderTracks, saveDownloadPlayback, saveDownloads, savePlaylists, wireCoverDrop } from '../app.js';

export async function editDownloaded(d){
  if (!d || !d.path) { await showAlert(t('topbar.downloads'), t('me.notDownloaded')); return; }
  let cur = { title: d.title || '', artist: d.artist || '', album: '' };
  let curCover = d.cover || null;
  let pendingDropCover = null;
  try {
    const r = await fetch(`http://127.0.0.1:8001/embed/tags?path=${encodeURIComponent(d.path)}`);
    if (r.ok) {
      const j = await r.json();
      if (j && j.ok) cur = { title: j.title || cur.title, artist: j.artist || cur.artist, album: j.album || '' };
    }
  } catch {}

  const modal = document.getElementById('appModal');
  if (!modal) return;
  const tEl = document.getElementById('modalTitle');
  const mEl = document.getElementById('modalMessage');
  let formWrap = document.getElementById('modalFormWrap');
  const single = document.getElementById('modalInput');
  if (!formWrap && single) {
    formWrap = document.createElement('div');
    formWrap.id = 'modalFormWrap';
    formWrap.style.display = 'flex';
    formWrap.style.flexDirection = 'column';
    formWrap.style.gap = '8px';
    single.after(formWrap);
  }
  const btnCancel = document.getElementById('modalCancel');
  const btnConfirm = document.getElementById('modalConfirm');
  const closeBtn = document.getElementById('modalClose');
  const backdrop = document.getElementById('modalBackdrop');
  const escAttr = (s)=> String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const coverHtml = curCover
    ? `<img src="${escAttr(curCover)}" alt="cover" style="max-width:120px; max-height:120px; border-radius:8px; border:1px solid var(--line);">`
    : `<div style="width:120px; height:120px; border-radius:8px; border:1px dashed var(--line); display:grid; place-items:center; color:var(--muted); font-size:11px">Belum ada cover</div>`;

  if (formWrap) {
    formWrap.style.display = 'block';
    formWrap.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; flex-direction:column; gap:8px;">
          <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Judul<input class="modal-input" data-field="title" value="${escAttr(cur.title)}" /></label>
          <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Artis<input class="modal-input" data-field="artist" value="${escAttr(cur.artist)}" /></label>
          <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Album<input class="modal-input" data-field="album" value="${escAttr(cur.album)}" /></label>
        </div>
        <div style="padding-top:8px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:10px;">
          <div>
            <label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">${t('me.coverCurrent')} (${t('me.coverCurrentHint')})</label>
            <div id="coverPrevBox" class="cover-drop">${coverHtml}</div>
            <input type="file" id="coverFileInput" accept="image/jpeg,image/png,image/webp" hidden>
          </div>
          <div>
            <label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">${t('me.coverUrlManual')}</label>
            <input type="url" id="coverUrlInput" class="modal-input" placeholder="https://...jpg atau https://...png" style="width:100%;">
            <div style="font-size:11px; color:var(--muted); margin-top:4px;">${t('me.coverAutoResolve')}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="autoResolveCover" checked>
            <label for="autoResolveCover" style="font-size:12px; cursor:pointer">${t('me.coverUrlAuto')}</label>
          </div>
          <button id="btnRemoveCover" class="btn-more"${curCover ? '' : ' disabled'} style="flex:1; background:var(--card2); color:var(--muted); border:1px solid var(--line);"${curCover ? '' : ' title="Belum ada cover"'}>${ICON.trash} Hapus Cover</button>
        </div>
      </div>
    `;
  } else if (single) {
    single.style.display = 'none';
  }

  tEl.textContent = t('me.editInfoTitle');
  mEl.style.display = 'none';
  btnCancel.style.display = 'block';
  btnCancel.textContent = t('modal.cancel');
  btnConfirm.textContent = t('me.save');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');

  const cleanup = () => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    btnConfirm.removeEventListener('click', onConfirm);
    btnCancel.removeEventListener('click', onCancel);
    closeBtn.removeEventListener('click', onCancel);
    backdrop.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKey);
    clearActiveCoverDrop();
    if (formWrap) formWrap.style.display = 'none';
  };
  const reopenEdit = () => {
    tEl.textContent = t('me.editInfoTitle');
    mEl.style.display = 'none';
    if (formWrap) formWrap.style.display = 'block';
    if (single) single.style.display = 'none';
    btnCancel.style.display = 'block';
    btnCancel.textContent = t('modal.cancel');
    btnConfirm.textContent = t('me.save');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  };
  const withNestedDialog = async (fn) => {
    btnConfirm.removeEventListener('click', onConfirm);
    try { return await fn(); }
    finally {
      reopenEdit();
      btnConfirm.addEventListener('click', onConfirm);
    }
  };

  const applyCover = async (path, title, artist, album, coverUrl, autoResolve, coverData) => {
    try {
      const r = await fetch('http://127.0.0.1:8001/embed/cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, coverUrl: coverUrl || undefined, coverData: coverData || undefined, autoResolve: coverData ? false : autoResolve, title, artist, album, spotifyClientId: localStorage.getItem('spotify_client_id') || '', spotifyClientSecret: localStorage.getItem('spotify_client_secret') || '' })
      });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.error) || 'unknown');
      const newCover = (j.coverUrl === 'embedded' && coverData) ? coverData : (j.coverUrl && j.coverUrl !== 'auto-resolved' ? j.coverUrl : null);
      if (newCover) {
        for (const t of S.tracks) { if (t.path === path) t.cover = newCover; }
        for (const x of S.downloads) { if (x.path === path) x.cover = newCover; }
        refreshNpCoverIfCurrent(path);
      }
    } catch (err) {
      const msg = String(err?.message || err);
      const stale = !!coverData && /tidak ditemukan|auto-resolve|not found/i.test(msg);
      await showAlert(t('me.editInfoTitle'), t('me.coverFailed', { n: msg }) + (stale ? t('me.coverStale') : ''));
    }
  };

  const onConfirm = async () => {
    const title = formWrap?.querySelector('[data-field="title"]')?.value?.trim() || '';
    const artist = formWrap?.querySelector('[data-field="artist"]')?.value?.trim() || '';
    const album = formWrap?.querySelector('[data-field="album"]')?.value?.trim() || '';
    if (!title) { await withNestedDialog(() => showAlert(t('me.editInfoTitle'), t('me.titleEmpty'))); return; }
    const coverUrl = document.getElementById('coverUrlInput')?.value?.trim() || '';
    const autoResolve = document.getElementById('autoResolveCover')?.checked !== false;
    cleanup();
    let res, httpStatus = 0, rawBody = '';
    try {
      const r = await fetch('http://127.0.0.1:8001/embed/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: d.path, title, artist, album }) });
      httpStatus = r.status;
      rawBody = await r.text();
      try { res = JSON.parse(rawBody); } catch { res = null; }
    } catch (err) {
          await withNestedDialog(() => showAlert(t('topbar.downloads'), t('te.editFailUnreachable', { n: err?.message || err })));
      return;
    }
    if (!res || !res.ok) {
      const detail = (res && res.error) || (res && res.detail) || rawBody.slice(0, 200) || `HTTP ${httpStatus}`;
      await withNestedDialog(() => showAlert(t('topbar.downloads'), t('te.editFailHttp', { code: httpStatus, n: detail }) + (httpStatus === 404 && rawBody.includes('Not Found') ? t('me.coverStale') : '')));
      return;
    }
    const { oldPath, newPath } = res;
    migrateEnhMarker(oldPath, newPath);
    migrateLyricOffset(oldPath, newPath);
    for (const x of S.downloads) {
      if (x === d || x.id === d.id || x.path === oldPath) {
        x.title = title; x.artist = artist; x.album = album; x.path = newPath;
      }
    }
    saveDownloads();
    const wasCurrent = S.tracks[S.idx]?.path === oldPath;
    const wasPlaying = wasCurrent && !audio.paused;
    const pos = audio.currentTime || 0;
    for (const t of S.tracks) {
      if (t.path === oldPath) {
        t.title = title; t.artist = artist; t.album = album; t.path = newPath; t.name = newPath.split(/[/\\]/).pop() || t.name;
        (async()=>{ try { const { convertFileSrc } = await import('@tauri-apps/api/core'); t.url = convertFileSrc(newPath); } catch {}})();
      }
    }
    let plTouched = false;
    for (const p of S.playlists) {
      const pi = plPathIndex(p, oldPath);
      if (pi >= 0) { p.trackPaths[pi] = newPath; plTouched = true; }
    }
    if (plTouched) savePlaylists();
    if (S.downloadPlayback) {
      const di = S.downloadPlayback.paths.indexOf(oldPath);
      if (di >= 0) { S.downloadPlayback.paths[di] = newPath; saveDownloadPlayback(); }
    }
    for (const cp of [S.albumPlayback, S.artistPlayback]) {
      if (cp) { const ci = cp.paths.indexOf(oldPath); if (ci >= 0) cp.paths[ci] = newPath; }
    }
    await applyCover(newPath, title, artist, album, coverUrl, autoResolve, pendingDropCover);
    renderTracks($('#globalSearch')?.value || '');
    renderDownloads();
    if (wasCurrent) {
      try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        audio.src = convertFileSrc(newPath);
        try { audio.currentTime = pos; } catch {}
        if (wasPlaying) play();
        $('#npTitle').textContent = title;
        $('#npArtist').textContent = artist;
        refreshNpCoverIfCurrent(newPath);
      } catch {}
    }
    showToast(t('te.infoSaved'), 3000);
  };

  const onCancel = () => cleanup();
  const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

  btnConfirm.addEventListener('click', onConfirm);
  btnCancel.addEventListener('click', onCancel);
  closeBtn.addEventListener('click', onCancel);
  backdrop.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey);
  wireCoverDrop(document.getElementById('coverPrevBox'), document.getElementById('coverFileInput'), (url) => {
    if (!String(url || '').startsWith('data:image/')) return;
    pendingDropCover = url;
    const box = document.getElementById('coverPrevBox');
    if (box) box.innerHTML = `<img src="${url}" alt="cover" style="max-width:120px; max-height:120px; border-radius:8px; border:1px solid var(--line);">`;
  });

  const removeBtn = document.getElementById('btnRemoveCover');
  if (removeBtn) {
    removeBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (removeBtn.disabled) return;
      const ok = await withNestedDialog(() => showConfirm(t('me.deleteCover'), t('te.delCoverQ', { n: cur.title + ' - ' + cur.artist })));
      if (!ok) return;
      try {
        const r = await fetch('http://127.0.0.1:8001/embed/cover', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: d.path })
        });
        const j = await r.json();
        if (!j || !j.ok) {
          await withNestedDialog(() => showAlert(t('me.deleteCover'), t('te.coverFail', { n: (j && j.error) || 'unknown' })));
          return;
        }
        d.cover = null;
        for (const t of S.tracks) {
          if (t.path === d.path) { t.cover = null; }
        }
        renderDownloads();
        renderTracks($('#globalSearch')?.value || '');
        refreshNpCoverIfCurrent(d.path);
        cleanup();
        showToast(t('me.coverRemoved'), 3000);
      } catch (err) {
        await withNestedDialog(() => showAlert(t('me.deleteCover'), t('te.coverFail', { n: err?.message || err })));
      }
    };
  }
}
async function editLocalTrack(tIdx){
  const tk = S.tracks[tIdx];
  if (!tk || !tk.path) { await showAlert(t('topbar.local'), t('me.noFile')); return; }
  const d = { path: tk.path, title: tk.title, artist: tk.artist, cover: tk.cover || null };
  let cur = { title: tk.title || '', artist: tk.artist || '', album: '' };
  let curCover = tk.cover || null;
  let pendingDropCoverLocal = null;
  try {
    const r = await fetch(`http://127.0.0.1:8001/embed/tags?path=${encodeURIComponent(tk.path)}`);
    if (r.ok) {
      const j = await r.json();
      if (j && j.ok) cur = { title: j.title || cur.title, artist: j.artist || cur.artist, album: j.album || '' };
    }
  } catch {}
  const modal = document.getElementById('appModal');
  if (!modal) return;
  const tEl = document.getElementById('modalTitle');
  const mEl = document.getElementById('modalMessage');
  let formWrap = document.getElementById('modalFormWrap');
  const single = document.getElementById('modalInput');
  if (!formWrap && single) {
    formWrap = document.createElement('div');
    formWrap.id = 'modalFormWrap';
    formWrap.style.display = 'flex';
    formWrap.style.flexDirection = 'column';
    formWrap.style.gap = '8px';
    single.after(formWrap);
  }
  const btnCancel = document.getElementById('modalCancel');
  const btnConfirm = document.getElementById('modalConfirm');
  const closeBtn = document.getElementById('modalClose');
  const backdrop = document.getElementById('modalBackdrop');
  const escAttr2 = (s)=> String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const coverHtml2 = curCover
    ? `<img src="${escAttr2(curCover)}" alt="cover" style="max-width:120px; max-height:120px; border-radius:8px; border:1px solid var(--line);">`
    : `<div style="width:120px; height:120px; border-radius:8px; border:1px dashed var(--line); display:grid; place-items:center; color:var(--muted); font-size:11px">Belum ada cover</div>`;
  if (formWrap) {
    formWrap.style.display = 'block';
    formWrap.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; flex-direction:column; gap:8px;">
          <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Judul<input class="modal-input" data-field="title" value="${escAttr2(cur.title)}" /></label>
          <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Artis<input class="modal-input" data-field="artist" value="${escAttr2(cur.artist)}" /></label>
          <label style="font-size:11px; color:var(--muted); display:flex; flex-direction:column; gap:4px">Album<input class="modal-input" data-field="album" value="${escAttr2(cur.album)}" /></label>
        </div>
        <div style="padding-top:8px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:10px;">
          <div>
            <label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">${t('me.coverCurrent')} (${t('me.coverCurrentHint')})</label>
            <div id="coverPrevBox" class="cover-drop">${coverHtml2}</div>
            <input type="file" id="coverFileInput" accept="image/jpeg,image/png,image/webp" hidden>
          </div>
          <div>
            <label style="font-size:11px; color:var(--muted); display:block; margin-bottom:4px;">${t('me.coverUrlManual')}</label>
            <input type="url" id="coverUrlInputLocal" class="modal-input" placeholder="https://...jpg atau https://...png" style="width:100%;">
            <div style="font-size:11px; color:var(--muted); margin-top:4px;">${t('me.coverAutoResolve')}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="autoResolveCoverLocal" checked>
            <label for="autoResolveCoverLocal" style="font-size:12px; cursor:pointer">${t('me.coverUrlAuto')}</label>
          </div>
          <button id="btnRemoveCoverLocal" class="btn-more"${curCover ? '' : ' disabled'} style="flex:1; background:var(--card2); color:var(--muted); border:1px solid var(--line);"${curCover ? '' : ' title="Belum ada cover"'}>${ICON.trash} Hapus Cover</button>
        </div>
      </div>
    `;
  } else if (single) { single.style.display = 'none'; }
  tEl.textContent = t('me.editInfoTitle');
  mEl.style.display = 'none';
  btnCancel.style.display = 'block';
  btnCancel.textContent = t('modal.cancel');
  btnConfirm.textContent = t('me.save');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  const cleanup2 = () => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    btnConfirm.removeEventListener('click', onConfirm2);
    btnCancel.removeEventListener('click', onCancel2);
    closeBtn.removeEventListener('click', onCancel2);
    backdrop.removeEventListener('click', onCancel2);
    document.removeEventListener('keydown', onKey2);
    clearActiveCoverDrop();
    if (formWrap) formWrap.style.display = 'none';
  };
  const reopenEdit2 = () => {
    tEl.textContent = t('me.editInfoTitle');
    mEl.style.display = 'none';
    if (formWrap) formWrap.style.display = 'block';
    if (single) single.style.display = 'none';
    btnCancel.style.display = 'block';
    btnCancel.textContent = t('modal.cancel');
    btnConfirm.textContent = t('me.save');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  };
  const withNestedDialog2 = async (fn) => {
    btnConfirm.removeEventListener('click', onConfirm2);
    try { return await fn(); }
    finally {
      reopenEdit2();
      btnConfirm.addEventListener('click', onConfirm2);
    }
  };
  const applyCoverLocal = async (path, title, artist, album, coverUrl, autoResolve, coverData) => {
    try {
      const r = await fetch('http://127.0.0.1:8001/embed/cover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, coverUrl: coverUrl || undefined, coverData: coverData || undefined, autoResolve: coverData ? false : autoResolve, title, artist, album, spotifyClientId: localStorage.getItem('spotify_client_id') || '', spotifyClientSecret: localStorage.getItem('spotify_client_secret') || '' }) });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.error) || 'unknown');
      const newCoverLocal = (j.coverUrl === 'embedded' && coverData) ? coverData : (j.coverUrl && j.coverUrl !== 'auto-resolved' ? j.coverUrl : null);
      if (newCoverLocal) {
        for (const tr of S.tracks) { if (tr.path === path) tr.cover = newCoverLocal; }
        for (const x of S.downloads) { if (x.path === path) x.cover = newCoverLocal; }
        refreshNpCoverIfCurrent(path);
      }
    } catch (err) {
      const msg = String(err?.message || err);
      const stale = !!coverData && /tidak ditemukan|auto-resolve|not found/i.test(msg);
      await showAlert(t('me.editInfoTitle'), t('me.coverFailed', { n: msg }) + (stale ? t('me.coverStale') : ''));
    }
  };
  const onConfirm2 = async () => {
    const title2 = formWrap?.querySelector('[data-field="title"]')?.value?.trim() || '';
    const artist2 = formWrap?.querySelector('[data-field="artist"]')?.value?.trim() || '';
    const album2 = formWrap?.querySelector('[data-field="album"]')?.value?.trim() || '';
    if (!title2) { await withNestedDialog2(() => showAlert(t('me.editInfoTitle'), t('me.titleEmpty'))); return; }
    const coverUrl2 = document.getElementById('coverUrlInputLocal')?.value?.trim() || '';
    const autoResolve2 = document.getElementById('autoResolveCoverLocal')?.checked !== false;
    cleanup2();
    let res2, httpStatus2 = 0, rawBody2 = '';
    try {
      const r = await fetch('http://127.0.0.1:8001/embed/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tk.path, title: title2, artist: artist2, album: album2 }) });
      httpStatus2 = r.status; rawBody2 = await r.text();
      try { res2 = JSON.parse(rawBody2); } catch { res2 = null; }
    } catch (err) { await withNestedDialog2(() => showAlert(t('topbar.local'), t('te.editFailUnreachable', { n: err?.message || err }))); return; }
    if (!res2 || !res2.ok) {
      const detail2 = (res2 && res2.error) || (res2 && res2.detail) || rawBody2.slice(0, 200) || `HTTP ${httpStatus2}`;
      await withNestedDialog2(() => showAlert(t('topbar.local'), t('te.editFailHttp', { code: httpStatus2, n: detail2 })));
      return;
    }
    const { oldPath: oldPath2, newPath: newPath2 } = res2;
    migrateEnhMarker(oldPath2, newPath2);
    migrateLyricOffset(oldPath2, newPath2);
    for (const x of S.downloads) { if (x.path === oldPath2) { x.title = title2; x.artist = artist2; x.album = album2; x.path = newPath2; } }
    try { saveDownloads(); } catch {}
    const wasCurrent2 = S.tracks[S.idx]?.path === oldPath2;
    const wasPlaying2 = wasCurrent2 && !audio.paused;
    const pos2 = audio.currentTime || 0;
    for (const tr of S.tracks) {
      if (tr.path === oldPath2) { tr.title = title2; tr.artist = artist2; tr.album = album2; tr.path = newPath2; tr.name = newPath2.split(/[/\\]/).pop() || tr.name; (async()=>{ try { const { convertFileSrc } = await import('@tauri-apps/api/core'); tr.url = convertFileSrc(newPath2); } catch {}})(); }
    }
    let plTouched2 = false;
    for (const p of S.playlists) { const pi = plPathIndex(p, oldPath2); if (pi >= 0) { p.trackPaths[pi] = newPath2; plTouched2 = true; } }
    if (plTouched2) savePlaylists();
    if (S.downloadPlayback) { const di = S.downloadPlayback.paths.indexOf(oldPath2); if (di >= 0) { S.downloadPlayback.paths[di] = newPath2; saveDownloadPlayback(); } }
    for (const cp of [S.albumPlayback, S.artistPlayback]) {
      if (cp) { const ci = cp.paths.indexOf(oldPath2); if (ci >= 0) cp.paths[ci] = newPath2; }
    }
    await applyCoverLocal(newPath2, title2, artist2, album2, coverUrl2, autoResolve2, pendingDropCoverLocal);
    renderTracks($('#globalSearch')?.value || '');
    try { renderDownloads(); } catch {}
    if (wasCurrent2) {
      try { const { convertFileSrc } = await import('@tauri-apps/api/core'); audio.src = convertFileSrc(newPath2); try { audio.currentTime = pos2; } catch {} if (wasPlaying2) play(); $('#npTitle').textContent = title2; $('#npArtist').textContent = artist2; refreshNpCoverIfCurrent(newPath2); } catch {}
    }
    showToast(t('te.infoSaved'), 3000);
  };
  const onCancel2 = () => cleanup2();
  const onKey2 = (e) => { if (e.key === 'Escape') onCancel2(); };
  btnConfirm.addEventListener('click', onConfirm2);
  btnCancel.addEventListener('click', onCancel2);
  closeBtn.addEventListener('click', onCancel2);
  backdrop.addEventListener('click', onCancel2);
  document.addEventListener('keydown', onKey2);
  wireCoverDrop(document.getElementById('coverPrevBox'), document.getElementById('coverFileInput'), (url) => {
    if (!String(url || '').startsWith('data:image/')) return;
    pendingDropCoverLocal = url;
    const box = document.getElementById('coverPrevBox');
    if (box) box.innerHTML = `<img src="${url}" alt="cover" style="max-width:120px; max-height:120px; border-radius:8px; border:1px solid var(--line);">`;
  });
  const removeBtn2 = document.getElementById('btnRemoveCoverLocal');
  if (removeBtn2) {
    removeBtn2.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (removeBtn2.disabled) return;
      const ok2 = await withNestedDialog2(() => showConfirm(t('me.deleteCover'), t('te.delCoverQ', { n: cur.title + ' - ' + cur.artist })));
      if (!ok2) return;
      try {
        const r = await fetch('http://127.0.0.1:8001/embed/cover', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tk.path }) });
        const j = await r.json();
        if (!j || !j.ok) { await withNestedDialog2(() => showAlert(t('me.deleteCover'), t('te.coverFail', { n: (j && j.error) || 'unknown' }))); return; }
        tk.cover = null; d.cover = null;
        for (const tr of S.tracks) { if (tr.path === tk.path) tr.cover = null; }
        renderTracks($('#globalSearch')?.value || '');
        try { renderDownloads(); } catch {}
        refreshNpCoverIfCurrent(tk.path);
        cleanup2();
        showToast(t('me.coverRemoved'), 3000);
      } catch (err) { await withNestedDialog2(() => showAlert(t('me.deleteCover'), t('te.coverFail', { n: err?.message || err }))); }
    };
  }
}
export { editLocalTrack };
