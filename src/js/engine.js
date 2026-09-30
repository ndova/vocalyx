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
function showAudioNotice(t, notice, via) {
  if (!notice) return;
  const srcKey = notice.source || via;
  const src = SRC_LABEL[srcKey] || SRC_LABEL[via] || (srcKey || via || 'sumber').replace(/-/g, ' ');
  const actual = notice.actualKbps ? `${notice.actualKbps}kbps` : 'tak terukur';
  let msg;
  if (notice.passthrough) {
    msg = `Sumber ${src} asli ${actual} — disimpan apa adanya (tanpa convert)`;
  } else if (notice.capped) {
    const cap = SRC_CAP[via] ?? null;
    msg = cap ? `Sumber ${src} maks ${cap}kbps — disimpan apa adanya (aktual ${actual})`
              : `Kualitas dibatasi sumber — aktual ${actual}`;
  } else {
    msg = `${t.title || 'Lagu'} selesai: ${actual} dari ${src}`;
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
async function engineHealth() {
  for (const u of [ENG_BASE + '/health', '/api/health']) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (r.ok) { await r.json(); return true; }
    } catch {}
  }
  return false;
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
async function karaokeCaps(selected) {
  const dev = String(selected || (S.downloadOptions && S.downloadOptions.karaokeDevice) || 'auto').toLowerCase();
  if (S._karaokeCapsCache && S._karaokeCapsKey === dev && Date.now() - S._karaokeCapsAt < 60000) return S._karaokeCapsCache;
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
function karaokeCudaLabel(caps) {
  if (!caps) return 'CUDA: engine offline — tidak terdeteksi';
  if (caps.cuda) {
    const vram = (caps.vram_free_gb != null && caps.vram_total_gb != null)
      ? ` • VRAM bebas ${caps.vram_free_gb}/${caps.vram_total_gb} GB` : '';
    const kim = caps.kim_cached ? ` • model Kim ${caps.kim_mb || '?'} MB (cached)` : ' • model Kim belum terdownload';
    return `CUDA terdeteksi: ${caps.device || 'GPU'}${vram}${kim}`;
  }
  const prov = (caps.providers && caps.providers.length) ? caps.providers.join(',') : 'tanpa provider GPU';
  return `CUDA ERROR: tidak terdeteksi (${prov}) — karaoke akan jatuh ke CPU yang sangat lambat. Cek driver/NVIDIA.`;
}
function cudaDeviceLabel(dinfo, resolved) {
  const r = String(resolved || '').toLowerCase();
  if (r === 'cpu') return 'CPU';
  if (r === 'cuda') return `GPU (${(dinfo && dinfo.device) || 'CUDA'})`;
  if (!dinfo) return '';
  if (dinfo.cuda) return `GPU (${dinfo.device || 'CUDA'})`;
  return 'CPU';
}
async function refreshCudaStatus() {
  const dot = document.getElementById('cudaConnDot');
  const el = document.getElementById('karaokeCudaStatus');
  if (!el && !dot) return false;
  if (el) el.textContent = 'CUDA: mengecek…';
  const sel = String((S.downloadOptions && S.downloadOptions.karaokeDevice) || 'auto').toLowerCase();
  let caps = null;
  try { caps = await karaokeCaps(sel); } catch { caps = null; }
  if (sel === 'cpu') {
    const nm = (caps && caps.cpu_name) || '';
    const th = (caps && caps.cpu_threads) || 0;
    if (dot) dot.style.background = caps ? 'var(--accent)' : 'var(--muted)';
    if (el) {
      if (!caps) el.textContent = 'Engine offline — jalankan npm run engine';
      else el.textContent = `Aktif: ${nm || 'CPU'}${th ? ` • ${th} thread` : ''}`;
      el.style.color = caps ? 'var(--muted)' : '#e5484d';
    }
    S._prevCudaActive = !!caps;
    return !!caps;
  }
  const active = !!(caps && caps.cuda);
  if (dot) dot.style.background = active ? 'var(--accent)' : 'var(--muted)';
  if (el) {
    if (!caps) el.textContent = 'Engine offline — jalankan npm run engine';
    else if (active) {
      const vram = (caps.vram_free_gb != null && caps.vram_total_gb != null) ? ` • VRAM bebas ${caps.vram_free_gb}/${caps.vram_total_gb} GB` : '';
      el.textContent = `Aktif: ${caps.device || 'GPU'}${vram}`;
    } else el.textContent = 'Tidak terdeteksi — karaoke jalan di CPU';
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

const KARAOKE_STAGE_LABELS = {
  queued: 'menunggu', probe: 'membaca audio', separate: 'memisahkan vokal',
  loudnorm: 'menyamakan volume', 'convert-target': 'menyimpan', trim: 'menyimpan',
  'to-wav-demucs': 'fallback Demucs', 'demucs-fallback': 'fallback Demucs',
  'cache-persist': 'dari cache', cache: 'dari cache', done: 'selesai',
};
export function karaokeStageLabel(stage) {
  const s = String(stage || '').trim();
  if (!s) return 'bekerja';
  return KARAOKE_STAGE_LABELS[s] || s;
}
export function karaokeBadgeHtml(t) {
  if (t.karaoke_job) {
    const stalled = t.karaoke_stalled ? ' stalled' : '';
    return `<span class="k-badge busy${stalled}">proses konversi karaoke</span>`;
  }
  return t.karaoke_path ? '<span class="k-badge">karaoke</span>' : '';
}
export function karaokeProgressHtml(t) {
  if (!t.karaoke_job) return '';
  const hasPct = typeof t.karaoke_pct === 'number' && isFinite(t.karaoke_pct);
  const p = hasPct ? Math.max(0, Math.min(100, Math.round(t.karaoke_pct))) : 0;
  const stalled = t.karaoke_stalled ? ' stalled' : '';
  const label = hasPct ? `${p}%` : karaokeStageLabel(t.karaoke_stage);
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
        const badge = row.querySelector('.k-badge.busy');
        if (badge) {
          const tmp = document.createElement('span');
          tmp.innerHTML = badgeHtml;
          if (tmp.firstChild) badge.replaceWith(tmp.firstChild);
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
        S.karaokeOn = false; S.vocalOffOn = false;
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

function isKaraokeBlocked(t) {
  if (S.karaokeJobId) return false;
  if (typeof S.activeView !== 'undefined' && S.activeView === 'downloads') return true;
  if (!t) return false;
  if (t.fromDownloads) return true;
  try {
    if (typeof S.downloadPlayback !== 'undefined' && S.downloadPlayback && S.downloadPlayback.paths &&
        S.downloadPlayback.paths.includes(t.path)) return true;
  } catch {}
  return false;
}
function syncKaraokeBtn(){
  const kb = $('#btnKaraoke');
  if (!kb) return;
  const t = (typeof S.tracks !== 'undefined' && typeof S.idx === 'number') ? S.tracks[S.idx] : null;
  if (kb) { kb.classList.toggle('on', S.karaokeOn); if ('checked' in kb) kb.checked = S.karaokeOn; }
  if (S.karaokeJobId) {
    kb.disabled = false;
    kb.title = 'Konversi karaoke berjalan — klik untuk membatalkan';
    return;
  }
  kb.title = 'Karaoke mode';
  kb.disabled = isKaraokeBlocked(t);
}
async function separate(mode) {
  const t = S.tracks[S.idx];
  if (!t || (!t.file && !t.url && !t.path)) { showSep('Pilih lagu dulu (Add Folder)', 3000); return; }
  if (!S.karaokeJobId && isKaraokeBlocked(t)) { showSep('Karaoke tidak tersedia untuk lagu dari menu Downloads', 3000); syncKaraokeBtn(); return; }
  delete audio.dataset.previewCap;
  delete audio.dataset.previewNotified;
  if (t.karaoke_path) {
    const isSameModeActive = audio.dataset.karaoke === 'true' && audio.dataset.mode === mode;
    try {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const wasPlaying = !audio.paused;
      const pos = audio.currentTime;
      if (isSameModeActive) {
        audio.dataset.karaoke = 'false';
        audio.dataset.mode = '';
        S.karaokeOn = false; S.vocalOffOn = false;
        await switchKaraokeAudio(convertFileSrc(t.path), { pos, wasPlaying });
      } else {
        audio.dataset.karaoke = 'true';
        audio.dataset.mode = mode;
        S.karaokeOn = mode === 'karaoke';
        S.vocalOffOn = mode === 'vocal';
        await switchKaraokeAudio(convertFileSrc(t.karaoke_path), { pos, wasPlaying, fallbackUrl: convertFileSrc(t.path) });
      }
      syncKaraokeBtn();
      return;
    } catch (e) {
      showSep('Gagal play karaoke lokal: ' + e, 3000);
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
    t.karaoke_job = false;
    try { renderTracks($('#globalSearch')?.value || ''); } catch {}
    syncKaraokeBtn();
    showSep('Karaoke dibatalkan', 2500);
    return;
  }
  const online = await engineHealth();
  if (!online) {
    showSep('Karaoke tidak tersedia — engine offline', 2500);
    return;
  }
  const kb = $('#btnKaraoke'); if (kb) kb.disabled = true;
  S.karaokeCancelled = false;
  const caps0 = await karaokeCaps().catch(() => null);
  const selDev0 = String((S.downloadOptions && S.downloadOptions.karaokeDevice) || 'auto').toLowerCase();
  if (caps0 && !caps0.cuda && selDev0 !== 'cpu') showToast(karaokeCudaLabel(caps0), 6000);
  try { refreshCudaStatus().catch(() => {}); } catch {}
  try {
    const quality = S.downloadOptions.karaokeQuality || 'standard';
    const kDevice = S.downloadOptions.karaokeDevice || 'auto';
    const kFormat = S.downloadOptions.karaokeFormat || 'flac';
    const t0 = Date.now();
    try { showSep(''); } catch {}
    t.karaoke_job = true;
    t.karaoke_pct = 0; t.karaoke_stage = 'queued';
    t.karaoke_pct_at = Date.now(); t.karaoke_stalled = false; t._karaokeDevLbl = null;
    try { renderTracks($('#globalSearch')?.value || ''); } catch {}
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const url = convertFileSrc(t.path);
    const blob = await (await fetch(url)).blob();
    const fd = new FormData();
    fd.append('file', blob, karaokeUploadName(t));
    fd.append('mode', mode);
    fd.append('model', 'bsroformer');
    fd.append('quality', quality);
    fd.append('device', kDevice);
    fd.append('format', kFormat);
    if (t.path) fd.append('track_path', t.path);
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
        const jobId = started.job_id;
        if (!jobId) throw new Error('engine tidak mengembalikan job_id');
        S.karaokeJobId = jobId;
        try { syncKaraokeBtn(); } catch {}
    const progUrl = (id) => ENG_BASE + '/separate/progress?job_id=' + encodeURIComponent(id);
    const progUrlFb = (id) => '/api/separate/progress?job_id=' + encodeURIComponent(id);
    let done = false, failErr = '';
    let lastBadgeRender = 0;
    for (;;) {
      if (S.karaokeCancelled) { S.karaokeJobId = null; t.karaoke_job = false; t.karaoke_pct = null; t.karaoke_stalled = false; try { renderTracks($('#globalSearch')?.value || ''); } catch {} return; }
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
          if (p !== t.karaoke_pct) { t.karaoke_pct = p; t.karaoke_pct_at = Date.now(); t.karaoke_stalled = false; changed = true; }
        }
        if (pj.stage && pj.stage !== t.karaoke_stage) { t.karaoke_stage = pj.stage; changed = true; }
        if (pj.device_info || pj.device) {
          const lbl = cudaDeviceLabel(pj.device_info, pj.device);
          if (lbl && lbl !== t._karaokeDevLbl) {
            t._karaokeDevLbl = lbl;
            try { if (sepStatus) { sepStatus.textContent = `Separasi berjalan di: ${lbl}`; sepStatus.style.display = 'block'; } } catch {}
          }
        }
        if (!t.karaoke_stalled && Date.now() - (t.karaoke_pct_at || t0) > 15000) {
          t.karaoke_stalled = true; changed = true;
        }
        if (changed) {
          if (!updateKaraokeBadge(t) && Date.now() - lastBadgeRender > 3000) {
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
    if (S.karaokeCancelled) { t.karaoke_job = false; t.karaoke_pct = null; t.karaoke_stalled = false; try { renderTracks($('#globalSearch')?.value || ''); } catch {} return; }
    if (!done) { t.karaoke_job = false; t.karaoke_pct = null; t.karaoke_stalled = false; try { renderTracks($('#globalSearch')?.value || ''); } catch {} throw new Error(failErr || 'separation gagal'); }
    t.karaoke_pct = 100; t.karaoke_stalled = false;
    try { if (!updateKaraokeBadge(t)) rerenderTrackViews(); } catch {}
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
      const savePath = await invokeTauri('save_karaoke', { trackPath: t.path, b64Data: b64, ext });
      t.karaoke_path = savePath;
      try {
        const cuBody = JSON.stringify({ job_id: jobId });
        const cuOpt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuBody };
        await fetch(ENG_BASE + '/separate/cleanup', cuOpt)
          .catch(() => fetch('/api/separate/cleanup', cuOpt).catch(() => {}));
      } catch {}
      t.karaoke_job = false; t.karaoke_pct = null; t.karaoke_stalled = false;
      renderTracks($('#globalSearch')?.value || '');
    } catch {
    }
    const outUrl = URL.createObjectURL(outBlob);
    const wasPlaying2 = !audio.paused;
    const pos2 = audio.currentTime;
    let fallbackOrig = null;
    try { fallbackOrig = convertFileSrc(t.path); } catch {}
    audio.dataset.karaoke = 'true';
    audio.dataset.mode = mode;
    S.karaokeOn = mode === 'karaoke';
    S.vocalOffOn = mode === 'vocal';
    syncKaraokeBtn();
    await switchKaraokeAudio(outUrl, { pos: pos2, wasPlaying: wasPlaying2, fallbackUrl: fallbackOrig });
    t.karaoke_job = false;
    try { renderTracks($('#globalSearch')?.value || ''); } catch {}
    showSep('Karaoke BS-RoFormer selesai', 2500);
    try { refreshCudaStatus().catch(() => {}); } catch {}
  } catch (e) {
    S.karaokeJobId = null;
    try { const tt = S.tracks[S.idx]; if (tt) { tt.karaoke_job = false; tt.karaoke_pct = null; tt.karaoke_stalled = false; } renderTracks($('#globalSearch')?.value || ''); } catch {}
    showSep('Gagal BS-RoFormer: ' + (e?.message || e), 5000);
    try { refreshCudaStatus().catch(() => {}); } catch {}
  } finally {
    syncKaraokeBtn();
  }
  return;
}
$('#btnKaraoke').onclick = (e) => { if (e) e.preventDefault(); separate('karaoke'); };


export { sepStatus, SRC_CAP, SRC_LABEL, showAudioNotice, ENG_BASE, engineHealth, engineInfo, engineGet, karaokeCaps, karaokeCudaLabel, cudaDeviceLabel, refreshCudaStatus, karaokeUploadName, parseEngineError, KARAOKE_STAGE_LABELS, updateKaraokeBadge, rerenderTrackViews, fadeAudioVolume, switchKaraokeAudio, isKaraokeBlocked, syncKaraokeBtn, separate };
