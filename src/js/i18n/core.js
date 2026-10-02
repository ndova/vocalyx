import ID from './id.js';
import JV from './jv.js';
import EN from './en.js';

const KEY = 'vocalyx_lang_v1';
const BASE = 'en';
const DICT = { en: EN, id: ID, jv: JV };
const FALLBACK = DICT[BASE];
const CUR = { lang: BASE };
const subs = new Set();
const LANG_FALLBACK = {
  'lang.idName': 'Bahasa Indonesia',
  'lang.jvName': 'Basa Jawa',
  'lang.enName': 'English',
};

export function lang() { return CUR.lang; }

export function applyLang(next) {
  const want = String(next || '');
  CUR.lang = Object.prototype.hasOwnProperty.call(DICT, want) ? want : BASE;
  try { localStorage.setItem(KEY, CUR.lang); } catch {}
  syncDocument();
  subs.forEach((fn) => { try { fn(CUR.lang); } catch {} });
  return CUR.lang;
}

export function onLangChange(fn) {
  if (typeof fn === 'function') subs.add(fn);
  return () => subs.delete(fn);
}

export function syncDocument() {
  try { document.documentElement.lang = CUR.lang; } catch {}
}

export function t(key, vars) {
  let s = DICT[CUR.lang][key];
  if (s == null) s = FALLBACK[key];
  if (s == null) return key;
  if (!vars) return s;
  return String(s).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? vars[n] : m));
}

export function tHtml(key, vars) {
  return t(key, vars).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function translateTree(root) {
  const el = root || document;
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-t]').forEach((n) => {
    if (n.children.length) return;
    const key = n.getAttribute('data-t');
    const val = t(key, n.dataset.tVars ? JSON.parse(n.dataset.tVars) : null);
    n.textContent = val === key ? (LANG_FALLBACK[key] || key) : val;
  });
  el.querySelectorAll('[data-t-html]').forEach((n) => {
    n.innerHTML = t(n.getAttribute('data-t-html'), n.dataset.tVars ? JSON.parse(n.dataset.tVars) : null);
  });
  el.querySelectorAll('[data-t-title]').forEach((n) => {
    n.title = t(n.getAttribute('data-t-title'));
  });
  el.querySelectorAll('[data-t-placeholder]').forEach((n) => {
    n.setAttribute('placeholder', t(n.getAttribute('data-t-placeholder')));
  });
  el.querySelectorAll('[data-t-aria]').forEach((n) => {
    n.setAttribute('aria-label', t(n.getAttribute('data-t-aria')));
  });
}

export function initI18n() {
  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch {}
  return applyLang(saved);
}

export function i18nKeys() {
  return Object.keys(DICT[BASE]);
}

export function i18nLangs() {
  return Object.keys(DICT);
}

export function i18nBase() {
  return BASE;
}

export function i18nMissing() {
  const out = {};
  for (const code of Object.keys(DICT)) {
    if (code === BASE) continue;
    out[code] = Object.keys(DICT[code]).filter((k) => DICT[BASE][k] == null);
  }
  return out;
}
