import { t } from './i18n/core.js';
import { isTauri, invokeTauri } from './tauri.js';

const RELEASES = 'https://github.com/ndova/vocalyx-releases/releases/download';

let cached = null;
let busy = false;
let listening = false;
let lastProgress = null;

const OFFLINE = { installed: false, variant: 'cpu', path: '', python: false, engine: false, cuda: false, bundled: false, extracting: false, failed: false };

function el(id) { return document.getElementById(id); }

function fmtMb(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

async function status() {
  if (!isTauri()) return { ...OFFLINE };
  try {
    const s = await invokeTauri('runtime_status');
    cached = s;
    return s;
  } catch {
    return { ...OFFLINE };
  }
}

function isPreparing(s) {
  if (!s || s.installed) return false;
  if (s.failed) return false;
  return !!(s.bundled || s.extracting);
}

function isExtractFailed(s) {
  return !!(s && !s.installed && s.bundled && s.failed && !s.extracting);
}

function paint(s) {
  const box = el('runtimeBanner');
  if (!box) return;
  if (!s || s.installed) { box.style.display = 'none'; box.classList.remove('open'); return; }

  box.style.display = 'flex';
  box.classList.add('open');

  const preparing = isPreparing(s);
  const title = el('runtimeBannerTitle');
  const desc = el('runtimeDesc');
  const installBtn = el('runtimeInstallBtn');
  const dismissBtn = el('runtimeDismissBtn');
  const bar = el('runtimeProgress');

  if (preparing) {
    if (title) title.textContent = t('runtime.preparing');
    if (desc) desc.textContent = t('runtime.preparingDesc');
    if (installBtn) installBtn.style.display = 'none';
    if (dismissBtn) dismissBtn.style.display = 'none';
    if (bar) bar.style.display = 'block';
    renderProgress(lastProgress, 'extract');
    return;
  }

  if (isExtractFailed(s)) {
    if (title) title.textContent = t('runtime.extractFailedTitle');
    if (desc) desc.textContent = t('runtime.extractFailedDesc');
    if (installBtn) {
      installBtn.style.display = '';
      installBtn.disabled = !!busy;
      installBtn.textContent = t('runtime.retryExtract');
      installBtn.onclick = () => retryExtractBundled();
    }
    if (dismissBtn) dismissBtn.style.display = '';
    if (bar) bar.style.display = 'none';
    return;
  }

  if (title) title.textContent = t('runtime.missing');
  if (desc) desc.textContent = t('runtime.missingDesc');
  if (installBtn) {
    installBtn.style.display = '';
    installBtn.disabled = !!busy;
    installBtn.textContent = busy ? t('runtime.busy') : t('runtime.download');
    installBtn.onclick = null;
  }
  if (dismissBtn) dismissBtn.style.display = '';
  if (bar) bar.style.display = busy ? 'block' : 'none';
}

function stageLabel(stage) {
  return stage === 'verify' ? t('runtime.verify')
    : stage === 'extract' ? t('runtime.extract')
    : stage === 'done' ? t('runtime.done')
    : t('runtime.downloading');
}

function renderProgress(p, fallbackStage) {
  const bar = el('runtimeProgress');
  const txt = el('runtimeProgressTxt');
  const fill = el('runtimeProgressFill');
  if (!bar) return;
  bar.style.display = 'block';
  const stage = String((p && p.stage) || fallbackStage || '');
  const label = stageLabel(stage);
  if (fill) {
    const pct = Math.max(0, Math.min(100, Number(p && p.percent) || 0));
    fill.style.width = pct.toFixed(1) + '%';
  }
  if (txt) {
    const received = Number(p && p.received) || 0;
    const total = Number(p && p.total) || 0;
    txt.textContent = (total ? fmtMb(received) + ' / ' + fmtMb(total) : fmtMb(received)) + ' - ' + label;
  }
}

function setProgress(p) {
  lastProgress = p || null;
  renderProgress(p, 'download');
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
  let s = await status();
  paint(s);
  el('runtimeInstallBtn')?.addEventListener('click', () => installRuntime());
  el('runtimeDismissBtn')?.addEventListener('click', () => {
    const box = el('runtimeBanner');
    if (box) { box.style.display = 'none'; box.classList.remove('open'); }
  });

  if (isTauri() && isPreparing(s)) {
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      s = await status();
      if (s.installed) { paint(s); return s; }
      if (!s.extracting && !s.bundled) break;
      paint(s);
    }
    paint(s);
  }
  return s;
}

export async function installRuntime(version) {
  if (busy) return null;
  busy = true;
  paint(cached || { ...OFFLINE });
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
    const btn = el('runtimeInstallBtn');
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = t('runtime.download'); }
    const dismiss = el('runtimeDismissBtn');
    if (dismiss) dismiss.style.display = '';
    return null;
  } finally {
    busy = false;
    const btn = el('runtimeInstallBtn');
    if (btn) { btn.disabled = false; btn.textContent = t('runtime.download'); }
  }
}

export async function retryExtractBundled() {
  if (busy) return null;
  busy = true;
  paint(cached || { ...OFFLINE });
  try {
    await invokeTauri('runtime_extract_bundled');
    const s = await status();
    paint(s);
    return s;
  } catch (e) {
    const desc = el('runtimeDesc');
    if (desc) desc.textContent = t('runtime.extractFailed', { n: e?.message || String(e) });
    return null;
  } finally {
    busy = false;
  }
}

export function runtimeStatus() { return cached; }
export { fmtMb };