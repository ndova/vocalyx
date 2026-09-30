
export function getMediaSession(){
  try { return ('mediaSession' in navigator) ? navigator.mediaSession : null; }
  catch { return null; }
}

export function setupMediaSession(deps){
  const ms = getMediaSession();
  if (!ms || !deps) return false;
  const table = {
    play: () => deps.play(),
    pause: () => deps.pause(),
    stop: () => (deps.stop || deps.pause)(),
    previoustrack: () => deps.prev(),
    nexttrack: () => deps.next(),
    seekbackward: () => deps.seekBy(-10),
    seekforward: () => deps.seekBy(10),
    seekto: (d) => deps.seekTo(d && d.seekTime),
  };
  for (const [action, fn] of Object.entries(table)) {
    try { ms.setActionHandler(action, fn); } catch {}
  }
  return true;
}

export function clearMediaSession(){
  const ms = getMediaSession();
  if (!ms) return;
  for (const a of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto']) {
    try { ms.setActionHandler(a, null); } catch {}
  }
  try { ms.metadata = null; } catch {}
  try { ms.playbackState = 'none'; } catch {}
}

export function setMediaSessionMeta({ title, artist, album, cover } = {}){
  const ms = getMediaSession();
  if (!ms) return false;
  try {
    if (typeof MediaMetadata === 'undefined') return false;
    ms.metadata = new MediaMetadata({
      title: title || 'Unknown',
      artist: artist || '',
      album: album || '',
      artwork: cover ? [{ src: cover, sizes: '512x512' }] : [],
    });
  } catch { return false; }
  return true;
}

export function setMediaSessionState({ playing, position, duration, rate } = {}){
  const ms = getMediaSession();
  if (!ms) return;
  try { ms.playbackState = playing ? 'playing' : 'paused'; } catch {}
  try {
    if (ms.setPositionState && isFinite(duration) && duration > 0) {
      ms.setPositionState({ duration, playbackRate: rate || 1, position: Math.max(0, position || 0) });
    }
  } catch {}
}
