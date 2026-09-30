import { S } from './state.js';
import { audio, $ } from './dom.js';
import { setMediaSessionState, setMediaSessionMeta, clearMediaSession, setupMediaSession } from './media-session.js';
import { albumKeyOf, ensureTrackForPath, invokeTauri, isTauri, load, pause, play, playlistTracks, plPathIndex, showSep, trackIndexByPath } from '../app.js';

function osMediaSeekBy(sec){
  if (!audio || !isFinite(sec)) return;
  try {
    const d = audio.duration || 0;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + sec), d);
  } catch {}
  pushOsPosition(true);
}
function osMediaSeekTo(pos){
  if (typeof pos !== 'number' || !isFinite(pos)) return;
  try { audio.currentTime = Math.max(0, pos); } catch {}
  pushOsPosition(true);
}
function osMediaNext(){
  if (!S.tracks.length) return;
  const ni = getNextIndex();
  if (ni === -1) return;
  load(ni, true);
}
function osMediaPrev(){
  if (!S.tracks.length) return;
  load(getPrevIndex(), true);
}
const OS_TAP_WINDOW = 500;
const tap = { count: 0, last: 0 };
function tapDecide(count) {
  if (count === 3) return 'prev';
  if (count === 2) return 'next';
  return 'run';
}
function runAction(action) {
  if (action === 'play') play();
  else if (action === 'pause' || action === 'stop') pause();
  else if (action === 'toggle') (audio.paused ? play() : pause());
}
function handleOsMediaAction(action, position){
  if (action === 'play' || action === 'pause' || action === 'toggle') {
    const now = Date.now();
    if (now - tap.last > OS_TAP_WINDOW) tap.count = 0;
    tap.last = now;
    tap.count += 1;
    const d = tapDecide(tap.count);
    if (d === 'next') { osMediaNext(); return; }
    if (d === 'prev') { tap.count = 0; osMediaPrev(); return; }
    if (tap.count > 1) tap.count = 0;
    runAction(action);
    return;
  }
  if (action === 'next' || action === 'prev') { tap.count = 0; tap.last = 0; }
  switch (action) {
    case 'stop': pause(); break;
    case 'next': osMediaNext(); break;
    case 'prev': osMediaPrev(); break;
    case 'seek-fwd': osMediaSeekBy(10); break;
    case 'seek-back': osMediaSeekBy(-10); break;
    case 'seek-by': osMediaSeekBy(position); break;
    case 'seek-to': osMediaSeekTo(position); break;
  }
}
function osDuration(){
  const t = S.tracks[S.idx];
  const td = t && isFinite(t.duration) && t.duration > 0 ? t.duration : 0;
  if (td > 0) return td;
  try { return (audio && isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0; }
  catch { return 0; }
}
async function pushOsState(){
  const playing = !!(audio && audio.src && !audio.paused);
  const pos = (audio && audio.currentTime) || 0;
  if (S._smtcNative && isTauri()) {
    try { await invokeTauri('smtc_set_playback', { playing, positionSecs: pos }); } catch {}
    return;
  }
  try { setMediaSessionState({ playing, position: pos, duration: osDuration(), rate: (audio && audio.playbackRate) || 1 }); } catch {}
}
async function pushOsTrack(){
  const t = S.tracks[S.idx];
  const hasMedia = !!(t && (t.url || t.path));
  if (S._smtcNative && isTauri()) {
    try {
      if (!hasMedia) { await invokeTauri('smtc_set_playback', { playing: false, positionSecs: 0 }); return; }
      await invokeTauri('smtc_set_metadata', { title: t.title || 'Unknown', artist: t.artist || '', album: albumKeyOf(t), cover: t.cover || '', durationSecs: osDuration() });
    } catch {}
    await pushOsState();
    return;
  }
  try {
    if (!hasMedia) { setMediaSessionState({ playing: false }); return; }
    setMediaSessionMeta({ title: t.title || 'Unknown', artist: t.artist || '', album: albumKeyOf(t), cover: t.cover || '' });
  } catch {}
  await pushOsState();
}
function pushOsPosition(force = false){
  if (!S._smtcNative) {
    try { setMediaSessionState({ playing: !audio.paused, position: (audio && audio.currentTime) || 0, duration: osDuration(), rate: (audio && audio.playbackRate) || 1 }); } catch {}
    return;
  }
  if (!isTauri()) return;
  const now = Date.now();
  if (!force && now - S._lastOsPosPush < 3000) return;
  S._lastOsPosPush = now;
  pushOsState();
}
async function initMediaSync(){
  try {
    if (isTauri()) {
      try { S._smtcNative = !!(await invokeTauri('smtc_available')); } catch { S._smtcNative = false; }
    }
  } catch { S._smtcNative = false; }
  if (S._smtcNative) {
    try { clearMediaSession(); } catch {}
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('smtc-button', (ev) => {
        const p = (ev && ev.payload) || {};
        handleOsMediaAction(p.action, p.position);
      });
    } catch {}
  } else {
    try {
      setupMediaSession({
        play: () => handleOsMediaAction('play'),
        pause: () => handleOsMediaAction('pause'),
        next: () => handleOsMediaAction('next'),
        prev: () => handleOsMediaAction('prev'),
        seekBy: (s) => handleOsMediaAction(s < 0 ? 'seek-back' : 'seek-fwd'),
        seekTo: (t) => handleOsMediaAction('seek-to', t),
      });
    } catch {}
  }
  pushOsTrack();
}

$('#btnPlay').onclick = () => (audio.paused ? play() : pause());
function getNextIndex() {
  if (S.playlistPlayback) {
    const pl = S.playlists.find(p=>p.id===S.playlistPlayback.id);
    if (pl && playlistTracks(pl).length) {
      const curPath = S.tracks[S.idx]?.path;
      let pos = plPathIndex(pl, curPath);
      if (pos === -1) pos = -1;
      if (S.isShuffle) {
        if (pl.trackPaths.length===1) return trackIndexByPath(pl.trackPaths[0]);
        let r; do { r = Math.floor(Math.random()*pl.trackPaths.length); } while (r===pos);
        return trackIndexByPath(pl.trackPaths[r]);
      }
      let nextPos = pos + 1;
      if (nextPos >= pl.trackPaths.length) {
        if (S.repeatMode === 'all') nextPos = 0;
        else if (S.repeatMode === 'one') return S.idx;
        else return -1;
      }
      const nextPath = pl.trackPaths[nextPos];
      const ni = trackIndexByPath(nextPath);
      return ni >=0 ? ni : S.idx+1;
    }
  }
  if (S.downloadPlayback) {
    const curPath = S.tracks[S.idx]?.path;
    let pos = S.downloadPlayback.paths.indexOf(curPath);
    if (pos === -1) pos = -1;
    if (S.isShuffle) {
      if (S.downloadPlayback.paths.length===1) return ensureTrackForPath(S.downloadPlayback.paths[0]);
      let r; do { r = Math.floor(Math.random()*S.downloadPlayback.paths.length); } while (r===pos);
      return ensureTrackForPath(S.downloadPlayback.paths[r]);
    }
    let nextPos = pos + 1;
    if (nextPos >= S.downloadPlayback.paths.length) {
      if (S.repeatMode === 'all') nextPos = 0;
      else if (S.repeatMode === 'one') return S.idx;
      else return -1;
    }
    return ensureTrackForPath(S.downloadPlayback.paths[nextPos]);
  }
  for (const cp of [S.albumPlayback, S.artistPlayback]) {
    if (!cp || !cp.paths.length) continue;
    const curPath = S.tracks[S.idx]?.path;
    let pos = cp.paths.indexOf(curPath);
    if (pos === -1) pos = -1;
    if (S.isShuffle) {
      if (cp.paths.length===1) return S.tracks.findIndex(t=>t.path===cp.paths[0]);
      let r; do { r = Math.floor(Math.random()*cp.paths.length); } while (r===pos);
      const ni = S.tracks.findIndex(t=>t.path===cp.paths[r]);
      return ni >=0 ? ni : S.idx;
    }
    let nextPos = pos + 1;
    if (nextPos >= cp.paths.length) {
      if (S.repeatMode === 'all') nextPos = 0;
      else if (S.repeatMode === 'one') return S.idx;
      else return -1;
    }
    const ni = S.tracks.findIndex(t=>t.path===cp.paths[nextPos]);
    return ni >=0 ? ni : S.idx+1;
  }
  if (!S.playlistPlayback && !S.downloadPlayback && !S.albumPlayback && !S.artistPlayback && !S.isShuffle) {
    let ni = S.idx + 1;
    while (ni < S.tracks.length && S.tracks[ni] && S.tracks[ni].fromDownloads) ni++;
    if (ni < S.tracks.length) return ni;
    if (S.repeatMode === 'all') {
      ni = 0;
      while (ni < S.tracks.length && S.tracks[ni] && S.tracks[ni].fromDownloads) ni++;
      if (ni < S.tracks.length) return ni;
    }
    if (S.repeatMode === 'one') return S.idx + 1;
    return -1;
  }
  if (S.isShuffle && S.tracks.length > 1) {
    let r, guard = 0;
    do { r = Math.floor(Math.random() * S.tracks.length); guard++; } while ((r === S.idx || (S.tracks[r] && S.tracks[r].fromDownloads)) && guard < 50);
    if (S.tracks[r] && S.tracks[r].fromDownloads) return S.idx;
    return r;
  }
  return S.idx + 1;
}
function getPrevIndex() {
  if (S.downloadPlayback) {
    const curPath = S.tracks[S.idx]?.path;
    let pos = S.downloadPlayback.paths.indexOf(curPath);
    if (pos === -1) pos = 0;
    if (S.isShuffle) {
      if (S.downloadPlayback.paths.length===1) return ensureTrackForPath(S.downloadPlayback.paths[0]);
      let r; do { r = Math.floor(Math.random()*S.downloadPlayback.paths.length); } while (r===pos);
      return ensureTrackForPath(S.downloadPlayback.paths[r]);
    }
    let prevPos = pos - 1;
    if (prevPos < 0) {
      if (S.repeatMode === 'all') prevPos = S.downloadPlayback.paths.length -1;
      else return S.idx;
    }
    return ensureTrackForPath(S.downloadPlayback.paths[prevPos]);
  }
  for (const cp of [S.albumPlayback, S.artistPlayback]) {
    if (!cp || !cp.paths.length) continue;
    const curPath = S.tracks[S.idx]?.path;
    let pos = cp.paths.indexOf(curPath);
    if (pos === -1) pos = 0;
    if (S.isShuffle) {
      if (cp.paths.length===1) return S.tracks.findIndex(t=>t.path===cp.paths[0]);
      let r; do { r = Math.floor(Math.random()*cp.paths.length); } while (r===pos);
      const pi = S.tracks.findIndex(t=>t.path===cp.paths[r]);
      return pi >=0 ? pi : S.idx;
    }
    let prevPos = pos - 1;
    if (prevPos < 0) {
      if (S.repeatMode === 'all') prevPos = cp.paths.length -1;
      else return S.idx;
    }
    const pi = S.tracks.findIndex(t=>t.path===cp.paths[prevPos]);
    return pi >=0 ? pi : S.idx-1;
  }
  if (S.playlistPlayback) {
    const pl = S.playlists.find(p=>p.id===S.playlistPlayback.id);
    if (pl && playlistTracks(pl).length) {
      const curPath = S.tracks[S.idx]?.path;
      let pos = plPathIndex(pl, curPath);
      if (pos === -1) pos = 0;
      if (S.isShuffle) {
        if (pl.trackPaths.length===1) return trackIndexByPath(pl.trackPaths[0]);
        let r; do { r = Math.floor(Math.random()*pl.trackPaths.length); } while (r===pos);
        return trackIndexByPath(pl.trackPaths[r]);
      }
      let prevPos = pos - 1;
      if (prevPos < 0) {
        if (S.repeatMode === 'all') prevPos = pl.trackPaths.length -1;
        else return S.idx;
      }
      const prevPath = pl.trackPaths[prevPos];
      const pi = trackIndexByPath(prevPath);
      return pi >=0 ? pi : S.idx-1;
    }
  }
  if (S.isShuffle && S.tracks.length > 1) {
    let r, guard = 0;
    do { r = Math.floor(Math.random() * S.tracks.length); guard++; } while ((r === S.idx || (S.tracks[r] && S.tracks[r].fromDownloads)) && guard < 50);
    if (S.tracks[r] && S.tracks[r].fromDownloads) return S.idx;
    return r;
  }
  let pi = S.idx - 1;
  while (pi >= 0 && S.tracks[pi] && S.tracks[pi].fromDownloads) pi--;
  if (pi >= 0) return pi;
  pi = S.tracks.length - 1;
  while (pi >= 0 && S.tracks[pi] && S.tracks[pi].fromDownloads) pi--;
  return pi >= 0 ? pi : S.idx;
}
$('#btnNext').onclick = () => { if (!S.tracks.length) return; const ni = getNextIndex(); if (ni===-1) return; load(ni, true); };
$('#btnPrev').onclick = () => { if (!S.tracks.length) return; const pi = getPrevIndex(); load(pi, true); };
$('#btnShuffle').onclick = () => {
  S.isShuffle = !S.isShuffle;
  $('#btnShuffle').classList.toggle('active', S.isShuffle);
  showSep(S.isShuffle ? 'Shuffle: ON' : 'Shuffle: OFF', 1500);
};
const btnRepeat = $('#btnRepeat');
if (btnRepeat) {
  btnRepeat.onclick = () => {
    S.repeatMode = S.repeatMode === 'off' ? 'all' : S.repeatMode === 'all' ? 'one' : 'off';
    btnRepeat.classList.toggle('active', S.repeatMode !== 'off');
    btnRepeat.classList.toggle('repeat-one', S.repeatMode === 'one');
    btnRepeat.title = S.repeatMode === 'off' ? 'Repeat Off' : S.repeatMode === 'all' ? 'Repeat All' : 'Repeat One';
    showSep(S.repeatMode === 'off' ? 'Repeat: OFF' : S.repeatMode === 'all' ? 'Repeat: ALL' : 'Repeat: ONE', 1500);
  };
}

export { osMediaSeekBy, osMediaSeekTo, osMediaNext, osMediaPrev, handleOsMediaAction, pushOsState, pushOsTrack, pushOsPosition, initMediaSync, getNextIndex, getPrevIndex, btnRepeat, tapDecide };
