import { t } from './i18n/core.js';
import { isTauri, invokeTauri } from './tauri.js';

const RELEASES = 'https://github.com/ndova/vocalyx-releases/releases/download';

let cached = null;
let busy = false;
let listening = false;

function el(id) { return document.getElementById(id); }

function fmtMb(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

async function status() {
  if (!isTauri()) return { installed: false, variant: 'cpu', path: '', python: false, engine: false, cuda: false };
  try {
    const s = await invokeTauri('runtime_status');
    cached = s;
    return s;
  } catch {
    return { installed: false, variant: 'cpu', path: '', python: false, engine: false, cuda: false };
  }
}

function paint(s) {
  const box = el('runtimeBanner');
  if (!box) return;
  if (!s || s.installed) { box.style.display = 'none'; box.classList.remove('open'); return; }
  box.style.display = 'flex';
  box.classList.add('open');
  const title = el('runtimeBannerTitle');
  if (title) title.textContent = t('runtime.missing');
  const desc = el('runtimeDesc');
  if (desc) desc.textContent = t('runtime.missingDesc');
  const btn = el('runtimeInstallBtn');
  if (btn && busy) { btn.disabled = true; btn.textContent = t('runtime.busy'); }
  else if (btn && !busy) { btn.disabled = false; btn.textContent = t('runtime.download'); }
  const bar = el('runtimeProgress');
  if (bar) bar.style.display = busy ? 'block' : 'none';
}

function setProgress(p) {
  const bar = el('runtimeProgress');
  const txt = el('runtimeProgressTxt');
  const fill = el('runtimeProgressFill');
  if (!bar) return;
  bar.style.display = 'block';
  const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
  if (fill) fill.style.width = pct.toFixed(1) + '%';
  if (txt) {
    const stage = String(p.stage || '');
    const label = stage === 'verify' ? t('runtime.verify')
      : stage === 'extract' ? t('runtime.extract')
      : stage === 'done' ? t('runtime.done')
      : t('runtime.downloading');
    txt.textContent = (p.total ? fmtMb(p.received) + ' / ' + fmtMb(p.total) : fmtMb(p.received)) + ' - ' + label;
  }
}

async function listen() {
  if (listening || !isTauri()) return;
  listening = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('runtime://progress', (e) => {
      try { setProgress(e.payload || {}); } catch {}
    });
  } catch { listening = false; }
}

export async function initRuntime() {
  await listen();
  const s = await status();
  paint(s);
  el('runtimeInstallBtn')?.addEventListener('click', () => installRuntime());
  el('runtimeDismissBtn')?.addEventListener('click', () => {
    const box = el('runtimeBanner');
    if (box) { box.style.display = 'none'; box.classList.remove('open'); }
  });
  return s;
}

export async function installRuntime(version) {
  if (busy) return null;
  busy = true;
  paint(cached || { installed: false });
  try {
    const v = String(version || '').trim() || '0.1.0-beta';
    const base = `${RELEASES}/runtime-${v}`;
    await invokeTauri('runtime_install', {
      url: `${base}/runtime-cpu-${v}.zip`,
      sha256: `${base}/runtime-cpu-${v}.zip.sha256`,
    });
    const s = await status();
    paint(s);
    return s;
  } catch (e) {
    const box = el('runtimeBanner');
    if (box) box.style.display = 'flex';
    const desc = el('runtimeDesc');
    if (desc) desc.textContent = t('runtime.failed', { n: e?.message || String(e) });
    return null;
  } finally {
    busy = false;
    const btn = el('runtimeInstallBtn');
    if (btn) { btn.disabled = false; btn.textContent = t('runtime.download'); }
  }
}

export function runtimeStatus() { return cached; }
export { fmtMb };