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
  if (!lastDetected.length) return;
  if (S._lastCudaOffline === undefined) { S._lastCudaOffline = !engineOnline; return; }
  if (engineOnline === S._lastCudaOffline) return;
  S._lastCudaOffline = !engineOnline;
  if (engineOnline) {
    if (!S._deviceSwitching) S._cudaRestartingAt = false;
    try { refreshCudaStatus(); } catch {}
  }
}

let lastDetected = [];
let cached = false;

function el(id) { return document.getElementById(id); }

function shortPath(p) {
  const s = String(p || '');
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length <= 3 ? s : '...\\' + parts.slice(-3).join('\\');
}

function labelFor(info) {
  const name = shortPath(info.path);
  if (info.cuda) {
    const build = info.cuda_build ? ` ${info.cuda_build}` : '';
    const dev = info.device ? ` • ${info.device}` : '';
    return `${name} — CUDA${build}${dev}`;
  }
  return `${name} — CPU`;
}

function setStatus(text, ok) {
  const s = el('gpuPythonStatus');
  if (!s) return;
  s.textContent = text || '';
  s.style.color = ok === true ? 'var(--muted)' : ok === false ? '#e5484d' : 'var(--muted)';
}

function fillSelect() {
  const sel = el('gpuPythonSelect');
  if (!sel) return;
  const current = S.downloadOptions.gpuPython || '';
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('set.gpuPythonAuto');
  sel.appendChild(auto);
  for (const info of lastDetected) {
    const o = document.createElement('option');
    o.value = info.path;
    o.textContent = labelFor(info);
    if (info.path === current) o.selected = true;
    sel.appendChild(o);
  }
  if (!lastDetected.some((i) => i.path === current)) {
    sel.value = current ? '' : '';
  }
}

async function detect(force) {
  if (!isTauri()) { setStatus(t('set.gpuPythonTauriOnly'), false); return lastDetected; }
  if (cached && !force) { return lastDetected; }
  setStatus(t('set.gpuPythonDetecting'), null);
  try {
    lastDetected = await invokeTauri('detect_pythons_async', { force: !!force });
    cached = true;
  } catch {
    lastDetected = [];
  }
  fillSelect();
  const cudaReady = lastDetected.filter((i) => i.cuda && i.has_deps);
  applyDeviceAvailability('ready', cudaReady.length > 0);
  if (!lastDetected.length) {
    setStatus(t('set.gpuPythonNone'), false);
  } else if (cudaReady.length) {
    setStatus(t('set.gpuPythonFound', { n: cudaReady.length }), true);
  } else {
    const anyCuda = lastDetected.some((i) => i.cuda);
    setStatus(anyCuda ? t('set.gpuPythonNoDeps') : t('set.gpuPythonCpuOnly'), false);
  }
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
  setStatus(t('set.gpuPythonApplying'), null);
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
    const cudaOn = !!cfg.active_cuda;
    if (matched) setStatus(cudaOn ? t('set.gpuPythonActiveCuda') : t('set.gpuPythonActiveCpu'), cudaOn);
    else setStatus(`${t('set.gpuPythonSwitchFailed')}: engine tidak sesuai device ${device}`, false);
    return matched ? cfg : null;
  } catch (e) {
    setStatus(`${t('set.gpuPythonSwitchFailed')}: ${e?.message || String(e)}`, false);
    try { showToast(`${t('set.gpuPythonSwitchFailed')}: ${e?.message || String(e)}`, 7000); } catch {}
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
function currentGpuPython() {
  return String((S.downloadOptions && S.downloadOptions.gpuPython) || '');
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
    if (!sum || !Array.isArray(sum.entries)) { applyDeviceAvailability('checking', false); return false; }
    applyDeviceAvailability('ready', !!sum.cuda_ready);
    return true;
  } catch {
    applyDeviceAvailability('unknown', false);
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
    if (S.downloadOptions.karaokeDevice !== cfg.device) {
      S.downloadOptions.karaokeDevice = cfg.device;
      persist();
    }
    if (cfg.gpu_python && S.downloadOptions.gpuPython !== cfg.gpu_python) {
      S.downloadOptions.gpuPython = cfg.gpu_python;
      persist();
    }
    const dev = el('karaokeDevice');
    if (dev && dev.value !== cfg.device) dev.value = cfg.device;
    const sel = el('gpuPythonSelect');
    if (sel && cfg.gpu_python && sel.value !== cfg.gpu_python) sel.value = cfg.gpu_python;
    return cfg;
  } catch { return null; }
}

export async function initGpuPython() {
  try { registerCudaRefresh(autoRefreshCudaStatus); } catch {}
  applyDeviceAvailability('checking', false);
  const fromDisk = await loadCudaAvailabilityFromDisk();
  await syncEngineConfig();
  if (!fromDisk) {
    try { detect(false).catch(() => {}); } catch {}
  }
  const btn = el('btnDetectPythons');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      cached = false;
      await detect(true);
      btn.disabled = false;
    });
  }
  const sel = el('gpuPythonSelect');
  if (sel) {
    sel.addEventListener('change', async () => {
      const path = sel.value || '';
      S.downloadOptions.gpuPython = path;
      try { localStorage.setItem('vocalyx_downloadOptions', JSON.stringify(S.downloadOptions)); } catch {}
      await applyDevice(currentDevice(), path);
    });
  }
  setStatus(t('set.gpuPythonIdle'), null);
}

export async function setDeviceWithEngine(device, gpuPython) {
  return applyDevice(device, gpuPython);
}

export function hasCudaInterpreter() {
  const opt = deviceCudaOption();
  if (opt) return !opt.disabled && !!cached;
  return lastDetected.some((i) => i.cuda && i.has_deps);
}

export { detect as detectPythons };
