import { S } from './state.js';
import { $ } from './dom.js';
import { ico } from './icons-tabler.js';
import { applyLang, lang, translateTree, t } from './i18n/core.js';
import { renderTracks, renderDownloads } from '../app.js';
import { showModal, showAlert } from './modal.js';
import { _rgGainCache, rgTargetDb, ensureVolumeGain, applyEnhanceState, saveDownloadOptions, renderMainView, renderSearchView, tauriWin, refreshCudaStatus } from '../app.js';

$('#btnMin').onclick = () => tauriWin((w) => w.minimize());
async function syncMaxBtn(){
  const btn = document.getElementById('btnMax');
  if (!btn) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const max = await getCurrentWindow().isMaximized();
    btn.textContent = max ? '❐' : '▢';
    btn.title = max ? t('win.restore') : t('win.maximize');
  } catch {}
}
$('#btnMax').onclick = async () => {
  await tauriWin(async (w) => {
    const max = await w.isMaximized();
    if (max) await w.unmaximize();
    else await w.maximize();
  });
  syncMaxBtn();
};
syncMaxBtn();
try {
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen('tauri://resize', () => syncMaxBtn()).catch(()=>{});
  }).catch(()=>{});
} catch {}
$('#btnClose').onclick = () => tauriWin((w) => w.close());

function attachDrag(el) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a, label, [data-no-drag]')) return;
    tauriWin((w) => w.startDragging());
  });
}
attachDrag(document.querySelector('.topbar'));
attachDrag(document.querySelector('.playlist-head'));

document.getElementById('btnWaveSettings')?.addEventListener('click', ()=>{
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  S.activeView='settings'; renderMainView();
});

document.getElementById('btnHelp')?.addEventListener('click', ()=>{
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  S.activeView='help'; renderMainView();
});

function syncLangCode(langCode) {
  const sel = document.getElementById('setLang');
  if (sel && sel.value !== langCode) sel.value = langCode;
  const code = document.getElementById('setLangCode');
  if (code) {
    const opt = sel?.querySelector(`option[value="${langCode}"]`);
    code.textContent = (opt?.dataset.code || langCode).toUpperCase();
  }
}
window.__syncLangCode = syncLangCode;

function setAppLang(langCode) {
  applyLang(langCode);
  translateTree(document);
  syncLangCode(langCode);
  try { renderMainView(); } catch {}
  try { renderTracks($('#globalSearch')?.value || ''); } catch {}
  try { renderDownloads(); } catch {}
}
document.getElementById('setLang')?.addEventListener('change', (e)=>{
  setAppLang(e.target.value);
});
syncLangCode(lang());

document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const nav = btn.dataset.nav;
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    if (nav==='local') { S.activeView='local'; renderMainView(); }
    else if (nav==='playlists') { S.activeView='playlists'; renderMainView(); }
    else if (nav==='search') { S.activeView='search'; renderMainView(); }
    else if (nav==='downloads') { S.activeView='downloads'; renderMainView(); }
    else if (nav==='device') { S.activeView='device'; renderMainView(); }
    else if (nav==='music') { S.activeView='search'; renderMainView(); }
  });
});
const ICON_MOON = ico('moon');
const ICON_SUN = ico('sun');
const ICON_HALF = ico('circle-half');
const THEME_KEY = 'vocalyx_theme_v1';
function themePreference() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {}
  return 'system';
}
function mediaTheme() {
  try {
    return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  } catch {}
  return 'light';
}
async function tauriTheme() {
  try {
    if (!window.__TAURI_INTERNALS__) return null;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const th = await getCurrentWindow().theme();
    return (th === 'dark' || th === 'light') ? th : null;
  } catch {}
  return null;
}
function getTheme() {
  const p = themePreference();
  return (p === 'dark' || p === 'light') ? p : mediaTheme();
}
async function resolvedTheme() {
  const p = themePreference();
  if (p === 'dark' || p === 'light') return p;
  return (await tauriTheme()) || mediaTheme();
}
function paintThemeButton(pref, shown) {
  const b = document.getElementById('btnTheme');
  if (!b) return;
  if (pref === 'system') {
    b.innerHTML = ICON_HALF;
    b.title = t('th.themeFollowsWin', { state: t(shown === 'dark' ? 'th.stateDark' : 'th.stateLight') });
    return;
  }
  b.innerHTML = pref === 'dark' ? ICON_SUN : ICON_MOON;
  b.title = pref === 'dark' ? t('th.lightMode') : t('th.darkMode');
}
function applyTheme(mode) {
  const dark = mode === 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  paintThemeButton(themePreference(), mode);
  document.querySelectorAll('.brand-logo').forEach((el) => { el.src = dark ? './logo-dark.png' : './logo.png'; });
}
function themeCycle() {
  const p = themePreference();
  if (p === 'system') return 'dark';
  if (p === 'dark') return 'light';
  return 'system';
}
async function applyResolved() {
  applyTheme(await resolvedTheme());
}
function setThemePreference(pref) {
  const p = (pref === 'light' || pref === 'dark' || pref === 'system') ? pref : 'system';
  try { localStorage.setItem(THEME_KEY, p); } catch {}
  if (p === 'system') applyResolved();
  else applyTheme(p);
}
function watchSystemTheme() {
  if (window.__TAURI_INTERNALS__) {
    try {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
        getCurrentWindow().onThemeChanged(() => { if (themePreference() === 'system') applyResolved(); })
      ).catch(() => {});
    } catch {}
  }
  if (window.matchMedia) {
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (themePreference() === 'system') applyTheme(e.matches ? 'dark' : 'light');
      });
    } catch {}
  }
}
document.getElementById('btnTheme')?.addEventListener('click', () => {
  setThemePreference(themeCycle());
});
watchSystemTheme();
if (themePreference() === 'system') { applyTheme(mediaTheme()); applyResolved(); }
else applyTheme(getTheme());
{
  const searchViewInput = document.getElementById('searchViewInput');
  searchViewInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); renderSearchView(); }
  });
}
document.getElementById('searchFilter')?.addEventListener('change', () => {
  const el = document.getElementById('searchViewInput');
  if (el && (el.value || '').trim()) renderSearchView();
});
document.getElementById('searchSource')?.addEventListener('change', () => {
  const el = document.getElementById('searchViewInput');
  if (el && (el.value || '').trim()) renderSearchView();
});
try {
  const savedSrc = localStorage.getItem('vocalyx_searchSource_v1');
  const srcEl = document.getElementById('searchSource');
  if (savedSrc && srcEl && [...srcEl.options].some(o => o.value === savedSrc)) srcEl.value = savedSrc;
} catch {}
const searchViewBox = document.getElementById('searchViewBox');
document.getElementById('btnOnlineSearch')?.addEventListener('click', ()=>{
  const input = document.getElementById('searchViewInput');
  if (!searchViewBox || !input) { input?.focus(); return; }
  const willOpen = !searchViewBox.classList.contains('open');
  searchViewBox.classList.toggle('open', willOpen);
  if (willOpen) setTimeout(()=>input.focus(), 180);
  else { input.value=''; renderSearchView(); }
});
document.getElementById('btnClearSearch')?.addEventListener('click', ()=>{ const el=document.getElementById('searchViewInput'); if(el){ el.value=''; renderSearchView(); } });
document.querySelectorAll('.filter-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.querySelectorAll('.filter-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const el = document.getElementById('searchViewInput');
    if (el && (el.value || '').trim()) renderSearchView();
  });
});
document.querySelectorAll('.dl-format').forEach(b=>{
  b.addEventListener('click', ()=>{ document.querySelectorAll('.dl-format').forEach(x=>x.classList.remove('active')); b.classList.add('active'); saveDownloadOptions({format:b.dataset.format}); });
});
document.querySelectorAll('[data-strict-src]').forEach(el=>{
  el.addEventListener('change', ()=>{
    const map = { ...(S.downloadOptions.strictSources || {}) };
    map[el.dataset.strictSrc] = el.checked;
    saveDownloadOptions({ strictSources: map });
  });
});
document.getElementById('dlEnhance')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ audioEnhance: e.target.checked });
  applyEnhanceState();
});
document.getElementById('dlNormalize')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ normalizeVolume: e.target.checked });
  applyEnhanceState();
});
document.getElementById('dlTargetLufs')?.addEventListener('change', (e)=>{
  const v = parseInt(e.target.value, 10);
  if (!isNaN(v) && v >= -30 && v <= -1) { saveDownloadOptions({ targetLufs: v }); applyEnhanceState(); }
});
document.getElementById('vgEnabled')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ replayGainEnabled: e.target.checked });
  applyEnhanceState();
  ensureVolumeGain({ notify: e.target.checked });
});
document.getElementById('vgTarget')?.addEventListener('input', (e)=>{
  const v = parseInt(e.target.value, 10);
  if (isNaN(v)) return;
  const clamped = Math.max(-20, Math.min(-10, v));
  const lab = document.getElementById('vgTargetVal');
  if (lab) lab.textContent = clamped + ' LUFS';
  saveDownloadOptions({ replayGainTarget: clamped });
});
document.getElementById('vgTarget')?.addEventListener('change', ()=>{
  applyEnhanceState();
  ensureVolumeGain({ notify: true });
});
document.getElementById('vgPreamp')?.addEventListener('input', (e)=>{
  const v = parseInt(e.target.value, 10);
  if (isNaN(v)) return;
  const clamped = Math.max(-6, Math.min(6, v));
  const lab = document.getElementById('vgPreampVal');
  if (lab) lab.textContent = (clamped > 0 ? '+' : '') + clamped + ' dB';
  saveDownloadOptions({ replayGainPreAmp: clamped });
});
document.getElementById('vgPreamp')?.addEventListener('change', ()=>{
  applyEnhanceState();
});
document.getElementById('vgClip')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ replayGainClipPrevention: e.target.checked });
  applyEnhanceState();
});
document.getElementById('vgBrowseFolder')?.addEventListener('click', async ()=>{
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const p = await open({ directory: true });
    if (p) {
      localStorage.setItem('vocalyx_gainFolder', p);
      const el = document.getElementById('vgFolder');
      if (el) el.value = p;
    }
  } catch {}
});
document.getElementById('vgBulk')?.addEventListener('click', async ()=>{
  if (S._vgBulkBusy) return;
  const folder = (localStorage.getItem('vocalyx_gainFolder') || S.downloadFolder || '').trim();
  if (!folder || folder.startsWith('Default:')) {
    await showAlert(t('gain.mass'), t('gain.pickFirst'));
    return;
  }
  const target = rgTargetDb();
  const ok = await showModal({
    title: t('gain.mass'),
    message: t('gain.folderPrompt', { folder, target }),
    confirmText: t('gain.start'),
    cancelText: t('modal.cancel'),
  });
  if (!ok) return;
  S._vgBulkBusy = true;
  const btn = document.getElementById('vgBulk');
  const prog = document.getElementById('vgBulkProgress');
  if (btn) btn.disabled = true;
  if (prog) { prog.style.display = ''; prog.textContent = t('gain.measuring', { n: '0/…' }); }
  let offset = 0;
  let measured = 0, skipped = 0, failed = 0, total = 0;
  const errors = [];
  try {
    for (let round = 0; round < 40; round++) {
      const r = await fetch('http://127.0.0.1:8001/gain/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, target, offset, limit: 6 }),
      });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) {
        throw new Error((j && j.error) || `HTTP ${r.status}`);
      }
      measured += j.measured || 0;
      skipped += j.skipped || 0;
      failed += j.failed || 0;
      total = j.total || total;
      if (j.errors && j.errors.length) errors.push(...j.errors);
      if (prog) prog.textContent = t('gain.measuringNew', { done: j.done, total: j.total, new: measured });
      if (j.complete || !j.nextOffset || j.nextOffset <= offset) break;
      offset = j.nextOffset;
    }
    let msg = `Selesai: ${measured} terukur, ${skipped} cache, ${failed} gagal (total ${total}).`;
    if (errors.length) msg += `\nContoh gagal: ${errors.slice(0, 3).join('; ')}`;
    await showAlert('Gain Massal', msg);
    Object.keys(_rgGainCache).forEach(k => { if (k.endsWith('|' + target)) delete _rgGainCache[k]; });
  } catch (err) {
    await showAlert(t('gain.mass'), t('gain.failed', { n: err?.message || err }));
  } finally {
    S._vgBulkBusy = false;
    if (btn) btn.disabled = false;
    if (prog) { prog.style.display = 'none'; prog.textContent = ''; }
  }
});
document.getElementById('karaokeDevice')?.addEventListener('change', async (e)=>{
  const dev = e.target.value;
  const prev = (S.downloadOptions && S.downloadOptions.karaokeDevice) || 'cpu';
  saveDownloadOptions({ karaokeDevice: dev });
  try { refreshCudaStatus(); } catch {}
  const gpuMod = await import('./gpu.js');
  const ok = await gpuMod.setDeviceWithEngine(dev, '');
  if (!ok && S.downloadOptions.karaokeDevice === dev) {
    e.target.value = prev;
    saveDownloadOptions({ karaokeDevice: prev });
    try { refreshCudaStatus(); } catch {}
  }
});
document.getElementById('karaokeQuality')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ karaokeQuality: e.target.value });
});
document.getElementById('karaokeFormat')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ karaokeFormat: e.target.value });
});
document.getElementById('ytCookies')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ ytCookies: e.target.value });
});
document.getElementById('ytCookiesPath')?.addEventListener('change', (e)=>{
  saveDownloadOptions({ ytCookiesPath: e.target.value.trim() });
});

export { syncMaxBtn, attachDrag, ICON_MOON, ICON_SUN, ICON_HALF, getTheme, applyTheme, setThemePreference, themePreference, themeCycle, watchSystemTheme, searchViewBox };
