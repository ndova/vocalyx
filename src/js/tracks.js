import { t } from './i18n/core.js';
import { S } from './state.js';
import { trackListEl } from './dom.js';
import { localLibraryTracks, albumKeyOf, clearPlaylistPlayback, clearCollectionPlayback, clearDownloadPlayback, playlistTracks, plPathIndex, savePlaylists, uid } from './library.js';
import { syncSelHeader, selKeyLocal, toggleSelLocal } from './bulk-select.js';
import { karaokeBadgeHtml, karaokeProgressHtml, showToast, separate, isKaraokeBlocked } from './engine.js';
import { coverHtml, escAttr } from './format.js';
import { ICON } from './icons.js';
import { load } from './player.js';
import { openMediaPlayer } from './media-player.js';
import { prefetchVolumeGain } from './audio-core.js';
import { applyGridWidths } from './grid.js';
import { paintEnhanceItem, enhanceOneFile } from './enhance.js';
import { editLocalTrack } from './track-edit.js';
import { handleLibraryDrop } from './iphone-import.js';
import { renderPlaylistDetail, renderPlaylistsOverview, groupArtists, groupAlbums, playCollection, pickCoverQuad, collectionCoverStack, renderMainView } from './views.js';
import { showPrompt, showConfirm } from './modal.js';
import { deleteSelectedPaths } from './downloads.js';

function renderLocalCollection(filter, kind){
  const f = (filter || '').toLowerCase();
  if (kind === 'artist') {
    let groups = groupArtists();
    if (f) groups = groups.filter(g => g.name.toLowerCase().includes(f));
    if (!groups.length) {
      trackListEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:14px">${t('tr.noArtistMatch')}<br><span style="font-size:12px">${t('tr.noArtistMatchHint')}</span></div>`;
      return;
    }
    trackListEl.innerHTML = `<div class="playlist-grid">` + groups.map(g=>{
      const key = encodeURIComponent(g.name);
      const quad = pickCoverQuad('artist:' + key, g.tracks);
      const coverStack = quad.length === 4
        ? `<div class="pl-cover-quad">${quad.map(c => `<img src="${c}" alt="" loading="lazy">`).join('')}</div>`
        : collectionCoverStack(g.tracks);
      return `<div class="pl-card" data-key="${key}"><div class="pl-cover-stack">${coverStack}<button class="cover-play" data-play-artist="${key}" aria-label="${t('tr.playArtist')}">${ICON.play}</button></div><div class="pl-name">${escAttr(g.name)}</div><div class="pl-meta">${t('std.songs', { n: g.tracks.length })}</div></div>`;
    }).join('') + `</div>`;
    trackListEl.querySelectorAll('[data-play-artist]').forEach(b=>{
      b.onclick=(e)=>{ e.stopPropagation(); const k2 = decodeURIComponent(b.dataset.playArtist); const g2 = groupArtists().find(x=> x.name===k2); if(!g2) return; playCollection('artist', g2.name, g2.tracks.map(t=>t.path)); };
    });
    trackListEl.querySelectorAll('.pl-card').forEach(c=>{
      c.onclick=(e)=>{ if(e.target.closest('button')) return; S.activeArtistKey = decodeURIComponent(c.dataset.key); S.activeView='artist:'+c.dataset.key; document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active')); document.querySelector('[data-nav="local"]')?.classList.add('active'); renderMainView(); };
    });
    return;
  }
  let groups = groupAlbums();
  if (f) groups = groups.filter(g=> g.name.toLowerCase().includes(f) || [...g.artists].some(a=> a.toLowerCase().includes(f)));
  if (!groups.length) {
    trackListEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:14px">${t('tr.noAlbumMatch')}<br><span style="font-size:12px">${t('tr.noArtistMatchHint')}</span></div>`;
    return;
  }
  trackListEl.innerHTML = `<div class="playlist-grid">` + groups.map(g=>{
    const key = encodeURIComponent(g.name);
    const artistTxt = [...g.artists].slice(0, 3).join(', ') + (g.artists.size > 3 ? '…' : '');
    return `<div class="pl-card" data-key="${key}"><div class="pl-cover-stack">${collectionCoverStack(g.tracks)}<button class="cover-play" data-play-album="${key}" aria-label="${t('tr.playAlbum')}">${ICON.play}</button></div><div class="pl-name">${escAttr(g.name)}</div><div class="pl-meta">${escAttr(artistTxt)} • ${t('std.songs', { n: g.tracks.length })}</div></div>`;
  }).join('') + `</div>`;
  trackListEl.querySelectorAll('[data-play-album]').forEach(b=>{
    b.onclick=(e)=>{ e.stopPropagation(); const k2 = decodeURIComponent(b.dataset.playAlbum); const g2 = groupAlbums().find(x=> x.name===k2); if(!g2) return; playCollection('album', g2.name, g2.tracks.map(t=>t.path)); };
  });
  trackListEl.querySelectorAll('.pl-card').forEach(c=>{
    c.onclick=(e)=>{ if(e.target.closest('button')) return; S.activeAlbumKey = decodeURIComponent(c.dataset.key); S.activeView='album:'+c.dataset.key; document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active')); document.querySelector('[data-nav="local"]')?.classList.add('active'); renderMainView(); };
  });
}
export function renderTracks(filter = '') {
  trackListEl.innerHTML = '';
  let visibleNo = 0;
  S._visibleLocal = [];
  if (localLibraryTracks().length === 0) {
    trackListEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:14px;line-height:1.6">${t('lib.emptyTitle')}<br><span style="font-size:12px">${t('lib.emptyHint')}</span></div>`;
    syncSelHeader('local');
    return;
  }
  const filterType = document.getElementById('localSearchFilter')?.value || 'all';
  const headEl = document.getElementById('tableHead');
  if (filterType === 'artist' || filterType === 'album') {
    if (headEl) headEl.style.display = 'none';
    renderLocalCollection(filter, filterType);
    syncSelHeader('local');
    return;
  }
  if (headEl) headEl.style.display = '';
  S.tracks.forEach((tk, i) => {
    if (tk.fromDownloads) return;
    if (filter) {
      const f = filter.toLowerCase();
      let hay = '';
      if (filterType === 'title') hay = tk.title || '';
      else if (filterType === 'artist') hay = tk.artist || '';
      else if (filterType === 'album') hay = albumKeyOf(tk);
      else hay = `${tk.title || ''} ${tk.artist || ''} ${albumKeyOf(tk)}`;
      if (!hay.toLowerCase().includes(f)) return;
    }
    visibleNo++;
    S._visibleLocal.push(selKeyLocal(tk.path));
    const b = document.createElement('button');
    b.className = 'track' + (i === S.idx ? ' active' : '');
    if (tk.path) b.dataset.tpath = tk.path;
    const hasLyric = tk.lyric_path ? ' ♪' : '';
    const kBadge = karaokeBadgeHtml(tk);
    const checkCell = S.selectMode.local
      ? `<input type="checkbox" data-sel="${i}" ${S.selectedPaths.local.has(selKeyLocal(tk.path))?'checked':''} title="${t('std.select')}">`
      : `<span style="color:#8b93a9">${visibleNo}</span>`;
    b.innerHTML = `
      ${checkCell}
      <span class="t-main">${coverHtml(tk)}
        <span><div class="t-title">${tk.title}${hasLyric}${kBadge}</div><div class="t-sub">${tk.artist}</div>${karaokeProgressHtml(tk)}</span>
      </span>
      <span class="c-type">${(tk.ext || '').toUpperCase()}</span>
      <span class="c-size">${tk.size_str || '--'}</span>
      <span class="c-dur">${tk.dur || '--:--'}</span>
      <span class="c-more"><div class="more-menu" data-menu="${i}"><button data-karaoke-row="${i}" style="display:none"></button><button data-edit-track="${i}">${ICON.pencil} ${t('me.editInfo')}</button><button data-enhance-track="${i}">${ICON.sparkles} ${t('me.enhanceFile')}</button><button data-iphone-import="${i}">${ICON.upload} ${t('me.importToIphone')}</button><button data-del-track="${i}">${ICON.trash} ${t('modal.delete')}</button><button data-action="addToPlaylist" data-idx="${i}">${ICON.listPlus} ${t('me.addToPlaylist')} ${ICON.chevronRight}</button><div class="submenu" id="submenu-${i}"></div></div></span>`;
    const selBox = b.querySelector('[data-sel]');
    if (selBox) {
      selBox.onchange = ()=>{ toggleSelLocal(tk.path); };
    }
    b.onclick = async (e) => {
      if (e.target.closest('input') || e.target.closest('.more-menu') || e.target.closest('button')) return;
      if (S.selectMode.local) { toggleSelLocal(tk.path); return; }
      if (!tk.path) return;
      clearPlaylistPlayback();
      clearCollectionPlayback();
      clearDownloadPlayback();
      openMediaPlayer(tk, { rowEl: b });
    };
    b.addEventListener('mouseenter', () => prefetchVolumeGain(tk.path), { once: true });
    trackListEl.appendChild(b);
  });
  syncSelHeader('local');
  applyGridWidths();
}
export function openPortalMenu(menu, btn){
  closePortalMenu();
  const portal = document.getElementById('menuPortal');
  if (!portal || !menu || !btn) return;
  menu._home = menu.parentElement;
  portal.appendChild(menu);
  menu.classList.add('open');
  menu.style.visibility = 'hidden';
  menu.style.position = 'fixed';
  menu.style.top = '0px';
  menu.style.left = '0px';
  menu.style.right = 'auto';
  menu.style.bottom = 'auto';
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 120;
  const pad = 8;
  const anchor = S._menuAnchor;
  S._menuAnchor = null;
  let left;
  let top = anchor ? anchor.y : r.bottom + 4;
  if (anchor) {
    left = anchor.x;
  } else {
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    if (spaceBelow < mh + pad && spaceAbove > spaceBelow) top = r.top - mh - 4;
    left = r.right - mw;
  }
  top = Math.max(pad, Math.min(top, window.innerHeight - mh - pad));
  left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - mw - pad));
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.style.visibility = '';
  S.portalOpenedAt = Date.now();
}
export function closePortalMenu(){
  document.querySelectorAll('#menuPortal .more-menu.open').forEach(m=>{
    m.classList.remove('open');
    m.style.position = '';
    m.style.top = '';
    m.style.left = '';
    m.style.right = '';
    m.style.bottom = '';
    m.style.visibility = '';
    const home = m._home;
    m._home = null;
    if (home && home.isConnected) home.appendChild(m);
    else m.remove();
  });
}
function openRowMenu(row, anchor){
  const openMenu = document.querySelector('#menuPortal .more-menu.open');
  const sameRowOpen = !!(openMenu && openMenu._home && row.contains(openMenu._home));
  closePortalMenu();
  const menu = row.querySelector('.more-menu');
  if (!menu || sameRowOpen) return;
  S._menuAnchor = anchor || null;
  openPortalMenu(menu, row);
  const eb = menu.querySelector('[data-enhance-track]');
  if (eb) { const tt = S.tracks[parseInt(menu.dataset.menu, 10)]; paintEnhanceItem(eb, tt?.path, tt?.ext, true); }
  const ebDl = menu.querySelector('[data-enhance-dl]');
  if (ebDl && menu._dlRow) paintEnhanceItem(ebDl, menu._dlRow.d.path, menu._dlRow.d.format, menu._dlRow.ready);
  const submenu = menu.querySelector('.submenu');
  const idx = menu.dataset.menu;
  if (submenu) {
    const head = `<div class="submenu-head">${t('pl.playlist')}</div>`;
    if (S.playlists.length===0) {
      submenu.innerHTML = head + `<button data-create="${idx}" class="submenu-create">${ICON.plus} ${t('me.newPlaylist')}</button>`;
      submenu.classList.add('open');
    } else {
      submenu.innerHTML = head + S.playlists.map(p=> `<button data-playlist-id="${p.id}" data-idx="${idx}" title="${escAttr(p.name)}">${escAttr(p.name)} <span class="submenu-count">(${playlistTracks(p).length})</span></button>`).join('') + `<button data-create="${idx}" class="submenu-create">${ICON.plus} </button>`;
      submenu.classList.add('open');
    }
  }
  const kRow = menu.querySelector('[data-karaoke-row]');
  if (kRow) {
    const tk = S.tracks[parseInt(menu.dataset.menu, 10)];
    const running = !!(tk && tk.karaoke_job);
    const hasResult = !!(tk && tk.karaoke_path);
    if (hasResult || !tk) {
      kRow.style.display = 'none';
    } else {
      kRow.style.display = '';
      kRow.innerHTML = running
        ? `${ICON.x} ${t('me.karaokeCancel')}`
        : `${ICON.musicSm} ${t('me.karaokeMake')}`;
      kRow.disabled = !running && (isKaraokeBlocked(tk) || !!S.karaokeJobId);
    }
  }
}
const menuScopeOk = (el) => !!el && (trackListEl.contains(el) || !!el.closest('#menuPortal'));
document.addEventListener('click', (e)=>{
  const closeRowMenu = (btn) => {
    btn.closest('.more-menu')?.classList.remove('open');
    closePortalMenu();
    document.querySelectorAll('.submenu.open').forEach(m=>m.classList.remove('open'));
  };
  const kRow = e.target.closest('[data-karaoke-row]');
  if (kRow && menuScopeOk(kRow)) {
    e.stopPropagation();
    if (kRow.disabled) return;
    const tIdx = parseInt(kRow.dataset.karaokeRow, 10);
    const t = S.tracks[tIdx];
    closeRowMenu(kRow);
    if (!t || t.karaoke_path || (S.karaokeJobId && !t.karaoke_job)) return;
    separate('karaoke', tIdx).catch(() => {});
    return;
  }
  const editBtn = e.target.closest('[data-edit-track]');
  if (editBtn && menuScopeOk(editBtn)) {
    e.stopPropagation();
    const tIdx = parseInt(editBtn.dataset.editTrack, 10);
    editBtn.closest('.more-menu')?.classList.remove('open');
    closePortalMenu();
    document.querySelectorAll('.submenu.open').forEach(m=>m.classList.remove('open'));
    editLocalTrack(tIdx);
    return;
  }
  const enhBtn = e.target.closest('[data-enhance-track]');
  if (enhBtn && menuScopeOk(enhBtn)) {
    e.stopPropagation();
    if (enhBtn.disabled) return;
    const tIdx = parseInt(enhBtn.dataset.enhanceTrack, 10);
    const t = S.tracks[tIdx];
    enhBtn.closest('.more-menu')?.classList.remove('open');
    closePortalMenu();
    document.querySelectorAll('.submenu.open').forEach(m=>m.classList.remove('open'));
    if (t?.path) enhanceOneFile(t.path, `${t.artist || ''} - ${t.title || ''}`);
    return;
  }
  const iphBtn = e.target.closest('[data-iphone-import]');
  if (iphBtn && menuScopeOk(iphBtn)) {
    e.stopPropagation();
    const tIdx = parseInt(iphBtn.dataset.iphoneImport, 10);
    const t = S.tracks[tIdx];
    iphBtn.closest('.more-menu')?.classList.remove('open');
    closePortalMenu();
    document.querySelectorAll('.submenu.open').forEach(m=>m.classList.remove('open'));
    if (t?.path) handleLibraryDrop([t.path]);
    else showToast(t('loc.fileNotFound'), 3000);
    return;
  }
  const delBtn = e.target.closest('[data-del-track]');
  if (delBtn && menuScopeOk(delBtn)) {
    e.stopPropagation();
    const tIdx = parseInt(delBtn.dataset.delTrack, 10);
    const tk = S.tracks[tIdx];
    delBtn.closest('.more-menu')?.classList.remove('open');
    closePortalMenu();
    document.querySelectorAll('.submenu.open').forEach(m=>m.classList.remove('open'));
    if (!tk) return;
    (async()=>{
      const ok = await showConfirm(t('confirm.deleteFile'), t('confirm.deleteSelected', { n: 1 }));
      if (!ok) return;
      await deleteSelectedPaths('local', [selKeyLocal(tk.path)]);
    })();
    return;
  }
  const plBtn = e.target.closest('[data-playlist-id]');
  if (plBtn && menuScopeOk(plBtn)) {
    e.stopPropagation();
    const pId = plBtn.dataset.playlistId;
    const tIdx = parseInt(plBtn.dataset.idx,10);
    const pl = S.playlists.find(p=>p.id===pId);
    const t = S.tracks[tIdx];
    if (!pl || !t) return;
    if (plPathIndex(pl, t.path) < 0) { pl.trackPaths.push(t.path); savePlaylists(); }
    plBtn.closest('.more-menu')?.classList.remove('open');
    closePortalMenu();
    if (S.activeView.startsWith('playlist:')) renderPlaylistDetail(S.activePlaylistId);
    else if (S.activeView==='playlists') renderPlaylistsOverview();
    return;
  }
  const createBtn = e.target.closest('[data-create]');
  if (createBtn && menuScopeOk(createBtn)) {
    e.stopPropagation();
    const tIdx = parseInt(createBtn.dataset.create,10);
    const tk = S.tracks[tIdx];
    (async()=>{
      const name = await showPrompt(t('modal.createPlaylist'), t('modal.enterPlaylistName'), '');
      if (!name || !name.trim()) return;
      const pl = { id: uid(), name: name.trim(), trackPaths: tk ? [tk.path] : [], createdAt: Date.now() };
      S.playlists.push(pl);
      savePlaylists();
      createBtn.closest('.more-menu')?.classList.remove('open');
      closePortalMenu();
      if (S.activeView==='playlists') renderPlaylistsOverview();
    })();
    return;
  }
  const addBtn = e.target.closest('[data-action="addToPlaylist"]');
  if (addBtn && menuScopeOk(addBtn)) {
    e.stopPropagation();
    const submenu = addBtn.nextElementSibling;
    if (submenu) {
      submenu.classList.toggle('open');
      addBtn.classList.toggle('open', submenu.classList.contains('open'));
    }
    return;
  }
});
document.addEventListener('click', (e)=>{
  if (e.target instanceof Element && !e.target.closest('.more-menu') && !e.target.closest('.btn-more')) {
    closePortalMenu();
    document.querySelectorAll('.submenu.open').forEach(m=>m.classList.remove('open'));
  }
});
document.addEventListener('scroll', (e)=>{ if (Date.now() - S.portalOpenedAt < 350) return; const tgt = e.target; const onList = tgt instanceof Element && tgt.closest('#trackList, #downloadList, #iphoneTrackList'); const onDoc = tgt === document || tgt === document.documentElement || tgt === document.scrollingElement; if (onList || onDoc) closePortalMenu(); }, true);
window.addEventListener('resize', ()=>{ closePortalMenu(); });
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closePortalMenu(); });
document.addEventListener('contextmenu', (e)=>{
  if (!(e.target instanceof Element)) return;
  const row = e.target.closest('.track');
  if (row && row.closest('#trackList, #downloadList, #iphoneTrackList')) {
    e.preventDefault();
    openRowMenu(row, { x: e.clientX, y: e.clientY });
    return;
  }
  if (e.target.closest(
    'input[type="text"], input:not([type]), input[type="search"], input[type="password"], ' +
    'input[type="number"], input[type="email"], input[type="url"], ' +
    'textarea, [contenteditable="true"], [contenteditable=""]'
  )) {
    closePortalMenu();
    return;
  }
  closePortalMenu();
  e.preventDefault();
});



export { openRowMenu, menuScopeOk };
