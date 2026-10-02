import { t } from './core.js';

const STORE_KEY = 'vocalyx_eq_v1';
const IDS = ['flat', 'rock', 'pop', 'jazz', 'electro', 'hiphop', 'classical', 'vocal'];
const LEGACY = { Flat:'flat', Rock:'rock', Pop:'pop', Jazz:'jazz', Electro:'electro', HipHop:'hiphop', 'Hip-Hop':'hiphop', Classical:'classical', Vocal:'vocal', Custom:'custom' };

export function presetLabel(name) {
  const id = LEGACY[name] || name;
  return t('eq.' + id);
}

export function presetList() {
  return IDS.map((id) => ({ id, label: t('eq.' + id) }));
}

export function migrateEqState() {
  let st = null;
  try { st = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch {}
  if (!st || typeof st !== 'object') return null;
  const cur = st.preset;
  if (typeof cur === 'string' && LEGACY[cur]) {
    st.preset = LEGACY[cur];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch {}
  }
  return st;
}
