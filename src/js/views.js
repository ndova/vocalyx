import { S } from './state.js';
import { applySearchGridWidths, applyGridWidths } from './grid.js';
import { t } from './i18n/core.js';
import { ICON } from './icons.js';
import { hashStr, coverHtml, escAttr } from './format.js';
import { karaokeBadgeHtml, karaokeProgressHtml, syncKaraokeBtn } from './engine.js';
import { load, loadSettingsUI } from './player.js';
import { openMediaPlayer } from './media-player.js';
import { showPrompt, showConfirm } from './modal.js';
import { setVizHidden } from './viz.js';
import { renderDownloads } from './downloads.js';
import { cleanupDownloadArtifacts } from './folders.js';
import { requestMusicRescan } from './local.js';
import { renderHelp } from './help.js';
import { albumKeyOf, artistKeyOf, localLibraryTracks, playlistTracks, plPathIndex, renderDeviceView, renderSearchView, savePlaylists, setAlbumPlayback, setArtistPlayback, setPlaylistPlayback, trackIndexByPath } from '../app.js';

function syncTopbarTitle(){
  const el = document.getElementById('topbarViewTitle');
  const countEl = document.getElementById('downloadCount');
  const dot = document.getElementById('deviceConnDot');
  let ttl = '';
  if (S.activeView === 'local') ttl = t('topbar.local');
  else if (S.activeView === 'search') ttl = t('nav.search');
  else if (S.activeView === 'playlists') ttl = t('topbar.playlists');
  else if (S.activeView.startsWith('playlist:')) { const pl = S.playlists.find(p=>p.id===S.activePlaylistId); ttl = (pl && pl.name) || t('topbar.playlist'); }
  else if (S.activeView.startsWith('album:')) ttl = S.activeAlbumKey || t('topbar.album');
  else if (S.activeView.startsWith('artist:')) ttl = S.activeArtistKey || t('topbar.artist');
  else if (S.activeView === 'downloads') ttl = t('topbar.downloads');
  else if (S.activeView === 'device') ttl = t('topbar.device');
  else if (S.activeView === 'settings') ttl = t('topbar.settings');
  else if (S.activeView === 'help') ttl = t('topbar.help');
  if (el) el.textContent = ttl;
  if (countEl && S.activeView !== 'downloads') countEl.textContent = '';
  if (dot) dot.style.display = S.activeView === 'device' ? '' : 'none';
}
export function renderMainView(){
  const vLocal = document.getElementById('viewLocal');
  const vLists = document.getElementById('viewPlaylists');
  const vDetail = document.getElementById('viewPlaylistDetail');
  const vSearch = document.getElementById('viewSearch');
  const vDownloads = document.getElementById('viewDownloads');
  const vDevice = document.getElementById('viewDevice');
  const vSettings = document.getElementById('viewSettings');
  const vAlbumDetail = document.getElementById('viewAlbumDetail');
  const vArtistDetail = document.getElementById('viewArtistDetail');
  const vHelp = document.getElementById('viewHelp');
  [vLocal, vLists, vDetail, vSearch, vDownloads, vDevice, vSettings, vAlbumDetail, vArtistDetail, vHelp].forEach(v=>{ if(v) v.style.display='none'; });
  if (S.activeView === 'local') {
    if(vLocal) vLocal.style.display = 'flex';
    requestMusicRescan(500);
  }
  else if (S.activeView === 'playlists') { if(vLists) vLists.style.display = 'flex'; renderPlaylistsOverview(); }
  else if (S.activeView.startsWith('playlist:')) { if(vDetail) vDetail.style.display = 'flex'; renderPlaylistDetail(S.activePlaylistId); }
  else if (S.activeView.startsWith('album:')) { if(vAlbumDetail) vAlbumDetail.style.display = 'flex'; renderAlbumDetail(S.activeAlbumKey); }
  else if (S.activeView.startsWith('artist:')) { if(vArtistDetail) vArtistDetail.style.display = 'flex'; renderArtistDetail(S.activeArtistKey); }
  else if (S.activeView === 'search') { if(vSearch) vSearch.style.display = 'flex'; renderSearchView(); applySearchGridWidths(); try { setVizHidden(true, { auto: true }); } catch {} }
  else if (S.activeView === 'downloads') { if(vDownloads) vDownloads.style.display = 'flex'; renderDownloads(); try { cleanupDownloadArtifacts({ force:true }); } catch {} }
  else if (S.activeView === 'device') { if(vDevice) vDevice.style.display = 'flex'; renderDeviceView(); }
  else if (S.activeView === 'settings') { if(vSettings) vSettings.style.display = 'flex'; loadSettingsUI(); }
  else if (S.activeView === 'help') { if(vHelp) vHelp.style.display = 'flex'; renderHelp(); }
  else { if(vLocal) vLocal.style.display = 'flex'; }
  try { if (S.activeView !== 'search' && typeof S.vizAutoHidden !== 'undefined' && S.vizAutoHidden) setVizHidden(false); } catch {}
  try { syncKaraokeBtn(); } catch {}
  try { syncTopbarTitle(); } catch {}
}
const _coverQuadCache = new Map();
export function pickCoverQuad(cacheKey, tracks) {
  const uniq = [];
  const seen = new Set();
  for (const t of (tracks || [])) {
    const c = t && t.cover;
    if (!c || seen.has(c)) continue;
    seen.add(c);
    uniq.push(c);
  }
  if (uniq.length < 4) { _coverQuadCache.delete(cacheKey); return []; }
  const cached = _coverQuadCache.get(cacheKey);
  if (cached && cached.length === 4 && cached.every(c => seen.has(c))) return cached;
  const pool = uniq.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  const pick = pool.slice(0, 4);
  _coverQuadCache.set(cacheKey, pick);
  return pick;
}
export function renderPlaylistsOverview(){
  const grid = document.getElementById('playlistGrid');
  if (!grid) return;
  if (S.playlists.length===0) {
    grid.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted); grid-column:1/-1">${t('pl.emptyTitle')}<br><span style="font-size:11px">${t('pl.emptyHint')}</span></div>`;
    return;
  }
  grid.innerHTML = S.playlists.map(p=>{
    const tracksIn = playlistTracks(p);
    const first = tracksIn[0];
    const quad = pickCoverQuad(p.id, tracksIn);
    const coverStack = quad.length === 4
      ? `<div class="pl-cover-quad">${quad.map(c => `<img src="${c}" alt="" loading="lazy">`).join('')}</div>`
      : (first
        ? (first.cover
          ? `<img src="${first.cover}" alt="">`
          : `<div style="background:hsl(${Math.abs(hashStr(first.artist+first.title))%360} 55% 22%); color:hsl(${Math.abs(hashStr(first.artist+first.title))%360} 70% 85%)">${(first.title[0]||'?').toUpperCase()}</div>`)
        : `<div style="display:grid;place-items:center;color:var(--muted)">${ICON.music}</div>`);
    const songCount = tracksIn.length;
    return `<div class="pl-card" data-id="${p.id}"><div class="pl-cover-stack">${coverStack}<button class="cover-play" data-play-pl="${p.id}" aria-label="${t('pl.playPlaylist')}">${ICON.play}</button><div class="pl-cover-tools"><button class="cover-tool" data-rename="${p.id}" title="${t('pl.renameTitle')}">${ICON.pencil}</button><button class="cover-tool" data-del="${p.id}" title="${t('pl.delPlaylist')}">${ICON.trash}</button></div></div><div class="pl-name">${escAttr(p.name)}</div><div class="pl-meta">${t('std.songs', { n: songCount })}</div></div>`;
  }).join('');
  grid.querySelectorAll('[data-play-pl]').forEach(b=>{
    b.onclick=(e)=>{ e.stopPropagation(); const pl=S.playlists.find(p=>p.id===b.dataset.playPl); const first = pl && playlistTracks(pl)[0]; if(!first) return; setPlaylistPlayback(pl.id); load(trackIndexByPath(first.path),true); };
  });
  grid.querySelectorAll('[data-rename]').forEach(b=>{
    b.onclick=(e)=>{ e.stopPropagation(); const pl=S.playlists.find(p=>p.id===b.dataset.rename); (async()=>{ const nn=await showPrompt(t('pl.renameTitle'), t('pl.renamePrompt'), pl.name); if(nn&&nn.trim()){ pl.name=nn.trim(); savePlaylists(); renderPlaylistsOverview(); } })(); };
  });
  grid.querySelectorAll('[data-del]').forEach(b=>{
    b.onclick=(e)=>{ e.stopPropagation(); (async()=>{ const ok=await showConfirm(t('pl.delTitle'), t('pl.delConfirm', { n: S.playlists.find((p) => p.id === b.dataset.del)?.name })); if(!ok) return; const delId=b.dataset.del; S.playlists=S.playlists.filter(p=>p.id!==delId); if(S.playlistPlayback?.id===delId) S.playlistPlayback=null; savePlaylists(); renderPlaylistsOverview(); })(); };
  });
  grid.querySelectorAll('.pl-card').forEach(c=>{
    c.onclick=(e)=>{ if(e.target.closest('button')) return; S.activeView='playlist:'+c.dataset.id; S.activePlaylistId=c.dataset.id; document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active')); document.querySelector('[data-nav="playlists"]').classList.add('active'); renderMainView(); };
  });
}
export function renderPlaylistDetail(pid){
  const pl = S.playlists.find(p=>p.id===pid);
  const titleEl = document.getElementById('detailPlaylistName');
  const listEl = document.getElementById('detailTrackList');
  if (!pl || !titleEl || !listEl) return;
  titleEl.textContent = pl.name;
  const filtered = playlistTracks(pl);
  if (filtered.length===0) {
    listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">${t('pl.emptyDetail')}<br><span style="font-size:11px">${t('pl.emptyDetailHint')}</span></div>`;
    return;
  }
  listEl.innerHTML = '';
  filtered.forEach((t, i)=>{
    const origIdx = trackIndexByPath(t.path);
    const b = document.createElement('button');
    b.className = 'track' + (origIdx===S.idx ? ' active' : '');
    if (t.path) b.dataset.tpath = t.path;
    b.innerHTML = `<span style="color:#8b93a9">${i+1}</span><span class="t-main">${coverHtml(t)}<span><div class="t-title">${t.title}${karaokeBadgeHtml(t)}</div><div class="t-sub">${t.artist}</div>${karaokeProgressHtml(t)}</span></span><span class="c-type">${(t.ext||'').toUpperCase()}</span><span class="c-size">${t.size_str||'--'}</span><span class="c-dur">${t.dur||'--:--'}</span><span class="c-more" style="position:relative"><button class="btn-more" data-rm="${t.path}">${ICON.x}</button></span>`;
    b.onclick = async (e)=>{ if(e.target.closest('[data-rm]')) return; openMediaPlayer(t, { rowEl: b }); };
    b.querySelector('[data-rm]').onclick=(e)=>{ e.stopPropagation(); const rmIdx = plPathIndex(pl, t.path); if (rmIdx >= 0) pl.trackPaths.splice(rmIdx, 1); savePlaylists(); renderPlaylistDetail(pid); renderPlaylistsOverview(); };
    listEl.appendChild(b);
  });
  applyGridWidths();
  try { syncTopbarTitle(); } catch {}
}
export function groupArtists(){
  const map = new Map();
  for (const t of localLibraryTracks()) {
    const name = artistKeyOf(t);
    const k = name.toLowerCase();
    if (!map.has(k)) map.set(k, { name, tracks: [] });
    map.get(k).tracks.push(t);
  }
  return [...map.values()].sort((a, b)=> a.name.localeCompare(b.name, 'id'));
}
export function groupAlbums(){
  const map = new Map();
  for (const t of localLibraryTracks()) {
    const name = albumKeyOf(t);
    const k = name.toLowerCase();
    if (!map.has(k)) map.set(k, { name, artists: new Set(), tracks: [] });
    const g = map.get(k);
    g.artists.add(artistKeyOf(t));
    g.tracks.push(t);
  }
  return [...map.values()].sort((a, b)=> a.name.localeCompare(b.name, 'id'));
}
function collectionCoverStack(list){
  const first = list.find(t=> t.cover) || list[0];
  if (!first) return `<div style="display:grid;place-items:center;color:var(--muted)">${ICON.music}</div>`;
  if (first.cover) return `<img src="${first.cover}" alt="">`;
  const hue = Math.abs(hashStr((first.artist||'')+(first.title||'')))%360;
  return `<div style="background:hsl(${hue} 55% 22%); color:hsl(${hue} 70% 85%)">${((first.title||'?')[0]||'?').toUpperCase()}</div>`;
}
export function playCollection(kind, key, paths){
  if (!paths.length) return;
  if (kind === 'album') setAlbumPlayback(key, paths);
  else setArtistPlayback(key, paths);
  const firstIdx = S.tracks.findIndex(t=> t.path===paths[0]);
  if (firstIdx>=0) load(firstIdx, true);
}
export function renderAlbumDetail(key){
  const g = groupAlbums().find(x=> x.name===key);
  const titleEl = document.getElementById('detailAlbumName');
  const listEl = document.getElementById('detailAlbumList');
  if (!titleEl || !listEl) return;
  titleEl.textContent = key || 'Unknown Album';
  if (!g || !g.tracks.length) {
    listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">${t('pl.emptyAlbum')}<br><span style="font-size:11px">${t('pl.emptyAlbumHint')}</span></div>`;
    return;
  }
  listEl.innerHTML = '';
  g.tracks.forEach((t, i)=>{
    const origIdx = S.tracks.findIndex(x=> x.path===t.path);
    const b = document.createElement('button');
    b.className = 'track' + (origIdx===S.idx ? ' active' : '');
    if (t.path) b.dataset.tpath = t.path;
    b.innerHTML = `<span style="color:#8b93a9">${i+1}</span><span class="t-main">${coverHtml(t)}<span><div class="t-title">${t.title}${karaokeBadgeHtml(t)}</div><div class="t-sub">${t.artist}</div>${karaokeProgressHtml(t)}</span></span><span class="c-type">${(t.ext||'').toUpperCase()}</span><span class="c-size">${t.size_str||'--'}</span><span class="c-dur">${t.dur||'--:--'}</span>`;
    b.onclick = async ()=>{ openMediaPlayer(t, { rowEl: b }); };
    listEl.appendChild(b);
  });
  applyGridWidths();
  try { syncTopbarTitle(); } catch {}
}
export function renderArtistDetail(key){
  const g = groupArtists().find(x=> x.name===key);
  const titleEl = document.getElementById('detailArtistName');
  const listEl = document.getElementById('detailArtistList');
  if (!titleEl || !listEl) return;
  titleEl.textContent = key || 'Unknown';
  if (!g || !g.tracks.length) {
    listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--muted)">${t('pl.emptyArtist')}<br><span style="font-size:11px">${t('pl.emptyAlbumHint')}</span></div>`;
    return;
  }
  listEl.innerHTML = '';
  g.tracks.forEach((t, i)=>{
    const origIdx = S.tracks.findIndex(x=> x.path===t.path);
    const b = document.createElement('button');
    b.className = 'track' + (origIdx===S.idx ? ' active' : '');
    if (t.path) b.dataset.tpath = t.path;
    b.innerHTML = `<span style="color:#8b93a9">${i+1}</span><span class="t-main">${coverHtml(t)}<span><div class="t-title">${t.title}${karaokeBadgeHtml(t)}</div><div class="t-sub">${albumKeyOf(t)}</div>${karaokeProgressHtml(t)}</span></span><span class="c-type">${(t.ext||'').toUpperCase()}</span><span class="c-size">${t.size_str||'--'}</span><span class="c-dur">${t.dur||'--:--'}</span>`;
    b.onclick = async ()=>{ openMediaPlayer(t, { rowEl: b }); };
    listEl.appendChild(b);
  });
  applyGridWidths();
  try { syncTopbarTitle(); } catch {}
}
export { syncTopbarTitle, collectionCoverStack };
