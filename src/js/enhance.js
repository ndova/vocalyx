import { S } from './state.js';
import { t } from './i18n/core.js';
import { $ } from './dom.js';
import { ICON } from './icons.js';
import { showAlert, showModal, showPrompt } from './modal.js';
import { uid } from './library.js';
import { showToast, activeDownloadIds, getDownloadFolderEffective, getMusicFolders, groupAlbums, groupArtists, invokeTauri, isTauri, load, onDownloadFolderChanged, playCollection, playlistTracks, renderDownloads, renderMainView, renderPlaylistsOverview, renderTracks, requestDlRender, saveDownloadFolder, savePlaylists, setPlaylistPlayback, trackIndexByPath } from '../app.js';

const ENH_MARK_KEY = 'vocalyx_enhanced_v1';
const ENH_SWEEP_PROMPT_KEY = 'vocalyx_enhanceSweepPrompt_v1';
function enhPromptBlocked(){ try { return localStorage.getItem(ENH_SWEEP_PROMPT_KEY) === 'off'; } catch { return false; } }
export function setEnhPromptBlocked(v){ try { if (v) localStorage.setItem(ENH_SWEEP_PROMPT_KEY, 'off'); else localStorage.removeItem(ENH_SWEEP_PROMPT_KEY); } catch {} }
function getEnhMarkers(){ try { return JSON.parse(localStorage.getItem(ENH_MARK_KEY)||'{}'); } catch { return {}; } }
function saveEnhMarkers(m){ try { localStorage.setItem(ENH_MARK_KEY, JSON.stringify(m)); } catch {} }
function enhSettingsHash(){ return [!!S.downloadOptions.audioEnhance, !!S.downloadOptions.normalizeVolume, parseFloat(S.downloadOptions.targetLufs)||-14].join('|'); }
function enhanceParams(){
  let useEnh = !!S.downloadOptions.audioEnhance;
  const useNorm = !!S.downloadOptions.normalizeVolume;
  const target = parseFloat(S.downloadOptions.targetLufs) || -14;
  if (!useEnh && !useNorm) useEnh = true;
  return { useEnh, useNorm, target };
}
function isLocalPath(p){ return !!p && (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')); }
async function statLocal(p){
  try {
    const { stat } = await import('@tauri-apps/plugin-fs');
    const s = await stat(p);
    if (!s) return null;
    let mtimeMs = 0;
    try {
      if (s.mtime instanceof Date) mtimeMs = s.mtime.getTime() || 0;
      else if (typeof s.mtime === 'number') mtimeMs = s.mtime;
    } catch {}
    return { size: (typeof s.size === 'number') ? s.size : -1, mtimeMs };
  } catch { return null; }
}
async function isEnhMarked(p){
  if (!isLocalPath(p)) return true;
  const { useEnh, useNorm, target } = enhanceParams();
  const m = getEnhMarkers()[p];
  if (!m) return false;
  const hash = [!!useEnh, !!useNorm, target].join('|');
  if (m.settingsHash !== hash) return false;
  const st = await statLocal(p);
  if (!st) return m.size === -1;
  return m.size === st.size && (m.mtimeMs||0) === (st.mtimeMs||0);
}
async function markEnhanced(p){
  const { useEnh, useNorm, target } = enhanceParams();
  const st = await statLocal(p);
  const m = getEnhMarkers();
  const hash = [!!useEnh, !!useNorm, target].join('|');
  m[p] = { size: st?st.size:-1, mtimeMs: st?st.mtimeMs:0, settingsHash: hash, at: Date.now() };
  saveEnhMarkers(m);
}
function migrateEnhMarker(oldP, newP){
  if (!oldP || !newP || oldP === newP) return;
  const m = getEnhMarkers();
  if (m[oldP]) { m[newP] = m[oldP]; delete m[oldP]; saveEnhMarkers(m); }
}
function pruneEnhMarker(p){ const m = getEnhMarkers(); if (m[p]) { delete m[p]; saveEnhMarkers(m); } }
async function collectEnhCandidates(){
  const set = new Map();
  for (const t of S.tracks) if (t && isLocalPath(t.path)) set.set(t.path, t.title || t.name || t.path);
  for (const d of S.downloads) if (d && d.status === 'done' && isLocalPath(d.path)) set.set(d.path, d.title || d.path);
  if (isTauri()) {
    try {
      const folder = await getDownloadFolderEffective();
      if (folder) {
        const files = await invokeTauri('scan_music', { dir: folder });
        for (const f of (files || [])) if (f && f.path) { if (!set.has(f.path)) set.set(f.path, f.title || f.path); }
      }
    } catch {}
  }
  return [...set.entries()].map(([path, label]) => ({ path, label }));
}
async function pollEnhance(eid, timeoutMs=420000){
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (activeDownloadIds.size > 0) return { status:'cancelled', error:'download aktif' };
    await new Promise(r=>setTimeout(r, 1500));
    try {
      const r = await fetch(`http://127.0.0.1:8001/embed/enhance/progress?enhanceId=${encodeURIComponent(eid)}`);
      const j = await r.json();
      if (j && (j.status === 'done' || j.status === 'failed')) return j;
    } catch {}
  }
  return { status:'failed', error:'timeout menunggu enhance' };
}
const ENH_OK_EXTS = ['mp3','m4a','flac','ogg','opus'];
function paintEnhanceItem(btn, path, ext, ready=true) {
  if (!btn) return;
  if (!S.downloadOptions.audioEnhance && !S.downloadOptions.normalizeVolume) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  const set = (html, dis) => { btn.innerHTML = html; btn.disabled = !!dis; };
  if (!path || !ready) { set('Belum selesai', true); return; }
  if (!ENH_OK_EXTS.includes(String(ext||'').toLowerCase())) { set('Format tak didukung', true); return; }
  set(`${ICON.sparkles} Enhance file`, false);
  isEnhMarked(path).then(marked => {
    if (!btn.isConnected) return;
    if (marked) set(`${ICON.check} Sudah di-enhance`, true);
    else set(`${ICON.sparkles} Enhance file`, false);
  }).catch(()=>{});
}
async function enhanceOneFile(path, label){
  const { useEnh, useNorm, target } = enhanceParams();
  showToast(`Enhancing: ${label || path}…`, 3000);
  try {
    const r = await fetch('http://127.0.0.1:8001/embed/enhance', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ path, audioEnhance: useEnh, normalizeVolume: useNorm, targetLufs: target }) });
    const j = await r.json();
    if (!j || !j.ok || !j.enhanceId) throw new Error((j && j.error) || ('HTTP ' + r.status));
    const fin = await pollEnhance(j.enhanceId);
    if (fin && fin.status === 'done' && fin.enhanced) {
      await markEnhanced(path);
      try { renderDownloads(); renderTracks($('#globalSearch')?.value || ''); } catch {}
      showToast(`Enhanced${useEnh && !S.downloadOptions.audioEnhance ? ' (declip)' : ''}: ${label || path}`, 4000);
    } else throw new Error((fin && fin.error) || 'gagal');
  } catch (err) {
    await showAlert('Enhance', 'Gagal: ' + (err?.message || err));
  }
}
export async function sweepEnhance(opts={}){
  const silent = !!opts.silent;
  const noPrompt = !!opts.noPrompt;
  if (!isTauri()) return;
  if (S._sweepRunning) { if (!silent && !noPrompt) showToast(t('enh.batchRunning'), 2500); return; }
  if (!(S.downloadOptions.audioEnhance || S.downloadOptions.normalizeVolume)) return;
  if (activeDownloadIds.size > 0) {
    if (!silent && !noPrompt) showToast('Tunggu download selesai dulu', 2500);
    return;
  }
  const cands = await collectEnhCandidates();
  const todo = [];
  for (const c of cands) {
    if (activeDownloadIds.size > 0) return;
    try { if (!(await isEnhMarked(c.path))) todo.push(c); } catch { todo.push(c); }
  }
  if (!todo.length) { if (!opts.quiet && !silent && !noPrompt) showToast(t('enh.allMatch'), 2500); return; }
  if (!silent && !noPrompt && todo.length > 5 && opts.auto !== false && !enhPromptBlocked()) {
    const ok = await showModal({ title: t('enh.enhanceOld'), message: t('enh.notDone', { n: todo.length }), confirmText:'Proses', cancelText:'Batal' });
    if (!ok) { setEnhPromptBlocked(true); return; }
    setEnhPromptBlocked(false);
  }
  S._sweepRunning = true;
  let done = 0, failed = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      if (activeDownloadIds.size > 0) { if (!silent && !noPrompt) showToast('Download aktif — sweep dihentikan', 3000); break; }
      const c = todo[i];
      if (!silent && !noPrompt) showToast(`Enhancing ${i+1}/${todo.length}: ${c.label}`, 3000);
      const { useEnh: sEnh, useNorm: sNorm, target: sTarget } = enhanceParams();
      try {
        const r = await fetch('http://127.0.0.1:8001/embed/enhance', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ path: c.path, audioEnhance: sEnh, normalizeVolume: sNorm, targetLufs: sTarget }) });
        const j = await r.json();
        if (!j || !j.ok || !j.enhanceId) throw new Error((j && j.error) || 'HTTP '+r.status);
        const fin = await pollEnhance(j.enhanceId);
        if (fin && fin.status === 'cancelled') { if (!silent && !noPrompt) showToast('Download aktif — sweep dihentikan', 3000); break; }
        if (fin && fin.status === 'done' && fin.enhanced) { await markEnhanced(c.path); done++; }
        else { failed++; }
      } catch (err) {
        failed++;
        if (String(err?.message||err).includes('Failed to fetch')) { if (!silent && !noPrompt) showToast('Engine offline — sweep dihentikan', 4000); break; }
      }
    }
  } finally { S._sweepRunning = false; }
  try { renderDownloads(); renderTracks($('#globalSearch')?.value || ''); } catch {}
  if (noPrompt) { if (done > 0) showToast(t('enh.autoDone', { n: done }), 4000); }
  else if (!silent) showToast(t('enh.doneSummary', { done, failed }), 5000);
}
document.getElementById('btnBrowseFolder')?.addEventListener('click', async ()=>{
  try{
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({directory:true});
    if (p) {
      saveDownloadFolder(p);
      const el = document.getElementById('dlFolder'); if (el) el.value = p;
      await onDownloadFolderChanged();
      if (isTauri() && getMusicFolders().some(d => _inFolder(d, p))) {
        showToast(t('enh.dlFolderNote'), 4500);
      }
      requestDlRender();
    }
  }catch{}
});
document.getElementById('btnSaveSettings')?.addEventListener('click', async ()=>{
  const idEl=document.getElementById('spClientId'), secEl=document.getElementById('spClientSecret');
  const userEl=document.getElementById('spUser'), passEl=document.getElementById('spPass');
  if(idEl) localStorage.setItem('spotify_client_id', idEl.value.trim());
  if(secEl) localStorage.setItem('spotify_client_secret', secEl.value.trim());
  if(userEl) localStorage.setItem('spotify_premium_user', userEl.value.trim());
  if(passEl) localStorage.setItem('spotify_premium_pass', passEl.value.trim());
  await showAlert(t('topbar.settings'), t('enh.settingsSaved2', { n: S.downloadOptions.format.toUpperCase() }));
});
document.getElementById('btnSaveCreds')?.addEventListener('click', async ()=>{
  const idEl=document.getElementById('spClientId'), secEl=document.getElementById('spClientSecret');
  if(idEl) localStorage.setItem('spotify_client_id', idEl.value.trim());
  if(secEl) localStorage.setItem('spotify_client_secret', secEl.value.trim());
  await showAlert('Spotify', t('enh.clientSaved'));
});
document.getElementById('btnTestCreds')?.addEventListener('click', async ()=>{
  const status=document.getElementById('credsStatus'); if(status) status.textContent=t('enh.testing');
  try{
    const id=localStorage.getItem('spotify_client_id')||'', sec=localStorage.getItem('spotify_client_secret')||'';
    const r=await fetch('http://127.0.0.1:8001/spotify/validate', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({clientId:id, clientSecret:sec})});
    const j=await r.json();
    if(status) { status.textContent = j.valid ? t('enh.valid') : t('enh.invalid'); status.style.color = j.valid ? 'var(--accent2)' : '#ff6b6b'; }
  }catch{ if(status) status.textContent=t('enh.error'); }
});
document.getElementById('btnSaveArl')?.addEventListener('click', async ()=>{
  const v=document.getElementById('dzArl')?.value.trim()||'';
  localStorage.setItem('deezer_arl', v);
  await showAlert('Deezer', v ? t('enh.arlSaved') : t('enh.arlCleared'));
  const st=document.getElementById('arlStatus'); if(st) st.textContent = v ? 'tersimpan' : '';
});
document.getElementById('btnTestArl')?.addEventListener('click', async ()=>{
  const st=document.getElementById('arlStatus'); if(st) st.textContent=t('enh.testing');
  try{
    const arl=localStorage.getItem('deezer_arl')||'';
    const r=await fetch('http://127.0.0.1:8001/deezer/arl', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'test', arl})});
    const j=await r.json();
    if(st){ st.textContent = j.data ? `✓ ${j.data.tier} ${j.data.maxQuality}` : t('enh.failed'); st.style.color = j.data ? 'var(--accent2)' : '#ff6b6b'; }
  }catch{ if(st) st.textContent=t('enh.error'); }
});
document.getElementById('btnSavePremium')?.addEventListener('click', async ()=>{
  const u=document.getElementById('spUser')?.value.trim()||'', p=document.getElementById('spPass')?.value.trim()||'';
  localStorage.setItem('spotify_premium_user', u); localStorage.setItem('spotify_premium_pass', p);
  await showAlert('Premium', t('enh.premiumSaved'));
});
document.getElementById('btnTestPremium')?.addEventListener('click', async ()=>{
  const status=document.getElementById('premiumStatus'); if(status) status.textContent=t('enh.testing');
  try{
    const u=localStorage.getItem('spotify_premium_user')||'', p=localStorage.getItem('spotify_premium_pass')||'';
    const r=await fetch('http://127.0.0.1:8001/spotify/premium', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'test', username:u, password:p})});
    const j=await r.json();
    if(status) { status.textContent = j.ok ? t('enh.connected') : t('enh.failed'); status.style.color=j.ok?'var(--accent2)':'#ff6b6b'; }
  }catch{ if(status) status.textContent=t('enh.error'); }
});
document.getElementById('btnConnectPremium')?.addEventListener('click', async ()=>{
  const status=document.getElementById('premiumStatus'); if(status) status.textContent=t('enh.connecting');
  try{
    const r=await fetch('http://127.0.0.1:8001/spotify/premium', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'connect-start'})});
    const j=await r.json();
    const sid=j.sessionId;
    const poll = async()=>{
      const pr=await fetch('http://127.0.0.1:8001/spotify/premium', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'connect-status', sessionId:sid})});
      const pj=await pr.json();
      if(pj.connected){ if(status){ status.textContent=t('enh.connected') + ' ' + (pj.deviceName||'VocaLyx-XXXX'); status.style.color='var(--accent2)'; } }
      else if(pj.waiting){ setTimeout(poll,2000); if(status) status.textContent=t('enh.waiting'); }
      else { if(status) status.textContent=t('enh.failed'); }
    };
    setTimeout(poll,2000);
  }catch{ if(status) status.textContent=t('enh.error'); }
});
document.getElementById('btnDisconnectPremium')?.addEventListener('click', async ()=>{
  await fetch('http://127.0.0.1:8001/spotify/premium', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'disconnect'})});
  const status=document.getElementById('premiumStatus'); if(status) status.textContent=t('enh.disconnected');
});
document.getElementById('btnNewPlaylist')?.addEventListener('click', async ()=>{
  const name = await showPrompt(t('modal.createPlaylist'), t('modal.enterPlaylistName'), '');
  if (!name || !name.trim()) return;
  S.playlists.push({ id: uid(), name: name.trim(), trackPaths: [], createdAt: Date.now() });
  savePlaylists();
  renderPlaylistsOverview();
});
document.getElementById('btnBackPlaylists')?.addEventListener('click', ()=>{
  S.activeView='playlists'; S.activePlaylistId=null;
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  const plBtn = document.querySelector('[data-nav="playlists"]');
  if (plBtn) plBtn.classList.add('active');
  renderMainView();
});
document.getElementById('btnPlayAll')?.addEventListener('click', ()=>{
  const pl = S.playlists.find(p=>p.id===S.activePlaylistId);
  const first = pl && playlistTracks(pl)[0];
  if (!first) return;
  setPlaylistPlayback(pl.id);
  load(trackIndexByPath(first.path),true);
});
document.getElementById('btnBackAlbums')?.addEventListener('click', ()=>{
  S.activeView='local'; S.activeAlbumKey=null;
  const f = document.getElementById('localSearchFilter'); if (f) f.value = 'album';
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelector('[data-nav="local"]')?.classList.add('active');
  renderMainView(); renderTracks('');
});
document.getElementById('btnPlayAllAlbum')?.addEventListener('click', ()=>{
  const g = groupAlbums().find(x=> x.name===S.activeAlbumKey);
  if (!g || !g.tracks.length) return;
  playCollection('album', g.name, g.tracks.map(t=>t.path));
});
document.getElementById('btnBackArtists')?.addEventListener('click', ()=>{
  S.activeView='local'; S.activeArtistKey=null;
  const f = document.getElementById('localSearchFilter'); if (f) f.value = 'artist';
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.querySelector('[data-nav="local"]')?.classList.add('active');
  renderMainView(); renderTracks('');
});
document.getElementById('btnPlayAllArtist')?.addEventListener('click', ()=>{
  const g = groupArtists().find(x=> x.name===S.activeArtistKey);
  if (!g || !g.tracks.length) return;
  playCollection('artist', g.name, g.tracks.map(t=>t.path));
});

export { ENH_MARK_KEY, ENH_SWEEP_PROMPT_KEY, enhPromptBlocked, getEnhMarkers, saveEnhMarkers, enhSettingsHash, enhanceParams, isLocalPath, statLocal, isEnhMarked, markEnhanced, migrateEnhMarker, pruneEnhMarker, collectEnhCandidates, pollEnhance, ENH_OK_EXTS, paintEnhanceItem, enhanceOneFile };
