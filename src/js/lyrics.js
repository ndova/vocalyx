import { S } from './state.js';
import { t } from './i18n/core.js';
import { audio, $, lyricsEl } from './dom.js';
import { parseLRC, defaultLyrics, escHtml, isSynced } from './lrc.js';
import { paintRangeFill } from './eq.js';
import { invokeTauri, isTauri, play, renderTracks } from '../app.js';

async function fetchFromLrclib(artist, title, duration) {
  const base = 'https://lrclib.net/api';
  const headers = { 'User-Agent': 'VocaLyx/0.1.0' };
  try {
    let url = `${base}/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    if (duration && isFinite(duration) && duration > 0) url += `&duration=${Math.round(duration)}`;
    const r = await fetch(url, { headers });
    if (r.ok) {
      const j = await r.json();
      if (j && (j.syncedLyrics || j.plainLyrics)) return j.syncedLyrics || j.plainLyrics;
    }
  } catch {}
  try {
    let url = `${base}/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    const r = await fetch(url, { headers });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        const best = arr.find(x => x.syncedLyrics) || arr[0];
        return best.syncedLyrics || best.plainLyrics || null;
      }
    }
  } catch {}
  try {
    let url = `${base}/search?q=${encodeURIComponent(artist + ' ' + title)}`;
    const r = await fetch(url, { headers });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        const best = arr.find(x => x.syncedLyrics) || arr[0];
        return best.syncedLyrics || best.plainLyrics || null;
      }
    }
  } catch {}
  return null;
}

async function fetchAndSaveLrclib(track) {
  if (!isTauri() || !track.path) return false;
  if (track._lrclibTried) return false;
  track._lrclibTried = true;
  const artist = (track.artist && track.artist !== 'Unknown') ? track.artist : '';
  const title = track.title || track.name || '';
  if (!title) return false;
  const duration = audio.duration && isFinite(audio.duration) ? audio.duration : null;
  const artistQuery = artist || '';
  const lrcText = await fetchFromLrclib(artistQuery, title, duration) || await fetchFromLrclib('', title, duration);
  if (!lrcText) { return false; }
  try {
    const savePath = await invokeTauri('save_lyric', { trackPath: track.path, lrcText });
    track.lyric_path = savePath;
    renderTracks($('#globalSearch')?.value || '');
    S.lyricLines = parseLRC(lrcText);
    renderLyrics();
    return true;
  } catch {
    try {
      const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
      const sep = track.path.includes('\\') ? '\\' : '/';
      const lastSep = track.path.lastIndexOf(sep);
      const dir = lastSep >= 0 ? track.path.slice(0, lastSep) : '.';
      const stem = track.name || title;
      const lyricsDir = dir + sep + 'Lyrics';
      try { await mkdir(lyricsDir, { recursive: true }); } catch {}
      const savePath = lyricsDir + sep + stem + '.lrc';
      await writeTextFile(savePath, lrcText);
      track.lyric_path = savePath;
      renderTracks($('#globalSearch')?.value || '');
      S.lyricLines = parseLRC(lrcText);
      renderLyrics();
      return true;
    } catch {
      S.lyricLines = parseLRC(lrcText);
      renderLyrics();
      return true;
    }
  }
}

let _lyrRows = null;
let _lyrRowsFor = -1;
let _lyrOn = -1;

function renderLyrics() {
  _lyrRows = null; _lyrRowsFor = -1; _lyrOn = -1;
  if (!S.lyricLines.length) {
    lyricsEl.innerHTML = `<div style="color:var(--muted);padding:20px">${t('lyr.noLyrics')}</div>`;
    syncLyricOffsetUI();
    return;
  }
  const synced = isSynced(S.lyricLines);
  const rows = S.lyricLines.map((l, i) => {
    const t = l.t;
    const txt = escHtml(l.d != null ? l.d : l.x);
    const clickable = synced && typeof t === 'number' && Number.isFinite(t) && t >= 0 && t < 99999;
    return clickable ? `<div class="lyr-line" data-lyr="${i}">${txt}</div>` : `<div>${txt}</div>`;
  }).join('');
  lyricsEl.innerHTML = synced ? `<div class="lyr-spacer"></div>${rows}<div class="lyr-spacer"></div>` : rows;
  syncLyricOffsetUI();
  if (synced && S.lyricLines[0] && S.lyricLines[0].t === 0) {
    const first = lyricsEl.querySelector('[data-lyr="0"]');
    if (first) first.classList.add('on');
  }
}
function capLimit() {
  const d = audio && audio.duration ? audio.duration : 0;
  const c = audio && audio.dataset ? parseFloat(audio.dataset.previewCap) : 0;
  return { d, cap: c > 0 ? c : 0 };
}
function seekLyric(t) {
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t >= 99999) return false;
  const { d, cap } = capLimit();
  if (!d) return false;
  try {
    let pos = Math.max(0, t - S.lyricOffsetMs / 1000 + 0.05);
    if (cap) pos = Math.min(pos, cap);
    audio.currentTime = Math.min(pos, Math.max(0, d - 0.25));
    if (audio.paused) play();
    return true;
  } catch { return false; }
}
lyricsEl.addEventListener('click', (e)=>{
  const el = e.target.closest('[data-lyr]');
  if (!el || !lyricsEl.contains(el)) return;
  const i = parseInt(el.dataset.lyr, 10);
  const L = S.lyricLines[i];
  if (!L) return;
  seekLyric(L.t);
});
function lyricRows() {
  const n = S.lyricLines.length;
  if (_lyrRows && _lyrRowsFor === n) return _lyrRows;
  const off = lyricsEl.firstElementChild && lyricsEl.firstElementChild.classList.contains('lyr-spacer') ? 1 : 0;
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(lyricsEl.children[off + i] || null);
  _lyrRows = rows;
  _lyrRowsFor = n;
  _lyrOn = -1;
  return rows;
}
function setLyricState(d, i, on) {
  if (!d) return;
  const base = d.hasAttribute('data-lyr') ? 'lyr-line' : '';
  d.className = (base ? base + ' ' : '') + (i === on ? 'on' : (i < on ? 'past' : ''));
}

function syncLyrics(cur) {
  if (!isSynced(S.lyricLines)) { _lyrOn = -1; return; }
  const adj = cur + S.lyricOffsetMs / 1000;
  let on = 0;
  for (let i = 0; i < S.lyricLines.length; i++) {
    if (adj + 0.15 >= S.lyricLines[i].t) on = i;
    else break;
  }
  const rows = lyricRows();
  if (!rows.length) return;

  const prev = _lyrOn;
  if (prev === on) return;
  _lyrOn = on;

  const lo = Math.min(prev < 0 ? on : prev, on);
  const hi = Math.max(prev < 0 ? on : prev, on);
  for (let i = lo; i <= hi; i++) setLyricState(rows[i], i, on);

  const active = rows[on];
  if (active && active.hasAttribute('data-lyr')) {
    try {
      const cRect = lyricsEl.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const delta = (aRect.top - cRect.top) - lyricsEl.clientHeight / 2 + aRect.height / 2;
      if (Math.abs(delta) > 4) {
        lyricsEl.scrollTo({ top: lyricsEl.scrollTop + delta, behavior: audio.paused ? 'auto' : 'smooth' });
      }
    } catch {}
  }
}
const LYROFF_KEY = 'vocalyx_lyricOffset_v1';
const LYROFF_UI_KEY = 'vocalyx_lyricOffsetUI_v2';
const LYROFF_UI_OLD_KEY = 'vocalyx_lyricOffsetUI_v1';
function migrateLyricOffsetUI(){   // semantik v1 dibalik tanpa pindah nilai, jadi nilai lama harus dibalik
  let old = null;
  try { old = localStorage.getItem(LYROFF_UI_OLD_KEY); } catch {}
  if (old === null) return;
  const shown = old === '0';   // v1: '1' = collapsed, jadi dibalik -> '1' = tampil
  try {
    localStorage.setItem(LYROFF_UI_KEY, shown ? '1' : '0');
    localStorage.removeItem(LYROFF_UI_OLD_KEY);
  } catch {}
}
migrateLyricOffsetUI();
function isLyricOffsetShown(){ return readFlag(LYROFF_UI_KEY); }   // '1' = panel tampil, default tersembunyi
function readFlag(key){
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function getLyricOffsets(){ try { return JSON.parse(localStorage.getItem(LYROFF_KEY) || '{}'); } catch { return {}; } }
function saveLyricOffsets(m){ try { localStorage.setItem(LYROFF_KEY, JSON.stringify(m)); } catch {} }
function migrateLyricOffset(oldP, newP){
  if (!oldP || !newP || oldP === newP) return;
  try {
    const m = getLyricOffsets();
    if (m[oldP] != null) { m[newP] = m[oldP]; delete m[oldP]; saveLyricOffsets(m); }
  } catch {}
}
function pruneLyricOffset(p){
  try { const m = getLyricOffsets(); if (m[p] != null) { delete m[p]; saveLyricOffsets(m); } } catch {}
}
function loadLyricOffset(){
  const p = S.tracks[S.idx]?.path || '';
  S.lyricOffsetMs = p ? (getLyricOffsets()[p] || 0) : 0;
  syncLyricOffsetUI();
}
function setLyricOffset(ms, save = true){
  S.lyricOffsetMs = Math.max(-300000, Math.min(300000, Math.round(ms) || 0));
  const p = S.tracks[S.idx]?.path || '';
  if (save && p) {
    const m = getLyricOffsets();
    if (S.lyricOffsetMs) m[p] = S.lyricOffsetMs;
    else delete m[p];
    saveLyricOffsets(m);
  }
  syncLyricOffsetUI();
}
function syncLyricOffsetUI(){
  const wrap = document.getElementById('lyrOffsetWrap');
  const synced = isSynced(S.lyricLines);
  if (wrap) wrap.style.display = synced ? 'block' : 'none';
  const body = document.getElementById('lyrOffBody');
  const open = isLyricOffsetShown();   // synced = ada lirik sinkron; open = user menekan tombol jam
  if (body) {
    body.style.display = synced && open ? 'block' : 'none';
    body.classList.toggle('lyr-hidden', synced && !open);
  }
  const toggle = document.getElementById('lyrOffToggle');
  if (toggle) {
    toggle.style.display = synced ? 'inline-flex' : 'none';
    toggle.title = open ? t('lyr.hideOffsetCtl') : t('lyr.showOffsetCtl');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  const badge = document.getElementById('lyrOffBadge');
  if (badge) {
    const v = S.lyricOffsetMs;
    badge.textContent = (v > 0 ? '+' : '') + v + 'ms';
    badge.title = v === 0 ? t('lyr.onBeat') : (v > 0 ? t('lyr.early') : t('lyr.late'));
    badge.style.display = open ? '' : 'none';   // badge ikut disembunyikan sampai panel dibuka
  }
  const slider = document.getElementById('lyrOffSlider');
  if (slider && document.activeElement !== slider) slider.value = String(Math.max(-10000, Math.min(10000, S.lyricOffsetMs)));
  if (slider) paintRangeFill(slider);
  const reset = document.getElementById('lyrOffReset');
  if (reset) reset.disabled = S.lyricOffsetMs === 0;
}
document.querySelectorAll('[data-lyr-off]').forEach(b=>{
  b.addEventListener('click', ()=>{
    const d = parseInt(b.dataset.lyrOff, 10);
    if (!isFinite(d)) return;
    setLyricOffset(d === 0 ? 0 : S.lyricOffsetMs + d);
  });
});
document.getElementById('lyrOffSlider')?.addEventListener('input', (e)=>{
  setLyricOffset(parseInt(e.target.value, 10) || 0);
});
document.getElementById('lyrOffToggle')?.addEventListener('click', ()=>{
  try { localStorage.setItem(LYROFF_UI_KEY, isLyricOffsetShown() ? '0' : '1'); } catch {}
  syncLyricOffsetUI();
});

export { fetchFromLrclib, fetchAndSaveLrclib, renderLyrics, syncLyrics, seekLyric, capLimit, LYROFF_KEY, LYROFF_UI_KEY, LYROFF_UI_OLD_KEY, getLyricOffsets, saveLyricOffsets, migrateLyricOffset, migrateLyricOffsetUI, pruneLyricOffset, loadLyricOffset, setLyricOffset, syncLyricOffsetUI };
