import { t } from './i18n/core.js';
import { isTauri, invokeTauri } from './tauri.js';

function el(id) { return document.getElementById(id); }

let busy = false;

async function status() {
  if (!isTauri()) return null;
  try {
    return await invokeTauri('vc_runtime_status');
  } catch {
    return null;
  }
}

function paint(s) {
  const box = el('vcBanner');
  if (!box) return;
  if (!s || s.present) {
    box.style.display = 'none';
    box.classList.remove('open');
    return;
  }
  box.style.display = 'flex';
  box.classList.add('open');
  const title = el('vcBannerTitle');
  const desc = el('vcDesc');
  const btn = el('vcInstallBtn');
  if (title) title.textContent = t('vc.missing');
  if (desc) {
    desc.textContent = busy
      ? t('vc.installing')
      : (s.installer_bundled ? t('vc.missingDesc') : t('vc.missingDescManual'));
  }
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? t('vc.installing') : t('vc.install');
  }
}

export async function initVc() {
  const s = await status();
  paint(s);
  el('vcInstallBtn')?.addEventListener('click', () => installVc());
  el('vcDismissBtn')?.addEventListener('click', () => {
    const box = el('vcBanner');
    if (box) { box.style.display = 'none'; box.classList.remove('open'); }
  });
}

export async function installVc() {
  if (busy) return null;
  busy = true;
  paint({ present: false, installer_bundled: true });
  try {
    await invokeTauri('vc_runtime_install');
  } catch (e) {
    const desc = el('vcDesc');
    if (desc) desc.textContent = t('vc.failedDetail', { n: e?.message || String(e) });
    busy = false;
    return null;
  }
  busy = false;
  let s = null;
  try {
    s = await status();
  } catch {}
  paint(s || { present: false, installer_bundled: false });
  if (s && !s.present) {
    const desc = el('vcDesc');
    if (desc) desc.textContent = t('vc.failed');
  }
  return s;
}
