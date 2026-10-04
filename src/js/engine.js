import { t } from './i18n/core.js';
import { S } from './state.js';
import { audio, $ } from './dom.js';
import { fmt } from './format.js';
import { applyEnhanceState, applyKaraokeMakeup, invokeTauri, renderAlbumDetail, renderArtistDetail, renderTracks } from '../app.js';

const sepStatus = $('#sepStatus');
export function showToast(msg, ms = 5000) {
  if (!msg) return;
  let el = document.getElementById('appToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'appToast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(()=> el.classList.remove('show'), ms);
}
const SRC_CAP = { youtube: 160, 'youtube-fallback': 160, 'youtube-music': 160, soundcloud: 128, 'soundcloud-search': 128, 'soundcloud-alt': 128, premium: 320 };
const SRC_LABEL = { youtube: 'YouTube', 'youtube-fallback': 'YouTube', 'youtube-music': 'YT Music', soundcloud: 'SoundCloud', 'soundcloud-direct': 'SoundCloud', 'soundcloud-search': 'SoundCloud', 'soundcloud-alt': 'SoundCloud', 'soundcloud-preview': 'SoundCloud', 'archive-direct': 'Archive.org', '4shared-direct': '4shared', premium: 'Spotify Premium', 'spotify-premium': 'Spotify Premium' };
function showAudioNotice(tk, notice, via) {
  if (!notice) return;
  const srcKey = notice.source || via;
  const src = SRC_LABEL[srcKey] || SRC_LABEL[via] || (srcKey || via || t('eng.srcGeneric')).replace(/-/g, ' ');
  const actual = notice.actualKbps ? `${notice.actualKbps}kbps` : t('eng.unmeasured');
  let msg;
  if (notice.passthrough) {
    msg = t('eng.passthrough', { src, kbps: actual });
  } else if (notice.capped) {
    const cap = SRC_CAP[via] ?? null;
    msg = cap ? t('eng.cappedMax', { src, cap, kbps: actual })
              : t('eng.cappedSrc', { kbps: actual });
  } else {
    msg = `${tk.title || t('eng.genericTrack')} selesai: ${actual} dari ${src}`;
  }
  showToast(msg);
}
export function showSep(msg, ms = 4000) {
  if (!sepStatus) return;
  if (!msg) { sepStatus.style.display = 'none'; return; }
  sepStatus.textContent = msg;
  sepStatus.style.display = 'block';
  if (ms) setTimeout(() => { if (sepStatus.textContent === msg) sepStatus.style.display = 'none'; }, ms);
}
const ENG_BASE = 'http://127.0.0.1:8001';
let cudaRefreshHook = null;
export function registerCudaRefresh(fn) { cudaRefreshHook = fn; }
async function engineHealth() {
  let ok = false;
  for (const u of [ENG_BASE + '/health', '/api/health']) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (r.ok) { await r.json(); ok = true; break; }
    } catch {}
  }
  try { if (cudaRefreshHook) cudaRefreshHook(ok); } catch {}
  return ok;
}
async function engineGet(path) {
  try {
    const r = await fetch(ENG_BASE + path, { cache: 'no-store' });
    if (r.ok) return r;
  } catch {}
  return fetch('/api' + path, { cache: 'no-store' });
}
async function engineInfo() { // /health versi lengkap; engineHealth() cuma return boolean (JSON dibuang)
  for (const u of [ENG_BASE + '/health', '/api/health']) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.ok) return j;
    } catch {}
  }
  return null;
}
async function karaokeCaps(selected, force) {
  const dev = String(selected || (S.downloadOptions && S.downloadOptions.karaokeDevice) || 'auto').toLowerCase();
  if (!force && S._karaokeCapsCache && S._karaokeCapsKey === dev && Date.now() - S._karaokeCapsAt < 60000) return S._karaokeCapsCache;
  for (const u of [ENG_BASE + '/karaoke', '/api/karaoke']) {
    try {
      const r = await fetch(u + '?device=' + encodeURIComponent(dev), { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok !== false) { S._karaokeCapsCache = j; S._karaokeCapsKey = dev; S._karaokeCapsAt = Date.now(); return j; }
      }
    } catch {}
  }
  return null;
}
function cudaDeviceLabel(dinfo, resolved) {
  const r = String(resolved || '').toLowerCase();
  if (r === 'cpu') return 'CPU';
  if (r === 'cuda') return `GPU (${(dinfo && dinfo.device) || 'CUDA'})`;
  if (!dinfo) return '';
  return dinfo.cuda ? `GPU (${dinfo.device || 'CUDA'})` : 'CPU';
}
async function refreshCudaStatus(force) {
  const dot = document.getElementById('cudaConnDot');
  const el = document.getElementById('karaokeCudaStatus');
  if (!el && !dot) return false;
  if (el) el.textContent = t('eng.cudaChecking');
  const sel = String((S.downloadOptions && S.downloadOptions.karaokeDevice) || 'auto').toLowerCase();
  let caps = null;
  try { caps = await karaokeCaps(sel, force); } catch { caps = null; }
  S._lastCudaRefreshAt = Date.now();
  if (!caps) {
    S._lastCudaOffline = true;
    if (dot) dot.style.background = 'var(--muted)';
    if (el) { el.textContent = (S._cudaRestartingAt || S._deviceSwitching) ? t('eng.restarting') : t('eng.offlineRun'); el.style.color = '#e5484d'; }
    S._prevCudaActive = false;
    return false;
  }
  S._lastCudaOffline = false;
  if (S._cudaRestartingAt && !S._deviceSwitching) S._cudaRestartingAt = false;
  if (sel === 'cpu') {
    const nm = (caps && caps.cpu_name) || '';
    const th = (caps && caps.cpu_threads) || 0;
    if (dot) dot.style.background = 'var(--accent)';
    if (el) {
      el.textContent = `${t('eng.active')}: ${nm || 'CPU'}${th ? ` • ${th} thread` : ''}`;
      el.style.color = 'var(--muted)';
    }
    S._prevCudaActive = !!caps;
    return !!caps;
  }
  const active = !!(caps && caps.cuda);
  if (dot) dot.style.background = active ? 'var(--accent)' : 'var(--muted)';
  if (el) {
    if (active) {
      const vram = (caps.vram_free_gb != null && caps.vram_total_gb != null) ? ` • VRAM bebas ${caps.vram_free_gb}/${caps.vram_total_gb} GB` : '';
      el.textContent = `${t('eng.active')}: ${caps.device || 'GPU'}${vram}`;
    } else el.textContent = t('eng.notDetected');
    el.style.color = active ? 'var(--muted)' : '#e5484d';
  }
  S._prevCudaActive = active;
  return active;
}
function karaokeUploadName(t) {
  const fromPath = (t.path || '').split(/[/\\]/).pop() || '';
  if (fromPath && fromPath.includes('.')) return fromPath;
  const ext = (t.ext || '').toLowerCase().replace(/^\./, '') || 'mp3';
  const base = (t.name || fromPath || 'track').replace(/\.[a-z0-9]+$/i, '');
  return `${base}.${ext}`;
}
function parseEngineError(text) {
  try {
    const j = JSON.parse(text);
    return j.error || j.message || text;
  } catch { return text; }
}

const KARAOKE_STAGE_KEYS = {
  queued: 'eng.kStageQueued', probe: 'eng.kStageProbe', separate: 'eng.kStageSeparate',
  dsp: 'eng.kStageDsp', 'dsp:load': 'eng.kStageDsp',
  'dsp:cleanup': 'eng.kStageDsp', 'dsp:done': 'eng.kStageDsp',
  loudnorm: 'eng.kStageLoudnorm', 'convert-target': 'eng.kStageSave', trim: 'eng.kStageSave',
  'cache-persist': 'eng.kStageCache', cache: 'eng.kStageCache', done: 'eng.kStageDone',
};
const KARAOKE_STAGE_LABELS = KARAOKE_STAGE_KEYS;
export function karaokeStageLabel(stage) {
  const s = String(stage || '').trim();
  if (!s) return t('eng.kStageWorking');
  const key = KARAOKE_STAGE_KEYS[s];
  if (key) return t(key);
  if (s.startsWith('separate:')) return t('eng.kStageSeparate');
  return s;
}
export function karaokeBadgeHtml(track) {
  if (track.karaoke_job) {
    const stalled = track.karaoke_stalled ? ' stalled' : '';
    return `<span class="k-badge busy${stalled}">${t('eng.kBadgeSeparating')}</span>`;
  }
  return track.karaoke_path ? `<span class="k-badge">${t('eng.karaokeLabel')}</span>` : '';
}
export function karaokeProgressHtml(track) {
  if (!track.karaoke_job) return '';
  const hasPct = typeof track.karaoke_pct === 'number' && isFinite(track.karaoke_pct);
  const p = hasPct ? Math.max(0, Math.min(100, Math.round(track.karaoke_pct))) : 0;
  const stalled = track.karaoke_stalled ? ' stalled' : '';
  const label = hasPct ? `${p}%` : karaokeStageLabel(track.karaoke_stage);
  return `<div class="k-prog${stalled}"><div class="k-prog-track"><div class="k-prog-fill" style="width:${p}%"></div></div><span class="k-prog-txt">${label}</span></div>`;
}
function updateKaraokeBadge(t) {
  try {
    const key = (window.CSS && window.CSS.escape) ? window.CSS.escape(t.path || '') : (t.path || '');
    const rows = document.querySelectorAll(`button.track[data-tpath="${key}"]`);
    if (!rows.length) return false;
    const badgeHtml = karaokeBadgeHtml(t);
    const barHtml = karaokeProgressHtml(t);
    rows.forEach((row) => {
      try {
        const tmp = document.createElement('span');
        tmp.innerHTML = badgeHtml;
        const fresh = tmp.firstChild || null;
        const badge = row.querySelector('.k-badge.busy') || row.querySelector('.k-badge');
        if (fresh) {
          if (badge) badge.replaceWith(fresh);
          else {
            const titleEl = row.querySelector('.t-title');
            if (titleEl) titleEl.insertAdjacentHTML('afterend', badgeHtml);
            else row.insertAdjacentHTML('beforeend', badgeHtml);
          }
        } else if (badge && !t.karaoke_job && !t.karaoke_path) {
          badge.remove();
        }
        let bar = row.querySelector('.k-prog');
        if (bar) {
          if (!barHtml) { bar.remove(); }
          else {
            const tmp = document.createElement('span');
            tmp.innerHTML = barHtml;
            if (tmp.firstChild) bar.replaceWith(tmp.firstChild);
          }
        } else if (barHtml) {
          const sub = row.querySelector('.t-sub');
          if (sub) sub.insertAdjacentHTML('afterend', barHtml);
        }
      } catch {}
    });
    return true;
  } catch { return false; }
}
function rerenderTrackViews() {
  try { renderTracks($('#globalSearch')?.value || ''); } catch {}
  try {
    if (typeof S.activeView === 'string') {
      if (S.activeView.startsWith('album:')) renderAlbumDetail(S.activeAlbumKey);
      else if (S.activeView.startsWith('artist:')) renderArtistDetail(S.activeArtistKey);
    }
  } catch {}
}

function fadeAudioVolume(target, ms = 150) {
  return new Promise(res => {
    try {
      clearInterval(S._volFadeTimer);
      const start = audio.volume;
      if (ms <= 0 || start === target) { try { audio.volume = target; } catch {} res(); return; }
      const steps = 6;
      let i = 0;
      S._volFadeTimer = setInterval(() => {
        i++;
        try { audio.volume = Math.min(1, Math.max(0, start + (target - start) * (i / steps))); } catch {}
        if (i >= steps) { clearInterval(S._volFadeTimer); S._volFadeTimer = null; res(); }
      }, Math.max(10, Math.round(ms / steps)));
    } catch { res(); }
  });
}
async function switchKaraokeAudio(targetUrl, opts = {}) {
  const pos = Number.isFinite(opts.pos) ? opts.pos : (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
  const wasPlaying = opts.wasPlaying ?? !audio.paused;
  const fallbackUrl = opts.fallbackUrl || null;
  const baseVol = audio.volume;
  await fadeAudioVolume(0, 120);
  try { if (audio.src && audio.src.startsWith('blob:') && audio.src !== targetUrl) URL.revokeObjectURL(audio.src); } catch {}
  try { audio.removeAttribute('src'); audio.load(); } catch {}
  let settled = false;
  const doSeekPlay = () => {
    if (settled) return; settled = true;
    try {
      const d = audio.duration;
      audio.currentTime = Number.isFinite(d) && d > 1 ? Math.min(Math.max(0, pos), Math.max(0, d - 0.05)) : Math.max(0, pos);
    } catch {}
    try { S.tracks[S.idx].dur = fmt(audio.duration); renderTracks($('#globalSearch').value); } catch {}
    if (wasPlaying) {
      if (audio.readyState >= 2) audio.play().catch(() => {});
      else {
        audio.addEventListener('canplay', () => audio.play().catch(() => {}), { once: true });
        setTimeout(() => { if (audio.paused && wasPlaying) audio.play().catch(() => {}); }, 600);
      }
    }
    fadeAudioVolume(baseVol, 180);
  };
  const onErr = async () => {
    if (settled) return;
    try {
      const res = await fetch(targetUrl);
      if (res.ok) {
        const b = await res.blob();
        if (b.size > 1024) {
          audio.src = URL.createObjectURL(b);
          try { audio.load(); } catch {}
          audio.addEventListener('loadedmetadata', doSeekPlay, { once: true });
          audio.addEventListener('canplay', doSeekPlay, { once: true });
          return;
        }
      }
    } catch {}
    if (fallbackUrl) {
      try {
        audio.src = fallbackUrl;
        audio.load();
        audio.dataset.karaoke = 'false';
        audio.dataset.mode = '';
        S.karaokeOn = false;
        try { syncKaraokeBtn(); } catch {}
        applyEnhanceState();
        applyKaraokeMakeup();
        audio.addEventListener('loadedmetadata', doSeekPlay, { once: true });
        audio.addEventListener('canplay', doSeekPlay, { once: true });
        return;
      } catch {}
    }
    settled = true;
    fadeAudioVolume(baseVol, 100);
  };
  audio.addEventListener('loadedmetadata', doSeekPlay, { once: true });
  audio.addEventListener('canplay', doSeekPlay, { once: true });
  audio.addEventListener('error', onErr, { once: true });
  setTimeout(() => { if (!settled) doSeekPlay(); }, 900);
  setTimeout(() => { try { audio.removeEventListener('error', onErr); } catch {} }, 5000);
  audio.src = targetUrl;
  try { audio.load(); } catch {}
  applyEnhanceState();
  applyKaraokeMakeup();
}

function isKaraokeBlocked(tk) {
  if (S.karaokeJobId) return false;
  if (typeof S.activeView !== 'undefined' && S.activeView === 'downloads') return true;
  if (!tk) return false;
  if (tk.fromDownloads) return true;
  try {
    if (typeof S.downloadPlayback !== 'undefined' && S.downloadPlayback && S.downloadPlayback.paths &&
        S.downloadPlayback.paths.includes(tk.path)) return true;
  } catch {}
  return false;
}
function syncKaraokeBtn(){
  const kb = $('#btnKaraoke');
  if (!kb) return;
  const tk = (typeof S.tracks !== 'undefined' && typeof S.idx === 'number') ? S.tracks[S.idx] : null;
  if (kb) { kb.classList.toggle('on', S.karaokeOn); if ('checked' in kb) kb.checked = S.karaokeOn; }
  if (S.karaokeJobId) {
    kb.disabled = false;
    kb.title = t('eng.karaokeRunning');
    return;
  }
  kb.title = t('eng.karaokeMode');
  kb.disabled = isKaraokeBlocked(tk);
}
async function separate(mode) {
  const tk = S.tracks[S.idx];
  if (!tk || (!tk.file && !tk.url && !tk.path)) { showSep(t('eng.pickFirst'), 3000); return; }
  if (!S.karaokeJobId && isKaraokeBlocked(tk)) { showSep(t('eng.karaokeFromDl'), 3000); syncKaraokeBtn(); return; }
  delete audio.dataset.previewCap;
  delete audio.dataset.previewNotified;
  if (tk.karaoke_path) {
    const isSameModeActive = audio.dataset.karaoke === 'true' && audio.dataset.mode === mode;
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const wasPlaying = !audio.paused;
      const pos = audio.currentTime;
      if (isSameModeActive) {
        audio.dataset.karaoke = 'false';
        audio.dataset.mode = '';
        S.karaokeOn = false;
        await switchKaraokeAudio(convertFileSrc(tk.path), { pos, wasPlaying });
      } else {
        audio.dataset.karaoke = 'true';
        audio.dataset.mode = mode;
        S.karaokeOn = mode === 'karaoke';
        await switchKaraokeAudio(convertFileSrc(tk.karaoke_path), { pos, wasPlaying, fallbackUrl: convertFileSrc(tk.path) });
      }
      syncKaraokeBtn();
      return;
    } catch (e) {
      showSep(t('eng.karaokeLocalFail', { n: e }), 3000);
      return;
    }
  }
  if (S.karaokeJobId) {
    S.karaokeCancelled = true;
    const cancelId = S.karaokeJobId; S.karaokeJobId = null;
    try {
      const payload = JSON.stringify({ job_id: cancelId });
      await fetch(ENG_BASE + '/separate/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
        .catch(() => fetch('/api/separate/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(() => {}));
    } catch {}
    tk.karaoke_job = false;
    try { renderTracks($('#globalSearch')?.value || ''); } catch {}
    syncKaraokeBtn();
    showSep(t('eng.karaokeCancelled'), 2500);
    return;
  }
  const online = await engineHealth();
  if (!online) {
    showSep(t('eng.karaokeNoEngine'), 2500);
    return;
  }
  const kb = $('#btnKaraoke'); if (kb) kb.disabled = true;
  S.karaokeCancelled = false;
const caps0 = await karaokeCaps().catch(() => null);
    const selDev0 = String((S.downloadOptions && S.downloadOptions.karaokeDevice) || 'auto').toLowerCase();
    if (caps0 && !caps0.cuda && selDev0 === 'cuda') {
      const kb1 = $('#btnKaraoke'); if (kb1) kb1.disabled = false;
      showSep(t('eng.cudaRequired'), 9000);
      showToast(t('eng.cudaRequired'), 9000);
      return;
    }
    if (caps0 && !caps0.cuda && selDev0 !== 'cpu') showToast(t('eng.notDetected'), 6000);
    const needVram = Number(caps0 && caps0.min_free_vram_gb) || 0;
    const freeVram = caps0 ? Number(caps0.vram_free_gb) : NaN;
    if (caps0 && caps0.cuda && selDev0 !== 'cpu' && needVram > 0 && Number.isFinite(freeVram) && freeVram < needVram) {
      const kb0 = $('#btnKaraoke'); if (kb0) kb0.disabled = false;
      showSep(t('eng.vramLow', { free: freeVram.toFixed(2), need: needVram.toFixed(1) }), 7000);
      showToast(t('eng.vramLow', { free: freeVram.toFixed(2), need: needVram.toFixed(1) }), 7000);
      return;
    }
    try { refreshCudaStatus().catch(() => {}); } catch {}
  try {
    const quality = ['karaoke_aufr33','cpu_inst_hq'].includes(S.downloadOptions.karaokeQuality) ? S.downloadOptions.karaokeQuality : 'karaoke_aufr33';
    const kDevice = S.downloadOptions.karaokeDevice || 'auto';
    const kFormat = S.downloadOptions.karaokeFormat || 'flac';
    const t0 = Date.now();
    try { showSep(''); } catch {}
    tk.karaoke_job = true;
    tk.karaoke_pct = 0; tk.karaoke_stage = 'queued';
    tk.karaoke_pct_at = Date.now(); tk.karaoke_stalled = false; tk._karaokeDevLbl = null;
    try { renderTracks($('#globalSearch')?.value || ''); } catch {}
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const url = convertFileSrc(tk.path);
    const blob = await (await fetch(url)).blob();
    const fd = new FormData();
    fd.append('file', blob, karaokeUploadName(tk));
    fd.append('mode', mode);
    fd.append('model', 'bsroformer');
    fd.append('quality', quality);
    fd.append('device', kDevice);
    fd.append('format', kFormat);
    if (tk.path) fd.append('track_path', tk.path);
    let startRes = null;
    try {
      startRes = await fetch(ENG_BASE + '/separate', { method: 'POST', body: fd });
      if (!startRes.ok && startRes.status === 404) throw new Error('fallback-proxy');
    } catch (e) {
      if (e?.message === 'fallback-proxy') throw e;
      startRes = await fetch('/api/separate', { method: 'POST', body: fd });
    }
    if (!startRes.ok) throw new Error(parseEngineError(await startRes.text()));
    const startCt = (startRes.headers.get('content-type') || '').toLowerCase();
    let outBlob = null;
    let jobId = null;
    if (startCt.includes('audio') || startCt.includes('octet-stream')) {
      outBlob = await startRes.blob();
    } else {
      let started = null;
      try {
        started = await startRes.json();
      } catch {
        try { outBlob = await startRes.blob(); } catch {}
        if (!outBlob || !outBlob.size) throw new Error('Respons engine bukan JSON job (kemungkinan engine lama). Restart engine lalu coba lagi.');
      }
      if (!outBlob) {
        jobId = started.job_id;
        if (!jobId) throw new Error('engine tidak mengembalikan job_id');
        S.karaokeJobId = jobId;
        try { syncKaraokeBtn(); } catch {}
    const progUrl = (id) => ENG_BASE + '/separate/progress?job_id=' + encodeURIComponent(id);
    const progUrlFb = (id) => '/api/separate/progress?job_id=' + encodeURIComponent(id);
    let done = false, failErr = '';
    let lastBadgeRender = 0;
    for (;;) {
      if (S.karaokeCancelled) { S.karaokeJobId = null; tk.karaoke_job = false; tk.karaoke_pct = null; tk.karaoke_stalled = false; try { renderTracks($('#globalSearch')?.value || ''); } catch {} return; }
      let pj = null;
      try {
        let pr = await fetch(progUrl(jobId), { cache: 'no-store' });
        if (!pr.ok) pr = await fetch(progUrlFb(jobId), { cache: 'no-store' });
        pj = pr.ok ? await pr.json() : null;
      } catch { pj = null; }
      if (pj) {
        let changed = false;
        if (typeof pj.pct === 'number' && isFinite(pj.pct)) {
          const p = Math.max(0, Math.min(100, Math.round(pj.pct)));
          if (p !== tk.karaoke_pct) { tk.karaoke_pct = p; tk.karaoke_pct_at = Date.now(); tk.karaoke_stalled = false; changed = true; }
        }
        if (pj.stage && pj.stage !== tk.karaoke_stage) { tk.karaoke_stage = pj.stage; changed = true; }
        if (pj.device_info || pj.device) {
          const lbl = cudaDeviceLabel(pj.device_info, pj.device);
          if (lbl && lbl !== tk._karaokeDevLbl) {
            tk._karaokeDevLbl = lbl;
            try { if (sepStatus) { sepStatus.textContent = t('eng.sepRunning', { n: lbl }); sepStatus.style.display = 'block'; } } catch {}
          }
        }
        if (!tk.karaoke_stalled && Date.now() - (tk.karaoke_pct_at || t0) > 15000) {
          tk.karaoke_stalled = true; changed = true;
        }
        if (changed) {
          if (!updateKaraokeBadge(tk) && Date.now() - lastBadgeRender > 3000) {
            lastBadgeRender = Date.now();
            rerenderTrackViews();
          }
        }
      }
      const elapsed = (Date.now() - t0) / 1000;
      if (pj && pj.status === 'done') { done = true; break; }
      if (pj && (pj.status === 'failed' || pj.status === 'cancelled')) { failErr = pj.error || pj.status; break; }
      if (elapsed > 1200) { failErr = 'timeout 20 mnt'; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    S.karaokeJobId = null;
    if (S.karaokeCancelled) { tk.karaoke_job = false; tk.karaoke_pct = null; tk.karaoke_stalled = false; try { renderTracks($('#globalSearch')?.value || ''); } catch {} return; }
    if (!done) { tk.karaoke_job = false; tk.karaoke_pct = null; tk.karaoke_stalled = false; try { renderTracks($('#globalSearch')?.value || ''); } catch {} throw new Error(failErr || 'separation gagal'); }
    tk.karaoke_pct = 100; tk.karaoke_stalled = false;
    try { if (!updateKaraokeBadge(tk)) rerenderTrackViews(); } catch {}
    try {
      const rr = await fetch(ENG_BASE + '/separate/result?job_id=' + encodeURIComponent(jobId));
      if (rr.ok) {
        const rrCt = (rr.headers.get('content-type') || '').toLowerCase();
        if (rrCt.includes('audio') || rrCt.includes('octet-stream') || !rrCt.includes('json')) {
          outBlob = await rr.blob();
        } else {
          const txt = await rr.text();
          throw new Error(parseEngineError(txt));
        }
      }
    } catch (e) {
      if (!outBlob || !outBlob.size) {
        if (e && e.message && !e.message.includes('fetch')) throw e;
      }
    }
    if (!outBlob || !outBlob.size) {
      const rr2 = await fetch('/api/separate/result?job_id=' + encodeURIComponent(jobId));
      if (!rr2.ok) throw new Error(parseEngineError(await rr2.text()));
      outBlob = await rr2.blob();
    }
      }
    }
    if (!outBlob || !outBlob.size) throw new Error('Hasil karaoke kosong');
    let savePath = null;
    try {
      const b64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => {
          const s = reader.result;
          const base64 = s.split(',')[1] || '';
          res(base64);
        };
        reader.onerror = rej;
        reader.readAsDataURL(outBlob);
      });
      const ext = outBlob.type.includes('flac') ? 'flac' : outBlob.type.includes('ogg') ? 'ogg' : outBlob.type.includes('wav') ? 'wav' : kFormat;
      if (!tk || !tk.path || tk.path === '.') throw new Error(t('eng.noTrackPath'));
      const live = S.tracks.find((x) => x && x.path === tk.path) || tk;
      savePath = await invokeTauri('save_karaoke', { trackPath: live.path, b64Data: b64, ext });
      if (!savePath) throw new Error(t('eng.emptySavePath'));
      live.karaoke_path = savePath;
      tk.karaoke_path = savePath;
      try {
        const cuBody = JSON.stringify({ job_id: jobId });
        const cuOpt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuBody };
        await fetch(ENG_BASE + '/separate/cleanup', cuOpt)
          .catch(() => fetch('/api/separate/cleanup', cuOpt).catch(() => {}));
      } catch {}
      live.karaoke_job = false; live.karaoke_pct = null; live.karaoke_stalled = false;
      tk.karaoke_job = false; tk.karaoke_pct = null; tk.karaoke_stalled = false;
      renderTracks($('#globalSearch')?.value || '');
    } catch (saveErr) {
      S.karaokeJobId = null;
      try { const tt = S.tracks[S.idx]; if (tt) { tt.karaoke_job = false; tt.karaoke_pct = null; tt.karaoke_stalled = false; } } catch {}
      tk.karaoke_job = false; tk.karaoke_pct = null; tk.karaoke_stalled = false;
      showSep(t('eng.saveFail', { n: (saveErr && saveErr.message) || saveErr || 'unknown' }), 5000);
      try { refreshCudaStatus().catch(() => {}); } catch {}
      try { syncKaraokeBtn(); } catch {}
      return;
    }
    const outUrl = URL.createObjectURL(outBlob);
    const wasPlaying2 = !audio.paused;
    const pos2 = audio.currentTime;
    let fallbackOrig = null;
    try { fallbackOrig = convertFileSrc(tk.path); } catch {}
    audio.dataset.karaoke = 'true';
    audio.dataset.mode = mode;
    S.karaokeOn = mode === 'karaoke';
    syncKaraokeBtn();
    await switchKaraokeAudio(outUrl, { pos: pos2, wasPlaying: wasPlaying2, fallbackUrl: fallbackOrig });
    tk.karaoke_job = false;
    try { renderTracks($('#globalSearch')?.value || ''); } catch {}
    showSep(t('eng.karaokeDone'), 2500);
    try { refreshCudaStatus().catch(() => {}); } catch {}
  } catch (e) {
    S.karaokeJobId = null;
    try { const tt = S.tracks[S.idx]; if (tt) { tt.karaoke_job = false; tt.karaoke_pct = null; tt.karaoke_stalled = false; } renderTracks($('#globalSearch')?.value || ''); } catch {}
    showSep(t('eng.bsrfFail', { n: e?.message || e }), 5000);
    try { refreshCudaStatus().catch(() => {}); } catch {}
  } finally {
    syncKaraokeBtn();
  }
  return;
}
$('#btnKaraoke').onclick = (e) => { if (e) e.preventDefault(); separate('karaoke'); };


export { sepStatus, SRC_CAP, SRC_LABEL, showAudioNotice, ENG_BASE, engineHealth, engineInfo, engineGet, karaokeCaps, cudaDeviceLabel, refreshCudaStatus, karaokeUploadName, parseEngineError, KARAOKE_STAGE_LABELS, updateKaraokeBadge, rerenderTrackViews, fadeAudioVolume, switchKaraokeAudio, isKaraokeBlocked, syncKaraokeBtn, separate };
