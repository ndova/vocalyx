import { S } from './state.js';
import { canvas, ctx, audio } from './dom.js';
import { paintEqKnobs } from './eq.js';

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
function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, Math.floor(r.width * devicePixelRatio));
  canvas.height = Math.max(40, Math.floor((r.height || 110) * devicePixelRatio));
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
function drawWave() {
  requestAnimationFrame(drawWave);
  const viz = document.getElementById('waveViz');
  if (!canvas || (viz && viz.classList.contains('viz-hidden'))) return;
  const W = canvas.width, H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  let vals = [];
  const playing = !!(S.analyser && !audio.paused && audio.src);
  if (playing) {
    S.analyser.getByteFrequencyData(freqData);
    vals = [...freqData].filter((_, i) => i % 2 === 0).slice(0, 90);
  } else {
    const t = Date.now() / 700;
    vals = Array.from({ length: 90 }, (_, i) => 20 + 40 * Math.abs(Math.sin(i * 0.35 + t) * Math.cos(i * 0.12 - t)));
  }
  let bass = 0;
  for (let i = 0; i < 10; i++) bass += vals[i] || 0;
  bass = Math.max(0, Math.min(1, bass / (10 * 255)));
  const N = W < 360 * dpr ? 40 : 64;
  const bw = W / N;
  const horizon = H * 0.52;
  const maxH = H * 0.46;
  const barW = Math.max(2 * dpr, bw * 0.58);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#2b9bf5');
  g.addColorStop(0.35, '#00d4ff');
  g.addColorStop(0.7, '#1ee39a');
  g.addColorStop(1, '#3ef08a');
  ctx.fillStyle = g;
  const hs = [];
  for (let i = 0; i < N; i++) {
    const d = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);
    const v = vals[Math.min(vals.length - 1, Math.floor(Math.pow(d, 0.7) * (vals.length - 1)))] || 0;
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
  ctx.shadowColor = '#00d4ff';
  ctx.shadowBlur = (10 + bass * 14) * dpr;
  ctx.fillStyle = `rgba(0,196,235,${0.55 + bass * 0.4})`;
  ctx.fillRect(0, horizon - dpr, W, 2 * dpr);
  ctx.restore();
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
      btn.title = 'Show Visualizer';
      S.vizAutoHidden = true;
      setTimeout(() => syncWaveHeight(), 480);
    }
    return;
  }
  if (hidden === already) return;
  if (hidden) {
    viz.classList.add('viz-hidden');
    btn.title = 'Show Visualizer';
    S.vizAutoHidden = false;
    setTimeout(() => syncWaveHeight(), 480);
  } else {
    viz.classList.remove('viz-hidden');
    btn.title = 'Hide Visualizer';
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
  btn.title = hidden ? 'Show Equalizer' : 'Hide Equalizer';
  S.eqAnimating = true;
  setTimeout(() => {
    S.eqAnimating = false;
    if (!hidden) { fitCanvas(); syncWaveHeight(); try { paintEqKnobs(); } catch {} }
  }, 480);
});

export { syncWaveHeight, fitCanvas, freqData, drawWave, setVizHidden };
