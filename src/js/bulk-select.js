import { S } from './state.js';
import { $ } from './dom.js';
import { renderDownloads } from './downloads.js';
import { renderTracks } from '../app.js';

export function selKeyDL(d){ return d.path ? 'p:'+d.path : 'id:'+(d.id||''); }
function selKeyLocal(path){ return path ? 'p:'+path : ''; }
function toggleSelLocal(path){
  if (!path) return;
  const k = selKeyLocal(path);
  if (S.selectedPaths.local.has(k)) S.selectedPaths.local.delete(k);
  else S.selectedPaths.local.add(k);
  renderTracks($('#globalSearch')?.value || '');
}
export function toggleSelDL(d){
  const k = selKeyDL(d);
  if (S.selectedPaths.downloads.has(k)) S.selectedPaths.downloads.delete(k);
  else S.selectedPaths.downloads.add(k);
  renderDownloads();
}
export function setSelectMode(scope, on){
  if (scope === 'local') {
    S.selectMode.local = !!on;
    if (!S.selectMode.local) S.selectedPaths.local.clear();
    document.getElementById('btnSelectLocal')?.classList.toggle('active-sel', S.selectMode.local);
  } else {
    S.selectMode.downloads = !!on;
    if (!S.selectMode.downloads) S.selectedPaths.downloads.clear();
    document.getElementById('btnSelectDownloads')?.classList.toggle('active-sel', S.selectMode.downloads);
  }
  syncSelHeader(scope);
}
export function syncSelHeader(scope){
  const cell = document.querySelector(scope === 'local' ? '[data-sel-head="local"]' : '[data-sel-head="downloads"]');
  if (!cell) return;
  const on = scope === 'local' ? S.selectMode.local : S.selectMode.downloads;
  cell.classList.toggle('sel-on', !!on);
}
function toggleSelHead(scope){
  const on = scope === 'local' ? S.selectMode.local : S.selectMode.downloads;
  const set = scope === 'local' ? S.selectedPaths.local : S.selectedPaths.downloads;
  const vis = scope === 'local' ? S._visibleLocal : S._visibleDL;
  if (!on) {
    setSelectMode(scope, true);
    vis.forEach(k=>set.add(k));
  } else {
    const all = vis.length > 0 && vis.every(k=>set.has(k));
    if (all) vis.forEach(k=>set.delete(k));
    else vis.forEach(k=>set.add(k));
  }
  if (scope === 'local') renderTracks($('#globalSearch')?.value || '');
  else renderDownloads();
}
document.querySelector('[data-sel-head="local"]')?.addEventListener('click', ()=>toggleSelHead('local'));
document.querySelector('[data-sel-head="downloads"]')?.addEventListener('click', ()=>toggleSelHead('downloads'));
export { selKeyLocal, toggleSelLocal, toggleSelHead };
