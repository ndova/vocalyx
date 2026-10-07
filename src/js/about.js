import { t, onLangChange, lang } from './i18n/core.js';
import { engineInfo, showToast } from './engine.js';
import { checkForUpdate, manifestUrl, openDownload } from './updater.js';

let aboutOpen = false;
let updateState = null;

const SUPPORT_URL = 'https://www.buymeacoffee.com/nny7jp2d2bh';
const SUPPORT_SAWERIA_URL = 'https://saweria.co/ndova';

export function syncSupportButtons(next) {
  const l = String(next || lang() || 'en').toLowerCase();
  const saweria = l === 'id' || l === 'jv';
  const bmc = document.getElementById('btnSupport');
  const saw = document.getElementById('btnSaweria');
  if (bmc) bmc.style.display = saweria ? 'none' : '';
  if (saw) saw.style.display = saweria ? '' : 'none';
}

function setRow(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

let appVersion = '';

function paintVersion() {
  setRow('aboutVersion', appVersion || '—');
  const prerelease = appVersion.includes('-');
  document.querySelectorAll('.beta-badge').forEach((el) => { el.hidden = !prerelease; });
}

async function loadVersion() {
  try {
    const m = await import('@tauri-apps/api/app');
    const v = await m.getVersion();
    appVersion = typeof v === 'string' ? v.trim() : '';
  } catch { appVersion = ''; }
  paintVersion();
}

async function fillEngineRows() {
  setRow('aboutEngineState', t('ab.engineOffline'));
  setRow('aboutEngineDevice', '—');
  setRow('aboutEngineTorch', '—');
  setRow('aboutEngineModel', '—');
  try {
    const info = await engineInfo();
    if (!aboutOpen) return;
    if (!info) return;
    setRow('aboutEngineState', t('std.online'));
    setRow('aboutEngineDevice', info.cuda ? (info.device || 'CUDA') : t('ab.cpuNoCuda'));
    setRow('aboutEngineTorch', info.torch ? `PyTorch ${info.torch}` : '—');
    setRow('aboutEngineModel', info.bs_available
      ? `RoFormer — ${info.bs_roformer || t('ab.roformerReady')}`
      : t('ab.roformerUnavailable'));
  } catch {}
}

function setRowClass(id, cls) {
  const el = document.getElementById(id);
  if (el) el.className = 'about-val' + (cls ? ' ' + cls : '');
}

function paintUpdate(r) {
  const el = document.getElementById('aboutUpdate');
  if (!el) return;
  setRowClass('aboutUpdate', '');
  if (!r || r.state === 'unconfigured') { setRow('aboutUpdate', manifestUrl() ? t('ab.notChecked') : t('ab.notConfigured')); return; }
  if (r.state === 'checking') { setRow('aboutUpdate', t('ab.checking')); return; }
  if (r.state === 'error') { setRowClass('aboutUpdate', 'is-error'); setRow('aboutUpdate', t('ab.checkFailed')); return; }
  if (r.state === 'available') {
    setRowClass('aboutUpdate', 'is-new');
    setRow('aboutUpdate', t('ab.availableVersion', { v: r.latest }));
    return;
  }
  setRow('aboutUpdate', t('ab.upToDate', { v: r.current || '—' }));
}

function showDownloads(r) {
  const wrap = document.getElementById('aboutDlWrap');
  if (!wrap) return;
  const ok = !!r && r.state === 'available';
  wrap.style.display = ok ? 'inline-flex' : 'none';
  const bMsi = document.getElementById('aboutDlMsi');
  if (bMsi) bMsi.style.display = ok && r.msi ? 'inline-flex' : 'none';
}

async function runUpdateCheck(silent) {
  const btn = document.getElementById('aboutCheckUpdate');
  if (btn) btn.disabled = true;
  paintUpdate({ state: 'checking' });
  let r = null;
  try { r = await checkForUpdate(); } catch { r = { state: 'error' }; }
  updateState = r;
  if (btn) btn.disabled = false;
  if (!aboutOpen && silent) return r;
  paintUpdate(r);
  showDownloads(r);
  if (!silent) {
    if (r.state === 'available') showToast(t('ab.newVer', { v: r.latest }), 5000);
    else if (r.state === 'current') showToast(t('ab.upToDate'), 3000);
    else if (r.state === 'unconfigured') showToast(t('ab.manifestEmpty'), 4000);
    else showToast(t('ab.checkFail'), 4000);
  }
  return r;
}

function openAbout() {
  const modal = document.getElementById('aboutModal');
  if (!modal || aboutOpen) return;
  aboutOpen = true;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  paintVersion();
  loadVersion();
  fillEngineRows();
  paintUpdate(updateState);
  showDownloads(updateState);
}

function closeAbout() {
  const modal = document.getElementById('aboutModal');
  if (!modal || !aboutOpen) return;
  aboutOpen = false;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

export function initAbout() {
  document.getElementById('btnAbout')?.addEventListener('click', openAbout);
  document.getElementById('aboutClose')?.addEventListener('click', closeAbout);
  document.getElementById('aboutDone')?.addEventListener('click', closeAbout);
  document.getElementById('aboutBackdrop')?.addEventListener('click', closeAbout);
  document.getElementById('aboutCheckUpdate')?.addEventListener('click', () => runUpdateCheck(false));
  document.getElementById('aboutDlSetup')?.addEventListener('click', async () => {
    const ok = await openDownload(updateState && updateState.url);
    if (!ok) showToast(t('ab.dlLinkMissing'), 3000);
  });
  document.getElementById('aboutDlMsi')?.addEventListener('click', async () => {
    const ok = await openDownload(updateState && updateState.msi);
    if (!ok) showToast(t('ab.dlLinkMissing'), 3000);
  });
  document.getElementById('btnSupport')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const ok = await openDownload(SUPPORT_URL);
    if (!ok) showToast(t('ab.openLinkFail'), 3000);
  });
  document.getElementById('btnSaweria')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const ok = await openDownload(SUPPORT_SAWERIA_URL);
    if (!ok) showToast(t('ab.openLinkFail'), 3000);
  });
  try { onLangChange(syncSupportButtons); } catch {}
  try { syncSupportButtons(); } catch {}
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAbout(); });
  loadVersion();
}
