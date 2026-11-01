import { S } from './state.js';

const IPH_COVER_MAX_CONCURRENT = 4;
const IPH_COVER_EAGER_FIRST = 12;
const IPH_COVER_REFRESH_FIRST = 24;

let _iphCoverQueue = [];
let _iphCoverActive = 0;

function _iphCoverUrl(el) {
  return `http://127.0.0.1:8001/iphone/track/cover?item_pid=${el.dataset.iphCover}&v=${el.dataset.iphCoverV || 0}`;
}

function _iphCoverPending(el) {
  return !!el && el.isConnected && !el.dataset.iphCoverDone && !el.dataset.iphCoverFailed && !el.dataset.iphCoverLoading;
}

function _pumpIphCoverQueue() {
  while (_iphCoverActive < IPH_COVER_MAX_CONCURRENT && _iphCoverQueue.length) {
    const el = _iphCoverQueue.shift();
    if (!_iphCoverPending(el)) continue;
    el.dataset.iphCoverLoading = '1';
    _iphCoverActive++;
    const img = new Image();
    img.className = 't-cover';
    img.alt = 'cover';
    img.onload = () => {
      _iphCoverActive--;
      delete el.dataset.iphCoverLoading;
      if (el.isConnected) {
        el.dataset.iphCoverDone = '1';
        el.replaceWith(img);
      }
      _pumpIphCoverQueue();
    };
    img.onerror = () => {
      _iphCoverActive--;
      delete el.dataset.iphCoverLoading;
      el.dataset.iphCoverFailed = '1';
      _pumpIphCoverQueue();
    };
    img.src = _iphCoverUrl(el);
  }
}

function _queueIphCover(el) {
  if (!_iphCoverPending(el) || _iphCoverQueue.includes(el)) return;
  _iphCoverQueue.push(el);
  _pumpIphCoverQueue();
}

export function setupIPhoneCoverLazy(root) {
  if (S._iphCoverObs) { S._iphCoverObs.disconnect(); S._iphCoverObs = null; }
  if (!root) return;
  const pend = [...root.querySelectorAll('[data-iph-cover]')]
    .filter((el) => !el.dataset.iphCoverDone && !el.dataset.iphCoverFailed);
  pend.slice(0, IPH_COVER_EAGER_FIRST).forEach(_queueIphCover);
  const rest = pend.slice(IPH_COVER_EAGER_FIRST);
  if (!rest.length) return;
  if (!('IntersectionObserver' in window)) {
    rest.forEach(_queueIphCover);
    return;
  }
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      obs.unobserve(el);
      _queueIphCover(el);
    }
  }, { root, rootMargin: '120px' });
  rest.forEach((el) => obs.observe(el));
  S._iphCoverObs = obs;
}

export function refreshIPhoneCovers() {
  const roots = [
    document.getElementById('iphoneTrackList'),
    document.getElementById('videoTrackList'),
  ].filter(Boolean);
  if (!roots.length) return;
  const pend = roots
    .flatMap((r) => [...r.querySelectorAll('[data-iph-cover]')])
    .filter(_iphCoverPending);
  if (!pend.length) return;
  try {
    const vh = window.innerHeight || 0;
    pend.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const va = (ra.top < vh && ra.bottom > 0) ? 0 : 1;
      const vb = (rb.top < vh && rb.bottom > 0) ? 0 : 1;
      return va - vb || ra.top - rb.top;
    });
  } catch {}
  pend.slice(0, IPH_COVER_REFRESH_FIRST).forEach(_queueIphCover);
  const rest = pend.slice(IPH_COVER_REFRESH_FIRST);
  if (S._iphCoverObs) {
    rest.forEach((el) => {
      try { S._iphCoverObs.observe(el); } catch {}
    });
  } else {
    rest.forEach(_queueIphCover);
  }
}
