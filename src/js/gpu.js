import { t } from './i18n/core.js';
import { S } from './state.js';
import { isTauri, invokeTauri } from './tauri.js';
import { refreshCudaStatus, registerCudaRefresh, showToast } from './engine.js';

export function markCudaRestarting() {
  S._cudaRestartingAt = Date.now();
  S._deviceSwitching = true;
  const e = el('karaokeCudaStatus');
  if (e) { e.textContent = t('eng.restarting'); e.style.color = 'var(--muted)'; }
}

export function karaokeCudaLabel(caps) {
  if (!caps) return t('eng.offlineCuda');
  if (caps.cuda) {
    const vram = (caps.vram_free_gb != null && caps.vram_total_gb != null)
      ? ` • VRAM bebas ${caps.vram_free_gb}/${caps.vram_total_gb} GB` : '';
    const kim = caps.kim_cached ? ` • model Kim ${caps.kim_mb || '?'} MB (cached)` : ' • model Kim belum terdownload';
    return `CUDA terdeteksi: ${caps.device || 'GPU'}${vram}${kim}`;
  }
  const prov = (caps.providers && caps.providers.length) ? caps.providers.join(',') : 'tanpa provider GPU';
  return `CUDA tidak aktif — runtime bawaan memakai PyTorch CPU (${prov}). Untuk memakai GPU, atur "Python CUDA" di Settings › Karaoke.`;
}

function autoRefreshCudaStatus(engineOnline) {
  const wasOnline = S._lastCudaOffline === false;
  S._lastCudaOffline = !engineOnline;
  if (engineOnline) {
    if (!S._deviceSwitching) S._cudaRestartingAt = false;
    try { refreshCudaStatus(); } catch {}
    return;
  }
  if (wasOnline) {
    S._prevCudaActive = false;
    try { refreshCudaStatus(); } catch {}
  }
}

let lastDetected = [];
let cached = false;

function el(id) { return document.getElementById(id); }

function cudaGpuName(entries) {
  const hit = (entries || []).find((i) => i && i.cuda && i.has_deps && i.device);
  return hit ? hit.device : '';
}

function applyDeviceHint(state, entries) {
  const hint = el('deviceCudaHint');
  if (!hint) return;
  hint.style.color = 'var(--muted)';
  if (state === 'checking') { hint.textContent = t('set.deviceCudaHintChecking'); return; }
  if (state !== 'ready') { hint.textContent = t('set.deviceCudaHintUnknown'); return; }
  const cudaReady = (entries || []).some((i) => i && i.cuda && i.has_deps);
  if (!cudaReady) {
    hint.textContent = t('set.deviceCudaHintNone');
    return;
  }
  const usingCuda = String((S.downloadOptions && S.downloadOptions.karaokeDevice) || 'cpu').toLowerCase() === 'cuda';
  const name = cudaGpuName(entries);
  hint.textContent = usingCuda
    ? t('set.deviceCudaHintReady', { gpu: name || 'CUDA' })
    : t('set.deviceCudaHintReadyCpu', { gpu: name || 'CUDA' });
}

async function detect(force) {
  if (!isTauri()) return lastDetected;
  if (cached && !force) return lastDetected;
  try {
    lastDetected = await invokeTauri('detect_pythons_async', { force: !!force });
    cached = true;
  } catch {
    lastDetected = [];
  }
  const cudaReady = lastDetected.filter((i) => i.cuda && i.has_deps);
  applyDeviceAvailability('ready', cudaReady.length > 0);
  applyDeviceHint('ready', lastDetected);
  return lastDetected;
}

let applying = false;
let deviceQueue = Promise.resolve();
let queueSeq = 0;

async function waitEngineReady(timeoutMs) {
  const limit = Date.now() + (timeoutMs || 90000);
  while (Date.now() < limit) {
    try {
      const r = await fetch('http://127.0.0.1:8001/health', { cache: 'no-store' });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function runApplyDevice(device, gpuPython) {
  applying = true;
  markCudaRestarting();
  try {
    const cfg = await invokeTauri('set_engine_config', { device, gpuPython: gpuPython || '' });
    const strict = device === 'cuda';
    let matched = false;
    let active = false;
    for (let i = 0; i < 90; i++) {
      const online = await waitEngineReady(1000);
      try { active = !!(await refreshCudaStatus(true)); } catch { active = false; }
      if (online && (!strict || active === true)) { matched = true; break; }
    }
    if (!matched) {
      try { showToast(`${t('set.deviceSwitchFailed')}: engine tidak sesuai device ${device}`, 7000); } catch {}
      return null;
    }
    applyDeviceHint(cached ? 'ready' : 'checking', lastDetected);
    return cfg;
  } catch (e) {
    try { showToast(`${t('set.deviceSwitchFailed')}: ${e?.message || String(e)}`, 7000); } catch {}
    return null;
  } finally {
    applying = false;
    S._deviceSwitching = false;
  }
}

async function applyDevice(device, gpuPython) {
  if (!isTauri()) return null;
  const seq = ++queueSeq;
  const p = deviceQueue.then(async () => {
    if (seq !== queueSeq) return null;
    return runApplyDevice(device, gpuPython);
  });
  deviceQueue = p.then(() => {}, () => {});
  return p;
}

function currentDevice() {
  return String((S.downloadOptions && S.downloadOptions.karaokeDevice) || 'cpu').toLowerCase();
}

function deviceCudaOption() {
  const dev = el('karaokeDevice');
  if (!dev) return null;
  return [...dev.options].find((o) => o.value === 'cuda') || null;
}

function applyDeviceAvailability(state, cudaReady) {
  const opt = deviceCudaOption();
  if (!opt) return;
  const base = t('set.deviceCuda');
  if (state === 'checking') {
    opt.disabled = false;
    opt.textContent = `${base} (${t('set.deviceCudaChecking')})`;
    return;
  }
  if (state !== 'ready') {
    opt.disabled = false;
    opt.textContent = base;
    return;
  }
  opt.disabled = !cudaReady;
  opt.textContent = cudaReady ? base : `${base} — ${t('set.deviceCudaUnsupported')}`;
  if (!cudaReady) {
    const dev = el('karaokeDevice');
    if (dev && dev.value === 'cuda') {
      dev.value = 'cpu';
      S.downloadOptions.karaokeDevice = 'cpu';
      try { localStorage.setItem('vocalyx_downloadOptions', JSON.stringify(S.downloadOptions)); } catch {}
    }
  }
}

async function loadCudaAvailabilityFromDisk() {
  try {
    const sum = await invokeTauri('gpu_probe_cached', { maxAgeSecs: 86400 });
    if (!sum || !Array.isArray(sum.entries)) {
      applyDeviceAvailability('checking', false);
      applyDeviceHint('checking', null);
      return false;
    }
    applyDeviceAvailability('ready', !!sum.cuda_ready);
    applyDeviceHint('ready', sum.entries);
    return true;
  } catch {
    applyDeviceAvailability('unknown', false);
    applyDeviceHint('unknown', null);
    return false;
  }
}

export async function syncEngineConfig() {
  if (!isTauri()) return null;
  try {
    const cfg = await invokeTauri('get_engine_config');
    if (!cfg || !cfg.device) return null;
    if (!S.downloadOptions) S.downloadOptions = {};
    const persist = () => {
      try { localStorage.setItem('vocalyx_downloadOptions', JSON.stringify(S.downloadOptions)); } catch {}
    };
    let device = cfg.device;
    const cudaOpt = deviceCudaOption();
    if (device === 'cuda' && cudaOpt && cudaOpt.disabled) device = 'cpu';
    if (S.downloadOptions.karaokeDevice !== device) {
      S.downloadOptions.karaokeDevice = device;
      persist();
    }
    if (S.downloadOptions.gpuPython) {
      S.downloadOptions.gpuPython = '';
      persist();
    }
    const dev = el('karaokeDevice');
    if (dev && dev.value !== device) dev.value = device;
    applyDeviceHint(cudaOpt && !cudaOpt.disabled && lastDetected.length ? 'ready' : 'checking', lastDetected);
    return cfg;
  } catch { return null; }
}

let gpuProbeRequested = false;

export async function ensureGpuPythonProbed() {
  if (gpuProbeRequested || cached) return;
  gpuProbeRequested = true;
  try { await detect(false); } catch {}
}

export async function initGpuPython() {
  try { registerCudaRefresh(autoRefreshCudaStatus); } catch {}
  applyDeviceAvailability('checking', false);
  applyDeviceHint('checking', null);
  await loadCudaAvailabilityFromDisk();
  await syncEngineConfig();
  try { initCudaSetup(); } catch {}
}

let cudaSetupListening = false;
let cudaSetupBusy = false;

function cudaSetupEls() {
  return {
    box: el('cudaSetupBox'),
    status: el('cudaSetupStatus'),
    btn: el('cudaSetupBtn'),
    cancel: el('cudaSetupCancelBtn'),
    barWrap: el('cudaSetupBarWrap'),
    bar: el('cudaSetupBar'),
    pct: el('cudaSetupPct'),
  };
}

function fmtGb(b) {
  const gb = Number(b) / 1e9;
  return (gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)) + ' GB';
}

function cudaSetupStageLabel(stage) {
  const s = String(stage || '');
  if (s === 'venv') return t('set.cudaSetupStageVenv');
  if (s === 'pip') return t('set.cudaSetupStagePip');
  if (s === 'torch') return t('set.cudaSetupStageTorch');
  if (s === 'deps') return t('set.cudaSetupStageDeps');
  if (s === 'verify') return t('set.cudaSetupStageVerify');
  if (s === 'done') return t('set.cudaSetupStageDone');
  if (s === 'failed') return t('set.cudaSetupStageFailed');
  if (s === 'precheck') return t('set.cudaSetupStagePrecheck');
  if (s === 'extract') return t('set.cudaSetupStagePrecheck');
  return s || t('set.cudaSetupStageWorking');
}

let lastCudaProg = null;
let lastCudaEventAt = 0;

function paintCudaSetup(st, prog) {
  const { box, status, btn, cancel, barWrap, bar, pct } = cudaSetupEls();
  if (!box) return;
  const state = String((st && st.state) || 'missing');
  if (prog && typeof prog.percent !== 'undefined') {
    lastCudaProg = prog;
    lastCudaEventAt = Date.now();
  }
  const show = state === 'missing' || state === 'failed' || state === 'installing';
  box.style.display = show ? '' : 'none';
  if (!show) {
    lastCudaProg = null;
    return;
  }
  if (status) {
    status.textContent = state === 'installing'
      ? t('set.cudaSetupInstalling')
      : state === 'failed'
        ? t('set.cudaSetupFailed')
        : t('set.cudaSetupMissing');
  }
  const busy = state === 'installing' || cudaSetupBusy;
  if (btn) btn.style.display = busy ? 'none' : '';
  if (cancel) cancel.style.display = busy ? '' : 'none';
  const eff = prog || (state === 'installing' ? lastCudaProg : null);
  const stale = state === 'installing' && (!eff || (Date.now() - lastCudaEventAt) >= 15000);
  if (barWrap) barWrap.style.display = (eff || state === 'installing') ? '' : 'none';
  if (bar) {
    bar.classList.toggle('pulsing', state === 'installing' && (stale || !eff));
    if (eff) {
      const v = Math.max(state === 'installing' ? 6 : 0, Math.min(100, Number(eff.percent) || 0));
      bar.style.width = v.toFixed(1) + '%';
    } else if (state === 'installing') {
      bar.style.width = '12%';
    }
  }
  const shown = eff || (state === 'installing' && lastCudaProg);
  if (shown && pct) {
    const base = eff || lastCudaProg || {};
    const r = Number(base.received) || 0;
    const tot = Number(base.total) || 0;
    pct.textContent = `${fmtGb(r)}${tot ? ' / ' + fmtGb(tot) : ''} — ${cudaSetupStageLabel(base.stage)}`;
  } else if (pct) {
    pct.textContent = state === 'installing' ? cudaSetupStageLabel('precheck') : '';
  }
}

async function refreshCudaSetup(paint = true) {
  if (!isTauri()) return null;
  try {
    const st = await invokeTauri('cuda_setup_status');
    const state = String((st && st.state) || '');
    if (paint && (state === 'ready' || state === 'failed' || state === 'missing' || (Date.now() - lastCudaEventAt) >= 3000)) {
      paintCudaSetup(st, null);
    }
    return st;
  } catch { return null; }
}

async function startCudaSetup() {
  if (!isTauri() || cudaSetupBusy) return;
  cudaSetupBusy = true;
  try { paintCudaSetup({ state: 'installing' }, { received: 0, total: 0, percent: 0, stage: 'precheck' }); } catch {}
  try {
    const pre = await invokeTauri('cuda_setup_precheck');
    if (pre && !pre.ok) {
      const msg = (pre.errors || []).join(' ') || t('set.cudaSetupPrecheckFail');
      try { showToast(msg, 8000); } catch {}
      cudaSetupBusy = false;
      await refreshCudaSetup();
      return;
    }
    const warns = (pre && pre.warnings) || [];
    if (warns.length) { try { showToast(warns.join(' '), 6000); } catch {} }
    await invokeTauri('cuda_setup_start');
    pollCudaSetupDone();
  } catch (e) {
    try { showToast(String((e && e.message) || e), 7000); } catch {}
    cudaSetupBusy = false;
    await refreshCudaSetup();
  }
}

async function pollCudaSetupDone() {
  for (let i = 0; i < 1800; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await refreshCudaSetup();
    const state = String((st && st.state) || '');
    if (state === 'ready' || state === 'failed' || state === 'missing') break;
    if (state !== 'installing') break;
  }
  cudaSetupBusy = false;
  await refreshCudaSetup();
  try {
    cached = false;
    await detect(true);
  } catch {}
}

async function initCudaSetup() {
  if (!isTauri()) return;
  if (!cudaSetupListening) {
    cudaSetupListening = true;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('cuda-setup://progress', (e) => {
        try {
          const p = e.payload || {};
          if (p.stage === 'done') {
            paintCudaSetup({ state: 'ready' }, null);
            cudaSetupBusy = false;
            refreshCudaSetup().catch(() => {});
            cached = false;
            detect(true).catch(() => {});
            return;
          }
          if (p.stage === 'failed') {
            paintCudaSetup({ state: 'failed' }, null);
            cudaSetupBusy = false;
            refreshCudaSetup().catch(() => {});
            return;
          }
          paintCudaSetup({ state: 'installing' }, p);
        } catch {}
      });
    } catch {}
  }
  el('cudaSetupBtn')?.addEventListener('click', () => startCudaSetup());
  el('cudaSetupCancelBtn')?.addEventListener('click', async () => {
    try { await invokeTauri('cuda_setup_cancel'); } catch {}
    cudaSetupBusy = false;
    await refreshCudaSetup();
  });
  await refreshCudaSetup();
}

export async function setDeviceWithEngine(device, gpuPython) {
  return applyDevice(device, gpuPython);
}


