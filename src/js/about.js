import { engineInfo, showToast } from './engine.js';
import { checkForUpdate, manifestUrl, openDownload } from './updater.js';

let aboutOpen = false;
let updateState = null;

function setRow(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function paintVersion(v) {
  const ver = String(v == null ? '' : v).trim();
  setRow('aboutVersion', ver ? `Versi ${ver}` : 'Versi —');
  const badge = document.getElementById('aboutBadge');
  if (badge) badge.hidden = !ver.includes('-');
}

async function fillEngineRows() {
  setRow('aboutEngineState', 'Engine offline');
  setRow('aboutEngineDevice', '—');
  setRow('aboutEngineTorch', '—');
  setRow('aboutEngineModel', '—');
  try {
    const info = await engineInfo();
    if (!aboutOpen) return;
    if (!info) return;
    setRow('aboutEngineState', 'Online');
    setRow('aboutEngineDevice', info.cuda ? (info.device || 'CUDA') : 'CPU (tanpa CUDA)');
    setRow('aboutEngineTorch', info.torch ? `PyTorch ${info.torch}` : '—');
    setRow('aboutEngineModel', info.bs_available
      ? `BS-RoFormer — ${info.bs_roformer || 'siap'}`
      : 'BS-RoFormer tidak tersedia');
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
  if (!r || r.state === 'unconfigured') { setRow('aboutUpdate', manifestUrl() ? 'Belum diperiksa' : 'Belum dikonfigurasi'); return; }
  if (r.state === 'checking') { setRow('aboutUpdate', 'Memeriksa…'); return; }
  if (r.state === 'error') { setRowClass('aboutUpdate', 'is-error'); setRow('aboutUpdate', 'Gagal memeriksa'); return; }
  if (r.state === 'available') {
    setRowClass('aboutUpdate', 'is-new');
    setRow('aboutUpdate', `Tersedia ${r.latest}`);
    return;
  }
  setRow('aboutUpdate', `Terbaru (${r.current || '—'})`);
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
    if (r.state === 'available') showToast(`VocaLyx ${r.latest} tersedia`, 5000);
    else if (r.state === 'current') showToast('VocaLyx sudah versi terbaru', 3000);
    else if (r.state === 'unconfigured') showToast('Alamat manifest belum diisi', 4000);
    else showToast('Gagal memeriksa pembaruan', 4000);
  }
  return r;
}

function openAbout() {
  const modal = document.getElementById('aboutModal');
  if (!modal || aboutOpen) return;
  aboutOpen = true;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  setRow('aboutVersion', '…');
  try {
    import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then((v) => { if (aboutOpen) paintVersion(v); })
      .catch(() => { if (aboutOpen) paintVersion(''); });
  } catch {
    paintVersion('');
  }
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
    if (!ok) showToast('Tautan unduhan tidak tersedia', 3000);
  });
  document.getElementById('aboutDlMsi')?.addEventListener('click', async () => {
    const ok = await openDownload(updateState && updateState.msi);
    if (!ok) showToast('Tautan unduhan tidak tersedia', 3000);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAbout(); });
}
