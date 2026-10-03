import { t } from './i18n/core.js';
import { S } from './state.js';
import { isTauri, invokeTauri } from './tauri.js';
import { refreshCudaStatus, showToast } from './engine.js';

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

async function applyDevice(device, gpuPython) {
  if (!isTauri()) return null;
  if (applying) return null;
  applying = true;
  setStatus(t('set.gpuPythonApplying'), null);
  try {
    const cfg = await invokeTauri('set_engine_config', { device, gpuPython: gpuPython || '' });
    setStatus(cfg.active_cuda ? t('set.gpuPythonActiveCuda') : t('set.gpuPythonActiveCpu'), cfg.active_cuda);
    try { await refreshCudaStatus(); } catch {}
    return cfg;
  } catch (e) {
    setStatus(`${t('set.gpuPythonSwitchFailed')}: ${e?.message || String(e)}`, false);
    try { showToast(`${t('set.gpuPythonSwitchFailed')}: ${e?.message || String(e)}`, 7000); } catch {}
    return null;
  } finally {
    applying = false;
  }
}

function currentDevice() {
  return String((S.downloadOptions && S.downloadOptions.karaokeDevice) || 'auto').toLowerCase();
}
function currentGpuPython() {
  return String((S.downloadOptions && S.downloadOptions.gpuPython) || '');
}

export async function initGpuPython() {
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
  return lastDetected.some((i) => i.cuda && i.has_deps);
}

export { detect as detectPythons };