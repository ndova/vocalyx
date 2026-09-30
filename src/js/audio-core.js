import { S } from './state.js';
import { audio } from './dom.js';
import { EQ_FREQS } from './eq-data.js';
import { paintEqKnobs } from './eq.js';
import { isLocalPath } from './enhance.js';
import { showToast } from './engine.js';
import { ICON } from './icons.js';

export function ensureGraph() {
  if (S.actx) { if (S.actx.state === 'suspended') S.actx.resume(); return; }
  S.actx = new (window.AudioContext || window.webkitAudioContext)();
  S.srcNode = S.actx.createMediaElementSource(audio);
  let head = S.srcNode;
  S.eqNodes = EQ_FREQS.map((f) => {
    const bq = S.actx.createBiquadFilter();
    bq.type = 'peaking';
    bq.frequency.value = f;
    bq.Q.value = 1.0;
    bq.gain.value = 0;
    head.connect(bq);
    head = bq;
    return bq;
  });
  S.compNode = S.actx.createDynamicsCompressor();
  S.compNode.threshold.value = 0;
  S.compNode.knee.value = 0;
  S.compNode.ratio.value = 1;
  S.compNode.attack.value = 0.003;
  S.compNode.release.value = 0.25;
  S.normGain = S.actx.createGain();
  S.normGain.gain.value = 1;
  head.connect(S.compNode);
  S.compNode.connect(S.normGain);
  S.gainNode = S.actx.createGain();
  S.gainNode.gain.value = 0.5;
  S.analyser = S.actx.createAnalyser();
  S.analyser.fftSize = 256;
  S.normGain.connect(S.gainNode);
  S.gainNode.connect(S.analyser);
  S.analyser.connect(S.actx.destination);
  applyFxState();
  applyEnhanceState();
}

export function applyFxState() {
  document.querySelectorAll('[data-eq]').forEach(el => { el.disabled = !S.fxEnabled; });
  try { paintEqKnobs(); } catch {}
  const pb = document.querySelector('#btnPreset');
  if (pb) pb.disabled = !S.fxEnabled;
  if (!S.actx) return;
  S.eqNodes.forEach((n, i) => {
    n.gain.value = S.fxEnabled ? parseFloat(document.querySelector(`[data-eq="${i}"]`)?.value || 0) : 0;
  });
}

export const _rgGainCache = {};
const _rgPending = {};
export function rgTargetDb(){ return parseFloat(S.downloadOptions.replayGainTarget) || -14; }
function rgPreAmpDb(){ return parseFloat(S.downloadOptions.replayGainPreAmp) || 0; }
function rgKeyOf(path){ return path + '|' + rgTargetDb(); }
function rgDbToGain(db){
  const g = Math.pow(10, db / 20);
  if (!Number.isFinite(g)) return 1;
  return Math.min(4, Math.max(0.25, g));
}
function rgFinalDb(gainDb, peak){
  let db = (Number.isFinite(gainDb) ? gainDb : 0) + rgPreAmpDb();
  const preventClip = S.downloadOptions.replayGainClipPrevention !== false;
  if (preventClip && db > 0 && Number.isFinite(peak) && peak > 0) {
    const headroom = -20 * Math.log10(peak);
    if (headroom < db) db = headroom;
  }
  return db;
}
function rgBypassReason(){
  if (!S.downloadOptions.replayGainEnabled) return 'off';
  if (audio && audio.dataset && audio.dataset.karaoke === 'true') return 'karaoke';
  if (audio && audio.dataset && audio.dataset.isPreview) return 'preview';
  return '';
}
function applyVolumeGain(gainDb, peak){
  if (!S.actx || !S.normGain) return;
  const bypass = rgBypassReason();
  if (bypass === 'off') { S.normGain.gain.value = 1; return; }
  if (bypass === 'karaoke') { S.normGain.gain.value = 1; return; }
  if (bypass === 'preview') { S.normGain.gain.value = rgDbToGain(rgPreAmpDb()); return; }
  const path = S.tracks[S.idx]?.path || '';
  if (!path || !isLocalPath(path)) { S.normGain.gain.value = rgDbToGain(rgPreAmpDb()); return; }
  if (gainDb === undefined || !Number.isFinite(gainDb)) {
    S.normGain.gain.value = rgDbToGain(rgPreAmpDb());
    return;
  }
  S.normGain.gain.value = rgDbToGain(rgFinalDb(gainDb, peak));
}
function applyVolumeGainFromCache(){
  if (!S.actx || !S.normGain) return;
  const bypass = rgBypassReason();
  if (bypass) { applyVolumeGain(undefined); return; }
  const path = S.tracks[S.idx]?.path || '';
  if (!path || !isLocalPath(path)) { applyVolumeGain(undefined); return; }
  const hit = _rgGainCache[rgKeyOf(path)];
  if (hit) applyVolumeGain(hit.gainDb, hit.peak);
}
function fetchRG(path){
  const key = rgKeyOf(path);
  if (_rgGainCache[key]) return Promise.resolve(_rgGainCache[key]);
  if (_rgPending[key]) return _rgPending[key];
  const target = rgTargetDb();
  _rgPending[key] = fetch('http://127.0.0.1:8001/loudness?path=' + encodeURIComponent(path) + '&target=' + encodeURIComponent(String(target)))
    .then(r => r.json())
    .then(j => {
      if (j && j.ok && Number.isFinite(j.gainDb)) {
        _rgGainCache[key] = { gainDb: j.gainDb, peak: Number.isFinite(j.peak) ? j.peak : 1 };
        return _rgGainCache[key];
      }
      return null;
    })
    .catch(() => null)
    .finally(() => { delete _rgPending[key]; });
  return _rgPending[key];
}
export function prefetchVolumeGain(path){
  if (!S.downloadOptions.replayGainEnabled) return;
  if (!path || !isLocalPath(path)) return;
  fetchRG(path);
}
export async function ensureVolumeGain({ notify = false } = {}){
  if (!S.downloadOptions.replayGainEnabled) { if (S.actx && S.normGain) S.normGain.gain.value = 1; return; }
  const bypass = rgBypassReason();
  if (bypass === 'karaoke') { if (S.actx && S.normGain) S.normGain.gain.value = 1; return; }
  if (bypass === 'preview') { if (S.actx && S.normGain) S.normGain.gain.value = rgDbToGain(rgPreAmpDb()); return; }
  const path = S.tracks[S.idx]?.path || '';
  if (!path || !isLocalPath(path)) { if (S.actx && S.normGain) S.normGain.gain.value = rgDbToGain(rgPreAmpDb()); return; }
  const token = ++S._rgApplyToken;
  const hit0 = _rgGainCache[rgKeyOf(path)];
  if (hit0) { if (S.actx && S.normGain) applyVolumeGain(hit0.gainDb, hit0.peak); return; }
  if (notify) showToast('Mengukur loudness…', 4000);
  const hit = await fetchRG(path);
  if (token !== S._rgApplyToken) return;
  if ((S.tracks[S.idx]?.path || '') !== path) return;
  if (!S.actx) ensureGraph();
  if (hit) applyVolumeGain(hit.gainDb, hit.peak);
  else applyVolumeGain(undefined);
}
export function applyEnhanceState() {
  if (!S.actx || !S.compNode || !S.normGain) return;
  S.compNode.threshold.value = 0;
  S.compNode.knee.value = 0;
  S.compNode.ratio.value = 1;
  S.compNode.attack.value = 0.003;
  S.compNode.release.value = 0.25;
  applyVolumeGainFromCache();
}

function baseVolGain(){
  const v = parseFloat(document.getElementById('vol')?.value);
  return isFinite(v) ? v / 100 : 0.5;
}
export function applyKaraokeMakeup(){
  if (!S.actx || !S.gainNode) return;
  S.gainNode.gain.value = baseVolGain();
}
export { _rgPending, rgPreAmpDb, rgKeyOf, rgDbToGain, rgFinalDb, rgBypassReason, applyVolumeGain, applyVolumeGainFromCache, fetchRG, baseVolGain };
export let previewAudio = null;
let _pvWired = false;
let _pvBtn = null;
let _pvCap = 0;
let _pvNotified = false;
function ensurePreviewAudio() {
  if (previewAudio) return previewAudio;
  let pa = null;
  try { pa = new Audio(); } catch { return null; }
  if (!pa) return null;
  try { pa.preload = 'none'; } catch {}
  previewAudio = pa;
  if (!_pvWired) {
    _pvWired = true;
    previewAudio.onended = () => { stopPreview(); };
    previewAudio.ontimeupdate = () => {
      if (_pvCap > 0 && previewAudio.duration && previewAudio.currentTime >= _pvCap) {
        try { previewAudio.currentTime = _pvCap; } catch {}
        const notify = !_pvNotified;
        _pvNotified = true;
        stopPreview();
        if (notify) showToast('Preview 30 detik selesai — download untuk versi full', 4000);
      }
    };
  }
  return previewAudio;
}
export function setPreviewButton(btn, capSecs = 0) {
  _pvBtn = btn || null;
  _pvCap = Number(capSecs) || 0;
  _pvNotified = false;
}
export function stopPreview() {
  const pa = previewAudio;
  try { if (pa) pa.pause(); } catch {}
  try { if (pa) { pa.removeAttribute('src'); pa.load(); } } catch {}
  _pvCap = 0; _pvNotified = false;
  if (_pvBtn) { try { _pvBtn.innerHTML = ICON.play; _pvBtn.disabled = false; } catch {} _pvBtn = null; }
}
export function isPreviewPlaying() {
  try { return !!previewAudio && !!previewAudio.src && !previewAudio.paused; } catch { return false; }
}
export function playPreviewAudio(url, btn, capSecs = 0) {
  if (!url) return;
  const pa = ensurePreviewAudio();
  stopPreview();
  if (!pa) return;
  setPreviewButton(btn, capSecs);
  try {
    pa.volume = baseVolGain();
    pa.src = url;
    try { pa.currentTime = 0; } catch {}
    const pr = pa.play();
    if (pr && pr.catch) pr.catch(() => stopPreview());
    if (btn) btn.innerHTML = ICON.pause;
  } catch { stopPreview(); }
}
