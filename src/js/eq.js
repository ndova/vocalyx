import { S } from './state.js';
import { $ } from './dom.js';
import { t } from './i18n/core.js';
import { EQ_FREQS, EQ_PRESETS } from './eq-data.js';
import { applyFxState, ensureGraph, applyKaraokeMakeup } from '../app.js';

const eqBox = $('#eq');
EQ_FREQS.forEach((f, i) => {
  const d = document.createElement('div');
  d.className = 'eq-band';
  d.innerHTML = `<span class="eq-track"></span><input data-eq="${i}" class="wfill" type="range" min="-10" max="10" step="0.5" value="0" /><span class="eq-knob"></span><span>${[10,20,30,40,50,60,70,80,90][i] ?? f}</span>`;
  eqBox.appendChild(d);
});
function paintEqKnobs(){
  document.querySelectorAll('.eq-band').forEach(band=>{
    const input = band.querySelector('input[data-eq]');
    const knob = band.querySelector('.eq-knob');
    const track = band.querySelector('.eq-track');
    if (!input || !knob) return;
    const H = input.clientHeight || 0;
    if (!H) return;
    if (track) {
      track.style.top = input.offsetTop + 'px';
      track.style.height = H + 'px';
    }
    let min = parseFloat(input.min), max = parseFloat(input.max), v = parseFloat(input.value);
    if (!isFinite(min)) min = -10; if (!isFinite(max)) max = 10; if (!isFinite(v)) v = 0;
    const frac = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
    const half = 5;
    const y = (H - half) - frac * Math.max(0, H - half * 2);
    knob.style.top = (input.offsetTop + y - 4) + 'px';
    if (track) {
      if (S.fxEnabled) {
        const pct = Math.max(0, Math.min(100, (1 - y / H) * 100));
        track.style.background = `linear-gradient(to top, var(--accent) 0 ${pct}%, var(--line) ${pct}% 100%)`;
      } else {
        track.style.background = 'var(--line)';
      }
    }
  });
}
paintEqKnobs();
const EQ_STORE_KEY = 'vocalyx_eq_v1';
const LEGACY_PRESET = { Flat:'flat', Rock:'rock', Pop:'pop', Jazz:'jazz', Electro:'electro', HipHop:'hiphop', 'Hip-Hop':'hiphop', Classical:'classical', Vocal:'vocal', Custom:'custom' };
function eqGains(){
  return EQ_FREQS.map((_, i) => {
    const el = document.querySelector(`[data-eq="${i}"]`);
    const v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : 0;
  });
}
export function saveEqState(presetName){
  try { localStorage.setItem(EQ_STORE_KEY, JSON.stringify({ preset: presetName, gains: eqGains() })); } catch {}
}
export function restoreEqState(){
  let s = null;
  try { s = JSON.parse(localStorage.getItem(EQ_STORE_KEY) || 'null'); } catch { s = null; }
  if (s && typeof s.preset === 'string' && LEGACY_PRESET[s.preset]) {
    s.preset = LEGACY_PRESET[s.preset];
    try { localStorage.setItem(EQ_STORE_KEY, JSON.stringify(s)); } catch {}
  }
  if (!s || typeof s !== 'object') return false;
  const gains = Array.isArray(s.gains) && s.gains.length === EQ_FREQS.length ? s.gains : null;
  if (gains) {
    gains.forEach((v, i) => {
      const g = isFinite(parseFloat(v)) ? parseFloat(v) : 0;
      const el = document.querySelector(`[data-eq="${i}"]`);
      if (el) el.value = g;
      if (S.eqNodes[i]) S.eqNodes[i].gain.value = S.fxEnabled ? g : 0;
    });
  }
const preset = typeof s.preset === 'string' ? s.preset : '';
  if (preset && preset !== 'custom' && EQ_PRESETS[preset]) {
    applyPreset(preset);
    return true;
  }
  if (gains) {
    const btn = $('#btnPreset');
    if (btn) btn.textContent = t('eq.custom') + ' ▾';
    document.querySelectorAll('.preset-menu button').forEach(b=>b.classList.remove('active'));
    paintEqKnobs();
    return true;
  }
  return false;
}
function applyPreset(name) {
  const vals = EQ_PRESETS[name];
  if (!vals) return;
  vals.forEach((v,i) => {
    const el = document.querySelector(`[data-eq="${i}"]`);
    if (el) el.value = v;
    if (S.eqNodes[i]) S.eqNodes[i].gain.value = S.fxEnabled ? v : 0;
  });
  document.querySelectorAll('.preset-menu button').forEach(b=>b.classList.toggle('active', b.dataset.preset===name));
  saveEqState(name);
  const btn = $('#btnPreset');
  if (btn) btn.textContent = t('eq.' + name) + ' ▾';
  paintEqKnobs();
}
eqBox.addEventListener('input', (e) => {
  const i = parseInt(e.target.dataset.eq);
  if (S.eqNodes[i]) S.eqNodes[i].gain.value = S.fxEnabled ? parseFloat(e.target.value) : 0;
  const btn = $('#btnPreset');
  if (btn) btn.textContent = t('eq.custom') + ' ▾';
  document.querySelectorAll('.preset-menu button').forEach(b=>b.classList.remove('active'));
  saveEqState('custom');
  paintEqKnobs();
});
window.addEventListener('resize', ()=>{ try { paintEqKnobs(); } catch {} });
$('#vol').oninput = (e) => {
  ensureGraph();
  applyKaraokeMakeup();
};
function paintRangeFill(el){
  if (!el || !el.matches?.('input[type="range"]')) return;
  let min = parseFloat(el.min), max = parseFloat(el.max), v = parseFloat(el.value);
  if (!isFinite(min)) min = 0; if (!isFinite(max)) max = 100; if (!isFinite(v)) v = min;
  const p = max > min ? Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)) : 0;
  el.style.setProperty('--p', p.toFixed(1) + '%');
}
function paintAllRangeFills(){
  document.querySelectorAll('input[type="range"].wfill.hfill').forEach(paintRangeFill);
}
document.addEventListener('input', (e)=>{
  const el = e.target?.closest?.('input[type="range"].wfill.hfill');
  if (el) paintRangeFill(el);
}, true);
paintAllRangeFills();
$('#btnEqToggle').onchange = (e) => {
  S.fxEnabled = !!e.target.checked;
  e.target.classList.toggle('on', S.fxEnabled);
  applyFxState();
};
const btnPreset = $('#btnPreset');
const presetMenu = $('#presetMenu');
if (btnPreset && presetMenu) {
  const ac = document.querySelector('.audio-card');
  const setPresetOpen = (open) => {
    presetMenu.classList.toggle('open', open);
    if (ac) ac.classList.toggle('preset-menu-open', open);
  };
  btnPreset.onclick = (e) => { e.stopPropagation(); setPresetOpen(!presetMenu.classList.contains('open')); };
  document.addEventListener('click', () => setPresetOpen(false));
  presetMenu.onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    applyPreset(b.dataset.preset);
    setPresetOpen(false);
  };
}
restoreEqState();

export { eqBox, paintEqKnobs, EQ_STORE_KEY, eqGains, applyPreset, paintRangeFill, paintAllRangeFills, btnPreset, presetMenu };
