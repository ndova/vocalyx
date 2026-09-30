const MANIFEST_URL = 'https://raw.githubusercontent.com/ndova/vocalyx-releases/main/version.json';
const CHECK_AT_KEY = 'vocalyx_updateCheckAt_v1';
const SEEN_KEY = 'vocalyx_updateSeenVersion_v1';
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

export function manifestUrl() { return MANIFEST_URL; }

function normVer(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '').split('+')[0];
  const d = s.indexOf('-');
  return {
    core: (d >= 0 ? s.slice(0, d) : s).split('.'),
    pre: d >= 0 ? s.slice(d + 1).split('.') : [],
  };
}

export function compareSemver(a, b) {
  const A = normVer(a);
  const B = normVer(b);
  for (let i = 0; i < 3; i++) {
    const x = parseInt(A.core[i], 10) || 0;
    const y = parseInt(B.core[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;
  if (!B.pre.length) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = (parseInt(x, 10) || 0) - (parseInt(y, 10) || 0);
      if (d) return d < 0 ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export async function currentVersion() {
  try {
    const m = await import('@tauri-apps/api/app');
    const v = await m.getVersion();
    return typeof v === 'string' ? v.trim() : '';
  } catch { return ''; }
}

export async function fetchManifest() {
  if (!MANIFEST_URL) return { ok: false, reason: 'unconfigured' };
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, TIMEOUT_MS) : 0;
  try {
    const r = await fetch(MANIFEST_URL, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return { ok: false, reason: 'http' };
    const j = await r.json();
    if (!j || typeof j.version !== 'string' || !j.version.trim()) return { ok: false, reason: 'shape' };
    return { ok: true, data: j };
  } catch { return { ok: false, reason: 'network' }; }
  finally { if (timer) clearTimeout(timer); }
}

export async function checkForUpdate() {
  const current = await currentVersion();
  if (!MANIFEST_URL) return { state: 'unconfigured', current, latest: '', url: '', msi: '', notes: '' };
  const m = await fetchManifest();
  if (!m.ok) return { state: 'error', current, latest: '', url: '', msi: '', notes: '', reason: m.reason };
  const latest = m.data.version.trim();
  const dl = m.data.downloads && typeof m.data.downloads === 'object' ? m.data.downloads : {};
  const setup = (typeof dl.setup === 'string' && dl.setup) || (typeof m.data.url === 'string' ? m.data.url : '');
  const msi = typeof dl.msi === 'string' ? dl.msi : '';
  const notes = typeof m.data.notes === 'string' ? m.data.notes : '';
  if (!current) return { state: 'error', current, latest, url: setup, msi, notes, reason: 'version' };
  const newer = compareSemver(latest, current) > 0;
  return { state: newer ? 'available' : 'current', current, latest, url: setup, msi, notes };
}

function readNum(k) { try { return parseInt(localStorage.getItem(k) || '0', 10) || 0; } catch { return 0; } }
function write(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }

export function lastCheckAt() { return readNum(CHECK_AT_KEY); }
export function seenVersion() { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } }
export function markChecked() { write(CHECK_AT_KEY, Date.now()); }
export function markSeen(v) { write(SEEN_KEY, v); }

export async function startBackgroundCheck(onFound) {
  if (!MANIFEST_URL) return null;
  if (Date.now() - lastCheckAt() < INTERVAL_MS) return null;
  const r = await checkForUpdate();
  markChecked();
  if (r.state === 'available' && typeof onFound === 'function' && compareSemver(r.latest, seenVersion()) > 0) {
    markSeen(r.latest);
    try { onFound(r); } catch {}
  }
  return r;
}

export async function openDownload(url) {
  const u = String(url || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return false;
  try {
    const m = await import('@tauri-apps/plugin-opener');
    const fn = m.openUrl || (m.default && m.default.openUrl);
    if (typeof fn !== 'function') return false;
    await fn(u);
    return true;
  } catch { return false; }
}
