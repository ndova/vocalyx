import { S } from './state.js';
import { audio, $ } from './dom.js';
import { fmt } from './format.js';
import { applyEnhanceState, applyKaraokeMakeup, fadeOutput, renderTracks, syncKaraokeBtn } from '../app.js';

const SWITCH_FADE_OUT = 90;
const SWITCH_FADE_IN = 160;
const SWITCH_MAX_WAIT = 900;
const SWITCH_SEEK_RECHECK = 0.05;
const SWITCH_WARM_TTL = 20000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function fadeAudioVolume(target, ms = 150) {
  return new Promise(res => {
    if (typeof S._volFadeRes === 'function') { try { S._volFadeRes(); } catch {} }
    try { clearInterval(S._volFadeTimer); S._volFadeTimer = null; } catch {}
    const finish = () => { S._volFadeRes = null; S._volFadeTimer = null; res(); };
    S._volFadeRes = finish;
    try {
      const start = audio.volume;
      if (ms <= 0 || start === target) { try { audio.volume = target; } catch {} finish(); return; }
      const steps = 6;
      let i = 0;
      S._volFadeTimer = setInterval(() => {
        i++;
        try { audio.volume = Math.min(1, Math.max(0, start + (target - start) * (i / steps))); } catch {}
        if (i >= steps) { clearInterval(S._volFadeTimer); finish(); }
      }, Math.max(10, Math.round(ms / steps)));
    } catch { finish(); }
  });
}

export function warmAudioUrl(url) {
  if (!url || typeof url !== 'string') return;
  if (S._karaokeWarm === url) return;
  S._karaokeWarm = url;
  try {
    const w = new Audio();
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      try { w.removeAttribute('src'); w.load(); } catch {}
    };
    try { w.preload = 'auto'; } catch {}
    w.src = url;
    w.addEventListener('canplay', drop, { once: true });
    w.addEventListener('error', drop, { once: true });
    setTimeout(drop, SWITCH_WARM_TTL);
  } catch {}
}

export async function switchKaraokeAudio(targetUrl, opts = {}) {
  const seq = ++S._switchSeq;
  const alive = () => seq === S._switchSeq;
  const fallbackUrl = opts.fallbackUrl || null;
  const wasPlaying = opts.wasPlaying ?? !audio.paused;

  warmAudioUrl(targetUrl);

  const bound = [];
  const bind = (type, fn) => { try { audio.addEventListener(type, fn); bound.push([type, fn]); } catch {} };
  const releaseAll = () => { while (bound.length) { const [type, fn] = bound.pop(); try { audio.removeEventListener(type, fn); } catch {} } };
  const raceEvent = (types, timeout) => new Promise((res) => {
    if (!alive()) return res('');
    let timer = null;
    const fire = (type) => { if (timer) clearTimeout(timer); releaseAll(); res(type); };
    for (const tp of types) bind(tp, () => fire(tp));
    timer = setTimeout(() => { releaseAll(); res(''); }, Math.max(0, timeout));
  });
  const seekTo = (pos) => {
    try {
      const d = audio.duration;
      audio.currentTime = (Number.isFinite(d) && d > 1)
        ? Math.min(Math.max(0, pos), Math.max(0, d - 0.05))
        : Math.max(0, pos);
    } catch {}
  };
  const paintDur = () => { try { S.tracks[S.idx].dur = fmt(audio.duration); renderTracks($('#globalSearch').value); } catch {} };
  const loadSrc = (url) => { try { audio.src = url; audio.load(); } catch {} };

  applyEnhanceState();
  applyKaraokeMakeup();

  if (wasPlaying) { fadeOutput(0, SWITCH_FADE_OUT); await sleepMs(SWITCH_FADE_OUT); }
  else fadeOutput(1, 0);
  if (!alive()) { releaseAll(); return; }

  const pos = Number.isFinite(opts.pos) ? opts.pos : (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);

  try {
    const prev = audio.src;
    if (prev && prev.startsWith('blob:') && prev !== targetUrl) URL.revokeObjectURL(prev);
  } catch {}

  loadSrc(targetUrl);
  const first = await raceEvent(['loadedmetadata', 'error'], SWITCH_MAX_WAIT);
  if (first === 'error') {
    let finalUrl = null;
    try {
      const res = await fetch(targetUrl);
      if (res.ok) {
        const b = await res.blob();
        if (b.size > 1024) finalUrl = URL.createObjectURL(b);
      }
    } catch {}
    if (!finalUrl && fallbackUrl) {
      finalUrl = fallbackUrl;
      audio.dataset.karaoke = 'false';
      audio.dataset.mode = '';
      S.karaokeOn = false;
      try { syncKaraokeBtn(); } catch {}
      applyEnhanceState();
      applyKaraokeMakeup();
    }
    if (!finalUrl) { releaseAll(); fadeOutput(1, wasPlaying ? 120 : 0); return; }
    loadSrc(finalUrl);
    if (!alive()) { releaseAll(); return; }
    await raceEvent(['loadedmetadata', 'error'], SWITCH_MAX_WAIT);
  }
  if (!alive()) { releaseAll(); return; }

  seekTo(pos);
  paintDur();
  await raceEvent(['canplay', 'error'], SWITCH_MAX_WAIT);
  if (!alive()) { releaseAll(); return; }
  try { if (Math.abs(audio.currentTime - pos) > SWITCH_SEEK_RECHECK) seekTo(pos); } catch {}
  releaseAll();

  if (wasPlaying) {
    try { audio.play().catch(() => {}); } catch {}
    fadeOutput(1, SWITCH_FADE_IN);
  } else {
    fadeOutput(1, 0);
  }
}
