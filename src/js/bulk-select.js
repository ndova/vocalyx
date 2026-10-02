import { S } from './state.js';
import { $ } from './dom.js';
import { renderDownloads } from './downloads.js';
import { renderTracks } from '../app.js';

export function selKeyDL(d){ return d.path ? 'p:'+d.path : 'id:'+(d.id||''); }
function selKeyLocal(path){ return path ? 'p:'+path : ''; }
const SELECT_BTN = { local:'btnSelectLocal', downloads:'btnSelectDownloads' };
const VISIBLE = { local:'_visibleLocal', downloads:'_visibleDL' };
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
  const btnId = SELECT_BTN[scope];
  if (!btnId) return;
  S.selectMode[scope] = !!on;
  if (!S.selectMode[scope]) S.selectedPaths[scope].clear();
  document.getElementById(btnId)?.classList.toggle('active-sel', S.selectMode[scope]);
  syncSelHeader(scope);
}
export function syncSelHeader(scope){
  const cell = document.querySelector(`[data-sel-head="${scope}"]`);
  if (!cell) return;
  cell.classList.toggle('sel-on', !!S.selectMode[scope]);
}
function toggleSelHead(scope, reRender){
  const on = S.selectMode[scope];
  const set = S.selectedPaths[scope];
  const vis = S[VISIBLE[scope]] || [];
  if (!on) {
    setSelectMode(scope, true);
    vis.forEach(k=>set.add(k));
  } else {
    const all = vis.length > 0 && vis.every(k=>set.has(k));
    if (all) vis.forEach(k=>set.delete(k));
    else vis.forEach(k=>set.add(k));
  }
  syncSelHeader(scope);
  if (typeof reRender === 'function') reRender();
}
document.querySelector('[data-sel-head="local"]')?.addEventListener('click', ()=>toggleSelHead('local', () => renderTracks($('#globalSearch')?.value || '')));
document.querySelector('[data-sel-head="downloads"]')?.addEventListener('click', ()=>toggleSelHead('downloads', () => renderDownloads()));
export { selKeyLocal, toggleSelLocal, toggleSelHead };
