import { S } from './state.js';
import { canvas, ctx, audio } from './dom.js';
import { paintEqKnobs } from './eq.js';
import { t } from './i18n/core.js';

function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, Math.floor(r.width * devicePixelRatio));
  canvas.height = Math.floor(127 * devicePixelRatio);
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

const freqData = new Uint8Array(128);
const BARS = 90;
const vals = new Uint8Array(BARS);
const vizEl = document.getElementById('waveViz');

function drawWave() {
  requestAnimationFrame(drawWave);
  if (!canvas || document.hidden) return;
  if (vizEl && vizEl.classList.contains('viz-hidden')) return;
  const W = canvas.width, H = canvas.height;
  const playing = S.analyser && !audio.paused && audio.src;
  if (playing) {
    S.analyser.getByteFrequencyData(freqData);
    const last = freqData.length - 1;
    for (let j = 0; j < BARS; j++) vals[j] = freqData[Math.round(j * last / (BARS - 1))];
  }
  const n = W < 360 * (window.devicePixelRatio || 1) ? 40 : 64;
  const bw = W / n;
  const half = (n - 1) / 2;
  const ph = Date.now() / 700;
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(i - half) / half;
    const b = Math.floor(Math.pow(d, 0.7) * (BARS - 1));
    const v = playing ? vals[b] : 20 + 40 * Math.abs(Math.sin(b * 0.35 + ph) * Math.cos(b * 0.12 - ph));
    const h = Math.max(4, (v / 255) * H * 0.95 + 4);
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#3b6fe0');
    g.addColorStop(0.5, '#4aa8ff');
    g.addColorStop(1, '#35e0a1');
    ctx.fillStyle = g;
    const x = i * bw + bw * 0.2;
    ctx.fillRect(x, (H - h) / 2, Math.max(1.5, bw * 0.55), h);
  }
}
drawWave();

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
    }
    return;
  }
  if (hidden === already) return;
  if (hidden) {
    viz.classList.add('viz-hidden');
    btn.title = t('btn.showVisualizer');
    S.vizAutoHidden = false;
  } else {
    viz.classList.remove('viz-hidden');
    btn.title = t('btn.hideVisualizer');
    S.vizAutoHidden = false;
    fitCanvas();
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
  if (!hidden) { fitCanvas(); try { paintEqKnobs(); } catch {} }
});

export { fitCanvas, freqData, drawWave, setVizHidden };
