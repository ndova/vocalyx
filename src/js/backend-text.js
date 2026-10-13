import { t } from './i18n/core.js';

const CODE_KEYS = {
  ERR_NO_DEVICE: 'iph.errNoDevice',
  ERR_APPLE_DRIVER_MISSING: 'iph.errDriverMissing',
  ERR_NOT_TRUSTED: 'iph.errNotTrusted',
  ERR_DEVICE_LOCKED: 'iph.errDeviceLocked',
  ERR_USBMUX: 'iph.errUsbmux',
};

export function backendCodeKey(code) {
  return CODE_KEYS[String(code || '')] || null;
}

export function backendText(payload, fallback) {
  const p = payload || {};
  const key = backendCodeKey(p.code);
  if (key) return t(key);
  const raw = String(p.hint || p.error || fallback || '');
  return raw;
}
