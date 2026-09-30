import { S } from './state.js';
import { $ } from './dom.js';
import { renderTracks, renderDownloads, iphoneTypeOf, loadIPhoneLibrary } from '../app.js';

const SORT_STORE = { local: 'vocalyx_sort_local_v1', downloads: 'vocalyx_sort_downloads_v1', iphone: 'vocalyx_sort_iphone_v1' };
function getSort(view){
  try {
    const j = JSON.parse(localStorage.getItem(SORT_STORE[view]) || 'null');
    if (j && j.key) return { key: j.key, dir: j.dir === 'desc' ? 'desc' : 'asc' };
  } catch {}
  return { key: null, dir: 'asc' };
}
function setSort(view, key, dir){
  try { localStorage.setItem(SORT_STORE[view], JSON.stringify({ key, dir })); } catch {}
}
function cmpStr(a, b){
  return String(a ?? '').localeCompare(String(b ?? ''), 'id', { numeric: true, sensitivity: 'base' });
}
function cmpNum(a, b){
  const x = (a === null || a === undefined || a === '' || !isFinite(Number(a))) ? Infinity : Number(a);
  const y = (b === null || b === undefined || b === '' || !isFinite(Number(b))) ? Infinity : Number(b);
  return x - y;
}
function durToSec(s){
  const m = /^(\d+):([0-5]?\d)$/.exec(String(s || '').trim());
  return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
}
const LOCAL_SORTS = {
  title: (a, b) => cmpStr(a.title, b.title) || cmpStr(a.artist, b.artist),
  type: (a, b) => cmpStr(a.ext, b.ext),
  size: (a, b) => cmpNum(a.size, b.size),
  duration: (a, b) => cmpNum(a.duration ?? durToSec(a.dur), b.duration ?? durToSec(b.dur)),
};
function applyLocalSort(){
  const { key, dir } = getSort('local');
  const fn = key && LOCAL_SORTS[key];
  if (!fn || S.tracks.length < 2) return false;
  const cur = S.tracks[S.idx]?.path;
  const m = S.tracks.map((t, i) => ({ t, i }));
  m.sort((x, y) => fn(x.t, y.t) || (x.i - y.i));
  if (dir === 'desc') m.reverse();
  S.tracks = m.map(x => x.t);
  if (cur !== undefined) { const ni = S.tracks.findIndex(t => t.path === cur); if (ni >= 0) S.idx = ni; }
  return true;
}
const DL_STATUS_RANK = { downloading: 0, queued: 1, waiting: 1, done: 2, failed: 3, cancelled: 4 };
function sortDownloadRows(rows){
  const { key, dir } = getSort('downloads');
  if (!key || rows.length < 2) return;
  const fn = (a, b) => {
    if (key === 'title') return cmpStr(a.d.title, b.d.title) || cmpStr(a.d.artist, b.d.artist);
    if (key === 'type') return cmpStr(a.d.format, b.d.format);
    if (key === 'progress') return cmpNum(a.pct, b.pct);
    if (key === 'status') {
      const ra = DL_STATUS_RANK[String(a.status || '').toLowerCase()] ?? 5;
      const rb = DL_STATUS_RANK[String(b.status || '').toLowerCase()] ?? 5;
      return (ra - rb) || cmpStr(a.status, b.status);
    }
    return 0;
  };
  const m = rows.map((r, i) => ({ r, i }));
  m.sort((x, y) => fn(x.r, y.r) || (x.i - y.i));
  if (dir === 'desc') m.reverse();
  rows.length = 0;
  rows.push(...m.map(x => x.r));
}
function sortIPhoneTracks(){
  const { key, dir } = getSort('iphone');
  if (!key || S.iphoneTracks.length < 2) return;
  const fn = (a, b) => {
    if (key === 'title') return cmpStr(a.title, b.title) || cmpStr(a.artist, b.artist);
    if (key === 'type') return cmpStr(iphoneTypeOf(a), iphoneTypeOf(b));
    if (key === 'size') return cmpNum(a.file_size, b.file_size);
    if (key === 'duration') return cmpNum(a.duration_ms, b.duration_ms);
    return 0;
  };
  const m = S.iphoneTracks.map((t, i) => ({ t, i }));
  m.sort((x, y) => fn(x.t, y.t) || (x.i - y.i));
  if (dir === 'desc') m.reverse();
  S.iphoneTracks.length = 0;
  S.iphoneTracks.push(...m.map(x => x.t));
}
function cycleSort(view, key){
  const cur = getSort(view);
  let next;
  if (cur.key !== key) next = { key, dir: 'asc' };
  else if (cur.dir === 'asc') next = { key, dir: 'desc' };
  else next = { key: null, dir: 'asc' };
  setSort(view, next.key, next.dir);
  try {
    if (view === 'local') { applyLocalSort(); renderTracks($('#globalSearch')?.value || ''); }
    else if (view === 'downloads') renderDownloads();
    else loadIPhoneLibrary();
  } catch {}
  paintSortHeads();
}
function paintSortHeads(){
  const heads = [['tableHead', 'local'], ['downloadTableHead', 'downloads'], ['iphoneTableHead', 'iphone']];
  for (const [id, view] of heads) {
    const head = document.getElementById(id);
    if (!head) continue;
    head.querySelectorAll('.sort-ind').forEach(s => s.remove());
    head.querySelectorAll('[data-sort]').forEach(s => s.classList.remove('sorted'));
    const { key, dir } = getSort(view);
    if (!key) continue;
    const cell = head.querySelector(`[data-sort="${key}"]`);
    if (!cell) continue;
    cell.classList.add('sorted');
    const ind = document.createElement('span');
    ind.className = 'sort-ind';
    ind.textContent = dir === 'desc' ? '▼' : '▲';
    cell.appendChild(ind);
  }
}
for (const [id, view] of [['tableHead', 'local'], ['downloadTableHead', 'downloads'], ['iphoneTableHead', 'iphone']]) {
  document.getElementById(id)?.addEventListener('click', (e) => {
    if (e.target.closest('.resizer') || e.target.closest('input') || e.target.closest('[data-sel-head]') || e.target.closest('[data-iphone-sel-all]')) return;
    const cell = e.target.closest('[data-sort]');
    if (!cell || !cell.dataset.sort) return;
    cycleSort(view, cell.dataset.sort);
  });
}
paintSortHeads();

export { SORT_STORE, getSort, setSort, cmpStr, cmpNum, durToSec, LOCAL_SORTS, applyLocalSort, DL_STATUS_RANK, sortDownloadRows, sortIPhoneTracks, cycleSort, paintSortHeads };
