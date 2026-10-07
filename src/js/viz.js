import { S } from './state.js';
import { canvas, ctx, audio } from './dom.js';
import { paintEqKnobs } from './eq.js';
import { t } from './i18n/core.js';

function syncWaveHeight(){
  try {
    if (S.eqAnimating) return;
    const viz = document.getElementById('waveViz');
    if (viz && viz.classList.contains('viz-hidden')) return;
    const ac = document.querySelector('.audio-card');
    if (ac && ac.classList.contains('eq-hidden')) return;
    const wc = document.querySelector('.wave-card');
    if (!ac || !wc || !canvas || !ac.offsetHeight) return;
    const chrome = wc.offsetHeight - canvas.offsetHeight;
    const target = Math.max(60, ac.offsetHeight - chrome);
    if (Math.abs(canvas.offsetHeight - target) > 1) {
      canvas.style.height = target + 'px';
      fitCanvas();
    }
  } catch {}
}
let gradW = -1, grad = null;
let hgradW = -1, hgrad = null;
let idleDirty = true;

function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, Math.floor(r.width * devicePixelRatio));
  canvas.height = Math.max(40, Math.floor((r.height || 110) * devicePixelRatio));
  grad = null; gradW = -1;
  hgrad = null; hgradW = -1;
}
window.addEventListener('resize', ()=>{ syncWaveHeight(); });
fitCanvas();
syncWaveHeight();
try {
  const _ro = new ResizeObserver(()=>{ syncWaveHeight(); });
  const _ac0 = document.querySelector('.audio-card');
  if (_ac0) _ro.observe(_ac0);
} catch {}

const freqData = new Uint8Array(128);
const BARS = 90;
const vals = new Uint8Array(BARS);
const vizEl = document.getElementById('waveViz');

function buildGradient(W) {
  if (grad && gradW === W) return grad;
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#2b9bf5');
  g.addColorStop(0.35, '#00d4ff');
  g.addColorStop(0.7, '#1ee39a');
  g.addColorStop(1, '#3ef08a');
  grad = g; gradW = W;
  return g;
}

function buildHorizonGradient(W) {
  if (hgrad && hgradW === W) return hgrad;
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(43,155,245,0)');
  g.addColorStop(0.5, 'rgba(0,212,255,1)');
  g.addColorStop(1, 'rgba(62,240,138,0)');
  hgrad = g; hgradW = W;
  return g;
}

function paintIdle() {
  const W = canvas.width, H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const lg = ctx.createLinearGradient(0, 0, W, 0);
  lg.addColorStop(0, 'rgba(43,155,245,0)');
  lg.addColorStop(0.5, 'rgba(0,212,255,0.45)');
  lg.addColorStop(1, 'rgba(62,240,138,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, H * 0.52 - dpr, W, 2 * dpr);
  idleDirty = false;
}

function drawWave() {
  requestAnimationFrame(drawWave);
  if (!canvas) return;
  if (document.hidden) { idleDirty = true; return; }
  if (vizEl && vizEl.classList.contains('viz-hidden')) { idleDirty = true; return; }
  if (!canvas.offsetParent) return;
  if (!S.analyser || audio.paused || !audio.src) {
    if (idleDirty) { try { paintIdle(); } catch {} }
    return;
  }

  const W = canvas.width, H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);

  S.analyser.getByteFrequencyData(freqData);
  for (let i = 0; i < BARS; i++) vals[i] = freqData[Math.min(freqData.length - 1, i * 2)];

  let bass = 0;
  for (let i = 0; i < 10; i++) bass += vals[i];
  bass = Math.max(0, Math.min(1, bass / (10 * 255)));

  const N = W < 360 * dpr ? 40 : 64;
  const bw = W / N;
  const horizon = H * 0.52;
  const maxH = H * 0.46;
  const barW = Math.max(2 * dpr, bw * 0.58);
  ctx.fillStyle = buildGradient(W);
  const hs = [];
  for (let i = 0; i < N; i++) {
    const d = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);
    const v = vals[Math.min(BARS - 1, Math.floor(Math.pow(d, 0.7) * (BARS - 1)))] || 0;
    const h = Math.max(2 * dpr, (v / 255) * maxH);
    const x = i * bw + (bw - barW) / 2;
    hs.push(h);
    ctx.fillRect(x, horizon - h, barW, h);
  }
  ctx.save();
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < N; i++) {
    const x = i * bw + (bw - barW) / 2;
    ctx.fillRect(x, horizon, barW, hs[i] * 0.8);
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.6 + bass * 0.4;
  ctx.fillStyle = buildHorizonGradient(W);
  ctx.fillRect(0, horizon - dpr, W, 2 * dpr);
  ctx.restore();
}
drawWave();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  try { gradW = -1; grad = null; hgradW = -1; hgrad = null; fitCanvas(); } catch {}
});

function setVizHidden(hidden, opts = {}) {
  const btn = document.getElementById('btnHideViz');
  const viz = document.getElementById('waveViz');
  if (!btn || !viz || !canvas) return;
  const already = viz.classList.contains('viz-hidden');
  if (opts.auto) {
    if (hidden && !already) {
      viz.classList.add('viz-hidden');
      btn.title = t('btn.showVisualizer');
      S.vizAutoHidden = true;
      setTimeout(() => syncWaveHeight(), 480);
    }
    return;
  }
  if (hidden === already) return;
  idleDirty = true; gradW = -1; grad = null; hgradW = -1; hgrad = null;
  if (hidden) {
    viz.classList.add('viz-hidden');
    btn.title = t('btn.showVisualizer');
    S.vizAutoHidden = false;
    setTimeout(() => syncWaveHeight(), 480);
  } else {
    viz.classList.remove('viz-hidden');
    btn.title = t('btn.hideVisualizer');
    S.vizAutoHidden = false;
    setTimeout(() => { fitCanvas(); syncWaveHeight(); }, 480);
  }
}
document.getElementById('btnHideViz')?.addEventListener('click', () => {
  const viz = document.getElementById('waveViz');
  if (!viz) return;
  setVizHidden(!viz.classList.contains('viz-hidden'));
});

document.getElementById('btnHideEq')?.addEventListener('click', () => {
  const btn = document.getElementById('btnHideEq');
  const ac = document.querySelector('.audio-card');
  if (!btn || !ac) return;
  const hidden = ac.classList.toggle('eq-hidden');
  btn.title = hidden ? t('btn.showEqualizer') : t('btn.hideEqualizer');
  S.eqAnimating = true;
  setTimeout(() => {
    S.eqAnimating = false;
    if (!hidden) { gradW = -1; grad = null; hgradW = -1; hgrad = null; idleDirty = true; fitCanvas(); syncWaveHeight(); try { paintEqKnobs(); } catch {} }
  }, 480);
});

export { syncWaveHeight, fitCanvas, freqData, drawWave, setVizHidden };
