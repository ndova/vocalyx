import { t } from './i18n/core.js';
import { S } from './state.js';
import { audio } from './dom.js';
import { invokeTauri, isTauri, play, pause, showToast } from '../app.js';
import { renderLyrics, setLyricOffset, seekLyric, capLimit } from './lyrics.js';
import { paintRangeFill } from './eq.js';
import { fmt } from './format.js';
import { ICON } from './icons.js';
import { onLangChange } from './i18n/core.js';
import {
  parseLRCForEdit, lyricLinesToLrc, formatStamp, escHtml, isSynced,
  setLrcLineTime, nudgeLrcLine, nudgeLrcFromIndex, resetLrcLine,
  setLrcLineText, removeLrcLine, insertLrcLineAfter, applyOffsetToAllLines,
} from './lrc.js';

const PLAIN_T = 99999;
const E = { open: false, raw: '', base: '', lines: [], dirty: false, saving: false, sel: 0, active: -1, raf: 0, editing: -1, path: '', seeking: false };

const el = (id) => document.getElementById(id);
const isTimed = (l) => typeof l.t === 'number' && Number.isFinite(l.t) && l.t < PLAIN_T;

async function readRaw(t) {
  if (t.lyric_path) {
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      return { text: await readTextFile(t.lyric_path), path: t.lyric_path };
    } catch {}
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const r = await fetch(convertFileSrc(t.lyric_path));
      if (r.ok) return { text: await r.text(), path: t.lyric_path };
    } catch {}
  }
  return { text: lyricLinesToLrc(S.lyricLines), path: t.lyric_path || '' };
}

async function writeRaw(text) {
  const tk = S.tracks[S.idx];
  if (!tk) return '';
  if (E.path) {
    try {
      const p = await invokeTauri('write_lyric_to', { targetPath: E.path, lrcText: text });
      if (typeof p === 'string' && p) return p;
    } catch {}
  }
  try {
    const p = await invokeTauri('save_lyric', { trackPath: tk.path, lrcText: text });
    if (typeof p === 'string' && p) return p;
  } catch {}
  return '';
}

function toolBtn(act, d, title, text, cls) {
  const da = d == null ? '' : ` data-d="${d}"`;
  const cc = cls ? ` ${cls}` : '';
  return `<button type="button" class="lyr-edit-btn${cc}" data-act="${act}"${da} title="${title}">${text}</button>`;
}

function toolsHtml(i) {
  return toolBtn('nudge', -500, t('le.tipNudgeBack05'), '&minus;0.5')
    + toolBtn('nudge', -200, t('le.tipNudgeBack02'), '&minus;0.2')
    + toolBtn('now', null, t('le.tipNow'), '&#9679; now', 'is-now')
    + toolBtn('nudge', 200, t('le.tipNudgeFwd02'), '+0.2')
    + toolBtn('nudge', 500, t('le.tipNudgeFwd05'), '+0.5')
    + toolBtn('zero', null, t('le.tipZero'), '00:00', 'is-zero')
    + toolBtn('tail', -500, t('le.tipTailBack'), '&laquo;0.5', 'is-tail')
    + toolBtn('tail', 500, t('le.tipTailFwd'), '0.5&raquo;', 'is-tail')
    + toolBtn('add', null, t('le.tipAdd'), t('le.addLineBtn'), 'is-add')
    + toolBtn('edit', null, t('le.tipEdit'), '&#9998;', 'is-edit')
    + toolBtn('del', null, t('le.tipDel'), '&#128465;', 'is-del');
}

function rowHtml(l, i) {
  const timed = isTimed(l);
  const ts = timed ? formatStamp(l.t) : '--:--';
  const sel = i === E.sel ? ' is-sel' : '';
  const now = i === E.active ? ' is-now-line' : '';
  const unt = timed ? '' : ' is-untimed';
  const tsBtn = timed
    ? `<button type="button" class="lyr-edit-ts" data-seek="${i}" title="${escHtml(t('le.seekFrom', { ts }))}">${ts}</button>`
    : `<button type="button" class="lyr-edit-ts" disabled title="${escHtml(t('le.noTimeYet'))}">${ts}</button>`;
  return `<div class="lyr-edit-row${sel}${now}${unt}" data-i="${i}">`
    + tsBtn
    + `<span class="lyr-edit-txt" data-txt="${i}">${escHtml(l.d != null ? l.d : l.x)}</span>`
    + `<span class="lyr-edit-tools">${toolsHtml(i)}</span>`
    + `</div>`;
}

function render() {
  const list = el('lyrEditList');
  if (!list) return;
  list.innerHTML = E.lines.length
    ? E.lines.map(rowHtml).join('')
    : `<div class="lyr-edit-empty">${escHtml(t('le.emptyEditor'))}</div>`;
  markDirty();
}

function markDirty() {
  const b = el('lyrEditSave');
  if (b) b.textContent = E.saving ? t('le.saving') : (E.dirty ? t('le.saveStar') : t('le.save'));
  const c = el('lyrEditPath');
  if (c) c.textContent = E.path ? E.path : t('le.noLrc');
  const o = el('lyrEditOffset');
  if (o) o.textContent = (S.lyricOffsetMs > 0 ? '+' : '') + S.lyricOffsetMs + 'ms';
  const ob = el('lyrEditApplyOff');
  if (ob) ob.disabled = !S.lyricOffsetMs;
}

function paintPlayBtn() {
  const b = el('lyrEditPlay');
  if (!b) return;
  const playing = !!(audio && !audio.paused && !audio.ended);
  b.innerHTML = playing ? ICON.pause : ICON.play;
}

function paintSeek() {
  const bar = el('lyrEditSeek');
  if (!bar) return;
  const cur = el('lyrEditClock');
  const left = el('lyrEditLeft');
  const { d, cap } = capLimit();
  if (!d) {
    bar.disabled = true;
    if (cur) cur.textContent = fmt(0);
    if (left) left.textContent = '-' + fmt(0);
    return;
  }
  bar.disabled = false;
  if (bar.max !== String(d)) bar.max = String(d);
  let pos = audio.currentTime || 0;
  if (cap) pos = Math.min(pos, cap);
  if (!E.seeking) {
    bar.value = pos.toFixed(2);
    paintRangeFill(bar);
  }
  if (cur) cur.textContent = fmt(pos);
  if (left) left.textContent = '-' + fmt(Math.max(0, d - pos));
}

function onSeekInput() {
  const bar = el('lyrEditSeek');
  if (!bar) return;
  const { d, cap } = capLimit();
  if (!d) return;
  let pos = parseFloat(bar.value);
  if (!isFinite(pos)) return;
  if (cap) pos = Math.min(pos, cap);
  try { audio.currentTime = Math.min(Math.max(0, pos), d); } catch {}
}

function bindSeek() {
  const bar = el('lyrEditSeek');
  if (!bar) return;
  let guard = 0;
  const stop = () => {
    E.seeking = false;
    if (guard) { clearTimeout(guard); guard = 0; }
  };
  bar.addEventListener('input', onSeekInput);
  bar.addEventListener('pointerdown', () => {
    E.seeking = true;
    if (guard) clearTimeout(guard);
    guard = setTimeout(stop, 1500);
  });
  bar.addEventListener('pointerup', stop);
  bar.addEventListener('pointercancel', stop);
  bar.addEventListener('keydown', () => { E.seeking = true; });
  bar.addEventListener('keyup', stop);
  bar.addEventListener('blur', stop);
  window.addEventListener('pointerup', stop);
}

function highlight() {
  const now = (audio ? (audio.currentTime || 0) : 0) + S.lyricOffsetMs / 1000;
  let best = -1, bestT = -Infinity;
  for (let i = 0; i < E.lines.length; i++) {
    const t = E.lines[i].t;
    if (typeof t !== 'number' || !Number.isFinite(t) || t >= PLAIN_T) continue;
    if (t <= now + 0.08 && t > bestT) { bestT = t; best = i; }
  }
  if (best === E.active) return;
  E.active = best;
  const list = el('lyrEditList');
  if (!list) return;
  const old = list.querySelector('.is-now-line');
  if (old) old.classList.remove('is-now-line');
  if (best >= 0) {
    const r = list.querySelector('[data-i="' + best + '"]');
    if (r) r.classList.add('is-now-line');
  }
}

function loop() {
  if (!E.open) return;
  paintSeek();
  highlight();
  E.raf = requestAnimationFrame(loop);
}

function stopLoop() {
  if (E.raf) { try { cancelAnimationFrame(E.raf); } catch {} E.raf = 0; }
}

function apply(fn) {
  const next = fn(E.raw);
  if (next === E.raw) return false;
  E.raw = next;
  E.lines = parseLRCForEdit(E.raw);
  E.dirty = true;
  render();
  return true;
}

function commitToPlayer() {
  S.lyricLines = parseLRCForEdit(E.raw).sort((a, b) => (a.t || 0) - (b.t || 0));
  renderLyrics();
}

function stampNow(i) {
  const t = audio ? Math.max(0, audio.currentTime || 0) : 0;
  if (apply(r => setLrcLineTime(r, i, t))) {
    S.lyricLines = parseLRCForEdit(E.raw).sort((a, b) => (a.t || 0) - (b.t || 0));
    renderLyrics();
  }
}

function startEdit(i) {
  if (E.editing === i) return;
  cancelEdit();
  const host = el('lyrEditList');
  if (!host) return;
  const cell = host.querySelector('[data-txt="' + i + '"]');
  const l = E.lines[i];
  if (!cell || !l) return;
  E.editing = i;
  const inp = document.createElement('input');
  inp.className = 'lyr-edit-input';
  inp.type = 'text';
  inp.value = l.d != null ? l.d : l.x;
  inp.setAttribute('data-edit', String(i));
  cell.textContent = '';
  cell.appendChild(inp);
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  inp.addEventListener('blur', () => finishEdit(i));
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finishEdit(i); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
  });
}

function cancelEdit() {
  if (E.editing < 0) return;
  E.editing = -1;
  render();
}

function finishEdit(i) {
  if (E.editing !== i) return;
  E.editing = -1;
  const inp = document.querySelector('[data-edit="' + i + '"]');
  const v = inp ? inp.value : '';
  apply(r => setLrcLineText(r, i, v));
  commitToPlayer();
}

function onListClick(ev) {
  const seekBtn = ev.target.closest('[data-seek]');
  if (seekBtn) {
    ev.stopPropagation();
    const i = parseInt(seekBtn.dataset.seek, 10);
    E.sel = i;
    seekLyric(E.lines[i] ? E.lines[i].t : NaN);
    render();
    return;
  }
  const btn = ev.target.closest('[data-act]');
  const row = ev.target.closest('[data-i]');
  if (btn && row) {
    ev.stopPropagation();
    const i = parseInt(row.dataset.i, 10);
    const act = btn.dataset.act;
    const d = parseInt(btn.dataset.d, 10) || 0;
    E.sel = i;
    if (act === 'nudge') { apply(r => nudgeLrcLine(r, i, d)); commitToPlayer(); }
    else if (act === 'now') stampNow(i);
    else if (act === 'zero') { apply(r => resetLrcLine(r, i)); commitToPlayer(); }
    else if (act === 'tail') { apply(r => nudgeLrcFromIndex(r, i, d)); commitToPlayer(); }
    else if (act === 'add') {
      const at = isTimed(E.lines[i]) ? E.lines[i].t + 2 : (audio ? Math.max(0, audio.currentTime || 0) + 2 : 0);
      apply(r => insertLrcLineAfter(r, i, at, t('le.newLine')));
      commitToPlayer();
    } else if (act === 'edit') startEdit(i);
    else if (act === 'del') { apply(r => removeLrcLine(r, i)); E.sel = Math.max(0, i - 1); render(); commitToPlayer(); }
    return;
  }
  const cell = ev.target.closest('[data-txt]');
  if (cell) { E.sel = parseInt(cell.dataset.txt, 10); startEdit(E.sel); return; }
  if (row) { E.sel = parseInt(row.dataset.i, 10); render(); }
}

async function doSave() {
  if (E.saving || !E.dirty) return;
  E.saving = true;
  markDirty();
  const btn = el('lyrEditSave');
  if (btn) btn.disabled = true;
  const tk = S.tracks[S.idx];
  try {
    if (!tk || !isTauri() || !tk.path) {
      showToast(t('le.desktopOnly'), 3000);
      return;
    }
    const p = await writeRaw(E.raw);
    if (!p) { showToast(t('le.saveFail'), 3000); return; }
    E.path = p;
    tk.lyric_path = p;
    E.dirty = false;
    E.base = E.raw;
    commitToPlayer();
    showToast(t('le.savedTo', { n: p.split(/[\\/]/).pop() }), 2500);
    render();
  } catch {
    E.saving = false;
    showToast(t('le.saveFail'), 3000);
    markDirty();
  } finally {
    E.saving = false;
    const b = el('lyrEditSave');
    if (b) b.disabled = false;
    markDirty();
  }
}

function revert() {
  E.raw = E.base;
  E.lines = parseLRCForEdit(E.raw);
  E.dirty = false;
  commitToPlayer();
  render();
}

function applyOffsetAll() {
  if (!S.lyricOffsetMs) return;
  const delta = S.lyricOffsetMs;
  apply(r => applyOffsetToAllLines(r, delta));
  setLyricOffset(0);
  commitToPlayer();
  showToast(t('le.offsetApplied', { n: (delta > 0 ? '+' : '') + delta }), 2500);
}

export function openLyricEditor() {
  const tk = S.tracks[S.idx];
  if (!tk) { showToast(t('le.pickFirst'), 2000); return; }
  if (!isSynced(S.lyricLines) && S.lyricLines.length <= 1) { showToast(t('le.noLyrics'), 2500); return; }
  E.open = true;
  E.sel = 0;
  E.active = -1;
  E.editing = -1;
  el('lyrEditTrack').textContent = (tk.artist ? tk.artist + ' — ' : '') + (tk.title || tk.name || '');
  el('lyrEditTrack').title = tk.path || '';
  const list = el('lyrEditList');
  if (list) list.innerHTML = `<div class="lyr-edit-empty">${escHtml(t('le.loading'))}</div>`;
  el('lyrEditModal').classList.add('is-open');
  el('lyrEditModal').setAttribute('aria-hidden', 'false');
  const m = el('lyrEditModal');
  m.style.display = 'flex';
  paintPlayBtn();
  stopLoop();
  readRaw(tk).then(r => {
    if (!E.open) return;
    E.raw = r.text;
    E.base = r.text;
    E.path = r.path;
    E.dirty = false;
    E.lines = parseLRCForEdit(E.raw);
    render();
    E.seeking = false;
    stopLoop();
    paintSeek();
    E.raf = requestAnimationFrame(loop);
  });
}

export function isLyricEditorOpen() {
  return !!E.open;
}

export function closeLyricEditor() {
  if (!E.open) return;
  E.open = false;
  stopLoop();
  cancelEdit();
  const m = el('lyrEditModal');
  if (m) { m.classList.remove('is-open'); m.setAttribute('aria-hidden', 'true'); m.style.display = 'none'; }
  if (E.dirty) revert();
}

function onKey(ev) {
  if (!E.open) return;
  if (ev.key === 'Escape') { ev.preventDefault(); closeLyricEditor(); return; }
  if (E.editing >= 0) return;
  const target = ev.target;
  const focused = target && target.closest ? target.closest('#lyrEditModal button, #lyrEditModal input') : null;
  if (focused && (ev.key === ' ' || ev.code === 'Space' || ev.key === 'Enter')) return;
  if (ev.key === ' ' || ev.code === 'Space') { ev.preventDefault(); if (audio && audio.paused) play(); else pause(); return; }
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); doSave(); return; }
  if (ev.key === 'ArrowDown') { ev.preventDefault(); E.sel = Math.min(E.lines.length - 1, E.sel + 1); render(); return; }
  if (ev.key === 'ArrowUp') { ev.preventDefault(); E.sel = Math.max(0, E.sel - 1); render(); return; }
  if (ev.key === 'Enter') { ev.preventDefault(); stampNow(E.sel); }
}

function init() {
  el('lyrEditOpen')?.addEventListener('click', openLyricEditor);
  el('lyrEditClose')?.addEventListener('click', closeLyricEditor);
  el('lyrEditBackdrop')?.addEventListener('click', closeLyricEditor);
  el('lyrEditSave')?.addEventListener('click', doSave);
  el('lyrEditRevert')?.addEventListener('click', revert);
  el('lyrEditApplyOff')?.addEventListener('click', applyOffsetAll);
  el('lyrEditPlay')?.addEventListener('click', () => { if (audio && audio.paused) play(); else pause(); paintPlayBtn(); });
  el('lyrEditList')?.addEventListener('click', onListClick);
  bindSeek();
  if (audio) {
    audio.addEventListener('play', paintPlayBtn);
    audio.addEventListener('pause', paintPlayBtn);
    audio.addEventListener('ended', paintPlayBtn);
  }
  onLangChange(() => { if (E.open) render(); });
  document.addEventListener('keydown', onKey);
}

init();
