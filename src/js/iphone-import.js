import { S } from './state.js';
import { showToast } from './engine.js';
import { showModal } from './modal.js';
import { isTauri } from './tauri.js';
import { readCoverPathDrop } from './download-start.js';
import { loadIPhoneLibrary } from './iphone.js';



export const AUDIO_EXT_RE = /\.(m4a|mp3|flac|wav|ogg|aac|wma)$/i;

function parseAudioMeta(filename) {
  let title = filename.replace(/\.[^.]+$/, '');
  let artist = 'Unknown', album = 'Unknown';
  const m = title.match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  return { title, artist, album };
}


function normKey(s) {
  return (s || '').trim().toLowerCase();
}

function dropPositionOverList(position) {
  try {
    const zone = document.getElementById('viewDevice') || document.getElementById('iphoneTrackList');
    if (!zone || !position) return false;
    const r = zone.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const dpr = window.devicePixelRatio || 1;
    const x = position.x / dpr, y = position.y / dpr;
    const m = 8;
    return x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m;
  } catch { return false; }
}

export async function handleLibraryDrop(paths) {
  const all = paths || [];
  const audio = all.filter(p => AUDIO_EXT_RE.test(p));
  if (all.length > audio.length) {
    showToast(`${all.length - audio.length} file dilewatkan (bukan audio)`, 3000);
  }
  if (!audio.length) { showToast('Tidak ada file audio yang di-drop', 3000); return; }
  if (S._prevIPhoneConnected === false) { showToast('iPhone tidak terhubung — hubungkan via USB dulu', 4000); return; }
  if (S.importRunning) { showToast('Tunggu import yang berjalan selesai', 4000); return; }
  const entries = audio.map(p => {
    const basename = p.split(/[\\/]/).pop() || p;
    return { path: p, ...parseAudioMeta(basename) };
  });
  const libKeyToPid = new Map();
  for (const t of S.iphoneTracks) {
    libKeyToPid.set(normKey(t.title) + '\0' + normKey(t.artist), String(t.item_pid));
  }
  const dupEntries = [], freshEntries = [], dupPids = [];
  const libSizeToPid = new Map();
  for (const t of S.iphoneTracks) {
    if (t.file_size > 0 && !libSizeToPid.has(t.file_size)) libSizeToPid.set(t.file_size, String(t.item_pid));
  }
  const seenPid = new Set();
  const rememberPid = (pid) => { const n = Number(pid); if (!seenPid.has(n)) { seenPid.add(n); dupPids.push(n); } };
  try {
    const { stat } = await import('@tauri-apps/plugin-fs');
    for (const e of entries) {
      try {
        const st = await stat(e.path);
        e._size = (st && typeof st.size === 'number') ? st.size : null;
      } catch { e._size = null; }
    }
  } catch { for (const e of entries) e._size = null; }
  for (const e of entries) {
    const a = normKey(e.artist);
    if (e._size != null) {
      const sp = libSizeToPid.get(e._size);
      if (sp) { dupEntries.push(e); rememberPid(sp); continue; }
    }
    if (!a || a === 'unknown') { freshEntries.push(e); continue; }
    const pid = libKeyToPid.get(normKey(e.title) + '\0' + a);
    if (pid) { dupEntries.push(e); rememberPid(pid); }
    else freshEntries.push(e);
  }
  let deletePids = [];
  if (dupEntries.length) {
    const names = dupEntries.map(f => f.title).slice(0, 3).join(', ') + (dupEntries.length > 3 ? ` dan ${dupEntries.length - 3} lainnya` : '');
    const replace = await showModal({
      title: 'Lagu Duplikat',
      message: `${dupEntries.length} file sudah ada di iPhone (${names}). Ganti yang lama?`,
      confirmText: 'Ganti', cancelText: 'Keduanya',
    });
    if (replace == null) return;
    if (replace) deletePids = dupPids;
  }
  S.importQueue = [...freshEntries, ...dupEntries];
  await startIPhoneImport(deletePids);
}

if (isTauri()) {
  (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      await win.onDragDropEvent((event) => {
        const dev = document.getElementById('viewDevice');
        if (dev && S.activeView === 'device') {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            const over = event.payload.type === 'enter' || dropPositionOverList(event.payload.position);
            dev.style.outline = over ? '2px dashed var(--accent)' : '';
            dev.style.outlineOffset = '-2px';
          } else if (event.payload.type === 'leave' || event.payload.type === 'drop') {
            dev.style.outline = '';
          }
        }
        if (event.payload.type !== 'drop' || !event.payload.paths.length) return;
        const paths = event.payload.paths;
        try {
          const cz = window.__activeCoverDrop;
          if (cz && cz.zone && cz.zone.isConnected && event.payload.position) {
            const r = cz.zone.getBoundingClientRect();
            if (r.width && r.height) {
              const dpr = window.devicePixelRatio || 1;
              const x = event.payload.position.x / dpr, y = event.payload.position.y / dpr;
              if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8) {
                (async () => {
                  const hit = paths.find(p => /\.(jpe?g|png|webp)$/i.test(p));
                  if (!hit) { showToast('File bukan gambar (jpg/png/webp)', 3000); return; }
                  const url = await readCoverPathDrop(hit);
                  if (url && window.__activeCoverDrop === cz) { try { cz.onPick(url); } catch {} }
                })().catch(() => {});
                return;
              }
            }
          }
        } catch {}
        if (S.activeView === 'device' && dropPositionOverList(event.payload.position)) {
          handleLibraryDrop(paths).catch(() => {});
        } else if (S.activeView === 'device') {
          showToast('Drop file musik di area Device untuk import ke iPhone', 3500);
        }
      });
    } catch {}
  })();
}



const iphoneTrackListEl = document.getElementById('iphoneTrackList');
if (iphoneTrackListEl) {
  iphoneTrackListEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    iphoneTrackListEl.style.outline = '2px dashed var(--accent)';
    iphoneTrackListEl.style.outlineOffset = '-2px';
  });
  iphoneTrackListEl.addEventListener('dragleave', () => { iphoneTrackListEl.style.outline = ''; });
  iphoneTrackListEl.addEventListener('drop', (e) => { e.preventDefault(); iphoneTrackListEl.style.outline = ''; });
}


function setImportProgress(pct, text) {
  const bar = document.getElementById('importProgressBar');
  const fill = document.getElementById('importProgressFill');
  const txt = document.getElementById('importProgressText');
  const cancel = document.getElementById('btnCancelImport');
  if (bar) bar.style.display = pct >= 0 ? '' : 'none';
  if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  if (txt) txt.textContent = text || '';
  if (cancel) cancel.style.display = pct >= 0 && pct < 100 && S.importRunning ? '' : 'none';
}

async function startIPhoneImport(deletePids = []) {
  if (!S.importQueue.length || S.importRunning) return;
  S.importRunning = true;
  const total = S.importQueue.length;
  setImportProgress(0, `0% — Import 0/${total}`);
  showToast(`Mengupload ${total} lagu ke iPhone...`, 3000);

  const files = S.importQueue.map(f => ({ path: f.path, title: f.title, artist: f.artist, album: f.album }));
  try {
    const res = await fetch('http://127.0.0.1:8001/iphone/import_batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, delete_pids: deletePids }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '');
    S.importJobId = j.job_id;
    S.importQueue = [];
    pollImportProgress();
  } catch (e) {
    showToast('Import gagal: ' + e.message, 4000);
    S.importRunning = false;
    setImportProgress(-1, '');
  }
}

document.getElementById('btnCancelImport')?.addEventListener('click', async () => {
  if (!S.importJobId) return;
  try {
    await fetch('http://127.0.0.1:8001/iphone/import_cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: S.importJobId }),
    });
  } catch {}
});

function pollImportProgress() {
  if (S.importPollTimer) clearInterval(S.importPollTimer);
  S.importPollTimer = setInterval(async () => {
    if (!S.importJobId) return;
    try {
      const res = await fetch('http://127.0.0.1:8001/iphone/import_progress?job_id=' + S.importJobId);
      const j = await res.json();
      if (!j.ok) return;
      if (j.status === 'done') {
        clearInterval(S.importPollTimer);
        S.importPollTimer = null;
        S.importRunning = false;
        S.importJobId = null;
        setImportProgress(100, '100% Selesai');
        showToast(`${j.done} lagu diimport — force-quit lalu buka lagi app Music iPhone`, 6000);
        if (S.activeView === 'device') { try { loadIPhoneLibrary(); } catch {} }
        setTimeout(() => setImportProgress(-1, ''), 4000);
      } else if (j.status === 'error') {
        clearInterval(S.importPollTimer);
        S.importPollTimer = null;
        S.importRunning = false;
        S.importJobId = null;
        setImportProgress(0, 'Error: ' + (j.error || 'Unknown'));
        showToast('Import error: ' + j.error, 5000);
        setTimeout(() => setImportProgress(-1, ''), 4000);
      } else if (j.status === 'cancelled') {
        clearInterval(S.importPollTimer);
        S.importPollTimer = null;
        S.importRunning = false;
        S.importJobId = null;
        setImportProgress(0, 'Dibatalkan');
        showToast('Import dibatalkan', 3000);
        setTimeout(() => setImportProgress(-1, ''), 2000);
      } else {
        const total = j.total || 1, done = j.done || 0;
        const pct = j.pct || 0;
        const delTotal = j.delete_total || 0;
        const delDone = j.delete_done || 0;
        if (j.phase === 'delete' && delTotal) {
          const cur = j.current ? ` — ${j.current}` : ` — Menghapus ${delDone}/${delTotal}`;
          setImportProgress(pct, `${pct}%${cur}`);
        } else {
          const cur = j.current ? ` — ${j.current}` : '';
          const delPart = delTotal && delDone < delTotal
            ? ` • hapus ${delDone}/${delTotal}` : '';
          setImportProgress(pct, `${pct}% — Import ${done}/${total}${delPart}${cur}`);
        }
      }
    } catch {}
  }, 800);
}
export { parseAudioMeta, normKey, dropPositionOverList, iphoneTrackListEl, setImportProgress, startIPhoneImport, pollImportProgress };
