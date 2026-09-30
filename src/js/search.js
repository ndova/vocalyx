import { S } from './state.js';
import { escAttr, fmt } from './format.js';
import { applySearchGridWidths } from './grid.js';
import { ICON } from './icons.js';
import { ico } from './icons-tabler.js';
import { startTrackDownload, onlineCoverHtml } from './download-start.js';
import { showToast } from './engine.js';
import { pause } from './player.js';
import { playPreviewAudio, stopPreview, isPreviewPlaying } from '../app.js';

const SEARCH_PER_PAGE = 20;
let _activePvBtn = null;
function searchLoaderHtml(big = true, q = '') {
  const label = q ? `Mencari '${escAttr(q)}'...` : 'Mencari...';
  const icon = `<svg class="sl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
  if (big) {
    return `<div id="searchLoader" class="search-loading-center" role="status" aria-live="polite">
      <div class="sl-stack">
        <div class="search-loading-pulse"></div>
        <div class="search-loading-spinner"></div>
        ${icon}
      </div>
      <div class="search-loading-text">${label}</div>
      <div class="search-loading-dots"><span></span><span></span><span></span></div>
    </div>`;
  }
  return `<div id="searchLoader" class="search-loading-center search-loading-center--sm" role="status" aria-live="polite">
    <div class="sl-stack sl-stack--sm">
      <div class="search-loading-pulse"></div>
      <div class="search-loading-spinner"></div>
      ${icon}
    </div>
  </div>`;
}

window.__coverFallback = function (img) {
  const d = document.createElement('div');
  d.className = 't-cover placeholder';
  d.style.background = 'var(--card2)';
  d.style.fontSize = '10px';
  d.textContent = img.dataset.initials || '?';
  img.replaceWith(d);
};
window.__iphCoverFallback = function (img) {
  try {
    const spin = document.getElementById('iphCoverSpin');
    if (spin) spin.remove();
  } catch {}
  const d = document.createElement('div');
  d.style.cssText = 'width:120px; height:120px; border-radius:8px; border:1px dashed var(--line); display:grid; place-items:center; color:var(--muted); font-size:11px';
  d.textContent = 'Belum ada cover';
  try { img.replaceWith(d); } catch {}
};
window.__iphCoverLoaded = function (img) {
  try {
    const spin = document.getElementById('iphCoverSpin');
    if (spin) spin.remove();
  } catch {}
};

export async function renderSearchView(){
  const qEl = document.getElementById('searchViewInput');
  const listEl = document.getElementById('searchTrackList');
  const statusEl = document.getElementById('searchStatus');
  if (!qEl || !listEl) return;
  const q = (qEl.value || '').trim();
  const filterEl = document.getElementById('searchFilter');
  const filter = filterEl ? filterEl.value : 'all';
  const sourceEl = document.getElementById('searchSource');
  const source = sourceEl ? sourceEl.value : 'all';
  try { localStorage.setItem('vocalyx_searchSource_v1', source); } catch {}
  if (!q) {
    listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">Ketik kata kunci, lalu tekan <b>Enter</b> untuk pencarian lagu<br><span style="font-size:11px">Hasil pencarian online akan muncul di sini</span></div>`;
    if (statusEl) statusEl.textContent = '';
    return;
  }
  if (S.searchOnlineTimer) clearTimeout(S.searchOnlineTimer);
  const myReq = ++S.searchReqId;
  const SRC_LABEL = { spotify: 'Spotify', deezer: 'Deezer', soundcloud: 'SoundCloud', archive: 'Archive.org', '4shared': '4shared' };
  if (statusEl) statusEl.textContent = `Mencari online "${q}" di ${SRC_LABEL[source] || 'Spotify / SoundCloud / 4shared / Archive.org'}...`;
  listEl.innerHTML = searchLoaderHtml(true, q);
  applySearchGridWidths();
  const run = async ()=>{
    if (myReq !== S.searchReqId) return;
    try {
      const r = await fetch('http://127.0.0.1:8001/search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query:q, type: filter, source, limit:100, clientId: localStorage.getItem('spotify_client_id') || '', clientSecret: localStorage.getItem('spotify_client_secret') || '' }) });
      if (myReq !== S.searchReqId) return;
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      const online = data.tracks || [];
      const dbg = data.debug || {};
      const dbgSummary = Object.entries(dbg).map(([k, v]) => {
        const label = { spotify: 'Spotify', deezer: 'Deezer', soundcloud: 'SoundCloud', archive: 'Archive', fourshared: '4shared' }[k] || k;
        if (!v) return null;
        if (!v.ok) return `${label} ✗${v.error ? ' (' + String(v.error).slice(0, 40) + ')' : ''}`;
        return `${label} ${v.count}`;
      }).filter(Boolean).join(' • ');
      const allFailed = Object.values(dbg).length > 0 && Object.values(dbg).every(v => v && !v.ok);
      listEl.querySelector('#searchLoader')?.remove();
      if (!online.length) {
        if (allFailed) {
          listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">Semua sumber pencarian gagal.<br><span style="font-size:11px">Cek Python engine / koneksi, lalu Enter ulang</span></div>`;
          if (statusEl) statusEl.textContent = `Gagal semua sumber untuk "${q}"${dbgSummary ? ' — ' + dbgSummary : ''}`;
        } else {
          listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">Tidak ada hasil.<br><span style="font-size:11px">${escAttr(data.saran || 'Coba kata kunci lain')}</span></div>`;
          if (statusEl) statusEl.textContent = `Tidak ada hasil untuk "${q}"${dbgSummary ? ' — ' + dbgSummary : ''}`;
        }
        S.searchResults = []; S.searchPage = 1; renderSearchPagination();
        return;
      }
      if (statusEl && dbgSummary) statusEl.textContent = `${online.length} hasil "${q}" — ${dbgSummary}${data.saran ? ' — ' + data.saran : ''}`;
      S.searchResults = online;
      S.searchPage = 1;
      if (filter === 'all') renderSearchGrouped();
      else renderSearchPage();
      return;
        b.querySelector('[data-dl-online]').onclick = async (e)=>{
          e.stopPropagation();
          const dlBtn = b.querySelector('[data-dl-online]');
          if (!dlBtn || dlBtn.disabled) return;
          const dlIconSvg = ICON.download;
          const setBtn = (txt)=>{
            if (!b.isConnected || !dlBtn) return;
            if (txt === '⬇') { dlBtn.innerHTML = dlIconSvg; dlBtn.style.fontSize = '11px'; dlBtn.style.padding = '3px 6px'; }
            else if (txt === '✓') { dlBtn.innerHTML = ICON.check; dlBtn.style.fontSize = ''; dlBtn.style.padding = '3px 6px'; }
            else { dlBtn.textContent = txt; dlBtn.style.fontSize = '11px'; }
          };
          try{
            dlBtn.textContent = '0%';
            dlBtn.disabled = true;
            const res = await startTrackDownload(t, {
              onTick: (pct)=> setBtn(pct + '%'),
              onFailed: ()=>{ setBtn('⬇'); dlBtn.disabled = false; },
              onDone: ()=>{ setBtn('✓'); dlBtn.disabled = false; },
              onStale: ()=>{ if (b.isConnected && dlBtn && dlBtn.disabled) { setBtn('⬇'); dlBtn.disabled = false; } },
            });
            if (!res) { setBtn('⬇'); dlBtn.disabled = false; }
          }catch(err){ showToast('Download gagal: ' + (err?.message || err), 5000); setBtn('⬇'); if (dlBtn) dlBtn.disabled = false; }
        };
    } catch(e){
      if (myReq !== S.searchReqId) return;
      listEl.querySelector('#searchLoader')?.remove();
      listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">Gagal cari online.<br><span style="font-size:11px">Cek Python engine, lalu ketik ulang</span></div>`;
      if (statusEl) statusEl.textContent = 'Gagal cari online — cek Python engine';
      S.searchResults = []; S.searchPage = 1; renderSearchPagination();
    }
  };
  run();
}
function renderSearchPage(){
  const listEl = document.getElementById('searchTrackList');
  const statusEl = document.getElementById('searchStatus');
  if (!listEl) return;
  const head = document.getElementById('searchTableHead');
  if (head) head.style.display = '';
  const q = (document.getElementById('searchViewInput')?.value || '').trim();
  const total = S.searchResults.length;
  const pages = Math.max(1, Math.ceil(total / SEARCH_PER_PAGE));
  if (S.searchPage < 1) S.searchPage = 1;
  if (S.searchPage > pages) S.searchPage = pages;
  const start = (S.searchPage - 1) * SEARCH_PER_PAGE;
  const slice = S.searchResults.slice(start, start + SEARCH_PER_PAGE);
  if (total) {
    if (statusEl) statusEl.textContent = `Menampilkan ${start + 1}-${Math.min(start + slice.length, total)} dari ${total} untuk "${q}" (20/source)`;
  }
  listEl.innerHTML = '';
  slice.forEach((t,i)=>{
    listEl.appendChild(searchTrackRow(t, start + i));
  });
  applySearchGridWidths();
  renderSearchPagination();
}
function searchTrackRow(t, absIdx){
    const b = document.createElement('div');
    b.className = 'track';
    b.style.cursor = 'default';
    const src = (t.source || 'online').toLowerCase();
        const dlIcon = ico('download', 14);
        b.innerHTML = `<span style="color:#8b93a9">${absIdx+1}</span><span class="t-main">${onlineCoverHtml(t)}<span style="min-width:0"><div class="t-title"><span style="overflow:hidden;text-overflow:ellipsis">${t.title}</span><span class="src-badge src-${src}">${t.source || 'online'}</span></div><div class="t-sub">${t.artist}</div></span></span><span class="c-dur">${t.duration? fmt(t.duration) : '--:--'}</span><span class="c-more" style="display:flex; gap:4px; align-items:center"><button class="btn-add-folder" data-play-online="${absIdx}" title="Putar preview" aria-label="Putar preview" style="font-size:11px !important; padding:3px 6px !important">${ICON.play}</button><button class="btn-add-folder" data-dl-online="${absIdx}" title="Download lagu" aria-label="Download lagu" style="font-size:11px !important; padding:3px 6px !important; display:inline-grid; place-items:center">${dlIcon}</button></span>`;
    b.querySelector('[data-play-online]').onclick = async (e)=>{
      e.stopPropagation();
      const playBtn = b.querySelector('[data-play-online]');
      if (!playBtn || playBtn.disabled) return;
      if (isPreviewPlaying() && _activePvBtn === playBtn) { stopPreview(); _activePvBtn = null; return; }
      const src = (t.source || '').toLowerCase();
      const startPreview = (url)=>{
        if (!url) return;
        pause();
        playPreviewAudio(url, playBtn, (src === 'soundcloud' || src === '4shared') ? 30 : 0);
        _activePvBtn = playBtn;
      };
      if (t.previewUrl) { startPreview(t.previewUrl); return; }
      if (t._previewUrl) { startPreview(t._previewUrl); return; }
      if (!['soundcloud', '4shared', 'spotify'].includes(src)) {
        showToast('Preview tidak tersedia untuk sumber ini', 4000);
        return;
      }
      playBtn.disabled = true;
      playBtn.textContent = '…';
      let started = false;
      try {
        const r = await fetch(`http://127.0.0.1:8001/preview?source=${encodeURIComponent(src)}&trackId=${encodeURIComponent(t.trackId || '')}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}`);
        const j = await r.json();
        if (j && j.ok && j.url) {
          const purl = j.relay ? `http://127.0.0.1:8001/preview/stream?url=${encodeURIComponent(j.url)}` : j.url;
          t._previewUrl = purl;
          startPreview(purl);
          started = true;
        } else if (j && j.error === 'nopreview') {
          showToast(`Preview tidak tersedia untuk "${t.title}"`, 4000);
        } else {
          showToast('Gagal ambil preview: ' + ((j && j.error) || 'unknown'), 4000);
        }
      } catch (err) {
        showToast('Gagal ambil preview (engine offline?)', 4000);
      } finally {
        if (playBtn) { playBtn.disabled = false; if (!started) playBtn.innerHTML = ICON.play; }
      }
    };
    b.querySelector('[data-dl-online]').onclick = async (e)=>{
      e.stopPropagation();
      const dlBtn = b.querySelector('[data-dl-online]');
      if (!dlBtn || dlBtn.disabled) return;
      const dlIconSvg = ICON.downloadLg;
      const setBtn = (txt)=>{ if (!b.isConnected || !dlBtn) return; if (txt === '⬇') { dlBtn.innerHTML = dlIconSvg; dlBtn.style.fontSize = ''; } else if (txt === '✓') { dlBtn.innerHTML = ICON.check; dlBtn.style.fontSize = ''; } else { dlBtn.textContent = txt; dlBtn.style.fontSize = '11px'; } };
      try{
        dlBtn.textContent = '0%';
        dlBtn.disabled = true;
        const res = await startTrackDownload(t, {
          onTick: (pct)=> setBtn(pct + '%'),
          onFailed: ()=>{ setBtn('⬇'); dlBtn.disabled = false; },
          onDone: ()=>{ setBtn('✓'); dlBtn.disabled = false; },
          onStale: ()=>{ if (b.isConnected && dlBtn && dlBtn.disabled) { setBtn('⬇'); dlBtn.disabled = false; } },
        });
        if (!res) { setBtn('⬇'); dlBtn.disabled = false; }
        }catch(err){ showToast('Download gagal: ' + (err?.message || err), 5000); setBtn('⬇'); if (dlBtn) dlBtn.disabled = false; }
      };
    return b;
}
function renderSearchPagination(){
  const el = document.getElementById('searchPagination');
  if (!el) return;
  const total = S.searchResults.length;
  const pages = Math.ceil(total / SEARCH_PER_PAGE);
  if (total <= SEARCH_PER_PAGE) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'flex';
  el.innerHTML = `<button class="btn-add-folder" id="pgPrev" ${S.searchPage===1?'disabled':''}>‹ Prev</button><span style="font-size:11px; color:var(--muted)">Halaman ${S.searchPage} / ${pages} • ${total} lagu</span><button class="btn-add-folder" id="pgNext" ${S.searchPage===pages?'disabled':''}>Next ›</button>`;
  el.querySelector('#pgPrev')?.addEventListener('click', ()=>{ if (S.searchPage>1){ S.searchPage--; renderSearchPage(); document.getElementById('searchTrackList')?.scrollTo(0,0); } });
  el.querySelector('#pgNext')?.addEventListener('click', ()=>{ if (S.searchPage<pages){ S.searchPage++; renderSearchPage(); document.getElementById('searchTrackList')?.scrollTo(0,0); } });
}
function groupSearchResults(){
  const albums = new Map(), artists = new Map();
  for (const t of S.searchResults) {
    const an = String(t.artist || 'Unknown').trim() || 'Unknown';
    const ak = an.toLowerCase();
    if (!artists.has(ak)) artists.set(ak, { name: an, cover: t.coverUrl || '', tracks: [] });
    const ag = artists.get(ak);
    if (!ag.cover && t.coverUrl) ag.cover = t.coverUrl;
    ag.tracks.push(t);
    const al = String(t.album || '').trim();
    if (al) {
      const lk = al.toLowerCase();
      if (!albums.has(lk)) albums.set(lk, { name: al, artists: new Set(), cover: t.coverUrl || '', tracks: [] });
      const g = albums.get(lk);
      if (!g.cover && t.coverUrl) g.cover = t.coverUrl;
      g.artists.add(an);
      g.tracks.push(t);
    }
  }
  return { albums: [...albums.values()], artists: [...artists.values()] };
}
function searchCoverHtml(cover, title){
  if (cover) {
    const initials = escAttr((title || '?').slice(0, 2).toUpperCase());
    return `<img src="${escAttr(cover)}" alt="" loading="lazy" data-initials="${initials}" onerror="__coverFallback(this)" />`;
  }
  const ch = escAttr(((title || '?')[0] || '?').toUpperCase());
  return `<div style="display:grid;place-items:center;color:var(--muted)">${ch}</div>`;
}
function drill(kind, value){
  const fEl = document.getElementById('searchFilter');
  const qEl = document.getElementById('searchViewInput');
  if (fEl) fEl.value = kind;
  if (qEl) qEl.value = value;
  S.searchPage = 1;
  renderSearchView();
}
function openSearchGroupPopup(kind, g){
  const modal = document.getElementById('appModal');
  const tEl = document.getElementById('modalTitle');
  const mEl = document.getElementById('modalMessage');
  const formWrap = document.getElementById('modalFormWrap');
  const btnCancel = document.getElementById('modalCancel');
  const btnConfirm = document.getElementById('modalConfirm');
  const closeBtn = document.getElementById('modalClose');
  const backdrop = document.getElementById('modalBackdrop');
  if (!modal || !formWrap || !g) return;
  const artistTxt = kind === 'album' ? [...(g.artists || [])].slice(0, 3).join(', ') : '';
  tEl.textContent = g.name || (kind === 'album' ? 'Album' : 'Artis');
  mEl.style.display = 'none';
  formWrap.style.display = 'block';
  formWrap.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'search-popup-head';
  head.innerHTML = `<div class="search-popup-cover">${searchCoverHtml(g.cover, g.name)}</div><div class="search-popup-meta"><div class="search-popup-name">${escAttr(g.name)}</div><div class="search-popup-sub">${escAttr(artistTxt ? artistTxt + ' • ' : '')}${g.tracks.length} lagu</div></div>`;
  const list = document.createElement('div');
  list.className = 'search-popup-list';
  g.tracks.forEach((t, i) => list.appendChild(searchTrackRow(t, i)));
  formWrap.appendChild(head);
  formWrap.appendChild(list);
  btnCancel.style.display = 'block';
  btnCancel.textContent = 'Tutup';
  btnConfirm.style.display = 'block';
  btnConfirm.textContent = 'Lihat semua hasil';
  modal.classList.add('open');
  modal.classList.add('modal-wide');
  modal.setAttribute('aria-hidden', 'false');
  const cleanup = () => {
    modal.classList.remove('open');
    modal.classList.remove('modal-wide');
    modal.setAttribute('aria-hidden', 'true');
    btnConfirm.removeEventListener('click', onGo);
    btnCancel.removeEventListener('click', onCancel);
    if (closeBtn) closeBtn.removeEventListener('click', onCancel);
    if (backdrop) backdrop.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKey);
    formWrap.style.display = 'none';
    formWrap.innerHTML = '';
  };
  const onCancel = () => cleanup();
  const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
  const onGo = () => { const nm = g.name; cleanup(); drill(kind, nm); };
  btnConfirm.addEventListener('click', onGo);
  btnCancel.addEventListener('click', onCancel);
  if (closeBtn) closeBtn.addEventListener('click', onCancel);
  if (backdrop) backdrop.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey);
}
function renderSearchGrouped(){
  const listEl = document.getElementById('searchTrackList');
  const statusEl = document.getElementById('searchStatus');
  if (!listEl) return;
  const q = (document.getElementById('searchViewInput')?.value || '').trim();
  const head = document.getElementById('searchTableHead');
  if (head) head.style.display = 'none';
  const pg = document.getElementById('searchPagination');
  if (pg) { pg.style.display = 'none'; pg.innerHTML = ''; }
  const total = S.searchResults.length;
  const { albums, artists } = groupSearchResults();
  if (statusEl) statusEl.textContent = `${total} lagu • ${albums.length} album • ${artists.length} artis untuk "${q}"`;
  listEl.innerHTML = '';
  const sec = (label) => {
    const h = document.createElement('div');
    h.className = 'search-section-title';
    h.textContent = label;
    listEl.appendChild(h);
  };
  sec('Lagu');
  S.searchResults.slice(0, 5).forEach((t, i) => listEl.appendChild(searchTrackRow(t, i)));
  if (albums.length) {
    sec('Album');
    const shownAlbums = albums.slice(0, 8);
    const grid = document.createElement('div');
    grid.className = 'playlist-grid';
    grid.innerHTML = shownAlbums.map((g, gi) => {
      const artistTxt = [...g.artists].slice(0, 3).join(', ');
      return `<div class="pl-card" data-album="${gi}"><div class="pl-cover-stack">${searchCoverHtml(g.cover, g.name)}</div><div class="pl-name">${escAttr(g.name)}</div><div class="pl-meta">${escAttr(artistTxt)} • ${g.tracks.length} lagu</div></div>`;
    }).join('');
    listEl.appendChild(grid);
    grid.querySelectorAll('[data-album]').forEach((c) => {
      c.onclick = () => { const g = shownAlbums[parseInt(c.dataset.album, 10)]; if (g) openSearchGroupPopup('album', g); };
    });
  }
  if (artists.length) {
    sec('Artis');
    const shownArtists = artists.slice(0, 8);
    const grid = document.createElement('div');
    grid.className = 'playlist-grid';
    grid.innerHTML = shownArtists.map((g, gi) => {
      return `<div class="pl-card" data-artist="${gi}"><div class="pl-cover-stack">${searchCoverHtml(g.cover, g.name)}</div><div class="pl-name">${escAttr(g.name)}</div><div class="pl-meta">${g.tracks.length} lagu</div></div>`;
    }).join('');
    listEl.appendChild(grid);
    grid.querySelectorAll('[data-artist]').forEach((c) => {
      c.onclick = () => { const g = shownArtists[parseInt(c.dataset.artist, 10)]; if (g) openSearchGroupPopup('artist', g); };
    });
  }
  applySearchGridWidths();
}
export { SEARCH_PER_PAGE, searchLoaderHtml, renderSearchPage, renderSearchPagination, renderSearchGrouped };
