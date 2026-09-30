const TIME_SRC = '\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?\\]';
const TIME_RE = new RegExp(TIME_SRC, 'g');
const WORD_SRC = '<(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?>';
const WORD_RE = new RegExp(WORD_SRC, 'g');
const HEAD_RE = /^\[(ar|ti|al|by|length|offset|re|ve):/i;
const HEAD_ONLY_RE = /^\[[^\]]+\]\s*$/;
const PLAIN_T = 99999;
const NO_SYNC = 'No synced lyrics — lirik akan di-download dari LRCLIB atau simpan .lrc di Lyrics/';

export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripWordTags(s) {
  return String(s == null ? '' : s).replace(new RegExp(WORD_SRC, 'g'), '').replace(/[ \t]{2,}/g, ' ').trim();
}

export function hasWordTags(s) {
  return new RegExp(WORD_SRC).test(String(s == null ? '' : s));
}

export function defaultLyrics() {
  return [{ t: 0, x: NO_SYNC, d: NO_SYNC }];
}

function fracToSec(f) {
  if (f == null) return 0;
  if (f.length === 1) return parseInt(f, 10) / 10;
  if (f.length === 2) return parseInt(f, 10) / 100;
  return parseInt(f, 10) / 1000;
}

function mkLine(t, bodyRaw) {
  const disp = stripWordTags(bodyRaw);
  return { t, x: bodyRaw || '♪', d: disp || '♪' };
}

function parseInto(raw, doSort, keepUntimed) {
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').replace(/\r/g, '');
  const offMatch = text.match(/\[offset:([+-]?\d+)\]/i);
  const offsetMs = offMatch ? parseInt(offMatch[1], 10) : 0;
  const out = [];
  const unsynced = [];
  for (const row of text.split('\n')) {
    const line = row.trim();
    if (!line) continue;
    if (HEAD_RE.test(line) && HEAD_ONLY_RE.test(line)) continue;
    const times = [];
    const re = new RegExp(TIME_SRC, 'g');
    let m;
    while ((m = re.exec(line)) !== null) {
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + fracToSec(m[3]) + offsetMs / 1000;
      times.push(t < 0 ? 0 : t);
    }
    const body = line.replace(new RegExp(TIME_SRC, 'g'), '').trim();
    if (times.length > 0) {
      for (const t of times) out.push(mkLine(t, body));
    } else if (body) {
      if (keepUntimed) out.push({ t: PLAIN_T, x: body, d: stripWordTags(body), u: 1 });
      else unsynced.push(body);
    }
  }
  if (out.length) {
    if (doSort) out.sort((a, b) => a.t - b.t);
    return out;
  }
  if (unsynced.length) {
    return unsynced.map((x, i) => ({ t: i === 0 ? 0 : PLAIN_T, x, d: stripWordTags(x) }));
  }
  return defaultLyrics();
}

export function parseLRC(raw) {
  return parseInto(raw, true, false);
}

export function parseLRCOrdered(raw) {
  return parseInto(raw, false, false);
}

export function parseLRCForEdit(raw) {
  return parseInto(raw, false, true);
}

export function isSynced(lines) {
  return Array.isArray(lines) && lines.length > 0 && lines.some((l) => l.t > 0 && l.t < PLAIN_T);
}

export function formatLrcTime(t) {
  const tt = Math.max(0, t);
  const m = Math.floor(tt / 60);
  const s = Math.floor(tt % 60);
  const cs = Math.floor((tt - Math.floor(tt)) * 100);
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}

export function formatLrcTimeRounded(t) {
  const total = Math.round(Math.max(0, Number.isFinite(t) ? t : 0) * 100);
  const m = Math.floor(total / 6000);
  const s = Math.floor((total % 6000) / 100);
  const cs = total % 100;
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}

export function formatClock(sec) {
  const tt = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(tt / 60);
  const s = Math.floor(tt % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatStamp(sec) {
  const tt = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(tt / 60);
  const s = Math.floor(tt % 60);
  const cs = Math.floor((tt - Math.floor(tt)) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function lyricLinesToLrc(lines) {
  return (lines || [])
    .filter(l => l && typeof l.t === 'number' && Number.isFinite(l.t) && l.t < PLAIN_T && l.x)
    .map(l => `${formatLrcTime(l.t)}${l.x}`)
    .join('\n');
}

export function extractHeaders(raw) {
  const out = [];
  String(raw == null ? '' : raw).replace(/\r/g, '').split('\n').forEach((row) => {
    const tr = row.trim();
    if (HEAD_RE.test(tr) && HEAD_ONLY_RE.test(tr)) out.push(tr);
  });
  return out;
}

function serializeEditor(lines, headers) {
  const body = lines.map((l) => {
    if (!l) return '';
    const txt = l.x == null ? '' : String(l.x);
    if (typeof l.t !== 'number' || !Number.isFinite(l.t) || l.t >= PLAIN_T) return txt;
    return `${formatLrcTimeRounded(l.t)}${txt}`;
  }).filter((s) => s !== '');
  return [...headers, ...body].join('\n');
}

export function setLrcLineTime(raw, idx, sec) {
  const parsed = parseLRCForEdit(raw);
  if (idx < 0 || idx >= parsed.length) return raw;
  const headers = extractHeaders(raw);
  parsed[idx] = { ...parsed[idx], t: Math.max(0, sec), u: 0 };
  return serializeEditor(parsed, headers);
}

export function nudgeLrcLine(raw, idx, deltaMs) {
  const parsed = parseLRCForEdit(raw);
  if (idx < 0 || idx >= parsed.length) return raw;
  const l = parsed[idx];
  if (typeof l.t !== 'number' || !Number.isFinite(l.t) || l.t >= PLAIN_T) return raw;
  const headers = extractHeaders(raw);
  parsed[idx] = { ...l, t: Math.max(0, l.t + deltaMs / 1000) };
  return serializeEditor(parsed, headers);
}

export function nudgeLrcFromIndex(raw, fromIdx, deltaMs) {
  const parsed = parseLRCForEdit(raw);
  if (fromIdx < 0 || fromIdx >= parsed.length) return raw;
  const headers = extractHeaders(raw);
  const out = parsed.map((l, i) => {
    if (i < fromIdx) return l;
    if (typeof l.t !== 'number' || !Number.isFinite(l.t) || l.t >= PLAIN_T) return l;
    return { ...l, t: Math.max(0, l.t + deltaMs / 1000) };
  });
  return serializeEditor(out, headers);
}

export function resetLrcLine(raw, idx) {
  return setLrcLineTime(raw, idx, 0);
}

export function setLrcLineText(raw, idx, text) {
  const parsed = parseLRCForEdit(raw);
  if (idx < 0 || idx >= parsed.length) return raw;
  const headers = extractHeaders(raw);
  const clean = String(text == null ? '' : text).replace(/\r?\n/g, ' ').trim();
  parsed[idx] = { ...parsed[idx], x: clean, d: clean };
  return serializeEditor(parsed, headers);
}

export function removeLrcLine(raw, idx) {
  const parsed = parseLRCForEdit(raw);
  if (idx < 0 || idx >= parsed.length) return raw;
  const headers = extractHeaders(raw);
  parsed.splice(idx, 1);
  return serializeEditor(parsed, headers);
}

export function insertLrcLineAfter(raw, idx, sec, text) {
  const parsed = parseLRCForEdit(raw);
  if (idx < -1 || idx >= parsed.length) return raw;
  const headers = extractHeaders(raw);
  const at = idx + 1;
  const clean = String(text == null ? '' : text).replace(/\r?\n/g, ' ').trim();
  parsed.splice(at, 0, { t: Math.max(0, sec), x: clean, d: clean });
  return serializeEditor(parsed, headers);
}

export function shiftLrcByOffset(raw, deltaMs) {
  if (!deltaMs || !raw || !raw.trim()) return raw;
  const parsed = parseLRC(raw);
  if (!parsed.length || parsed.every(l => l.t === 0)) return raw;
  const headers = [];
  String(raw).replace(/\r/g, '').split('\n').forEach((line) => {
    const tr = line.trim();
    if (/^\[(ar|ti|al|by|length|re|ve):/i.test(tr)) headers.push(tr);
  });
  const shifted = parsed
    .filter(l => typeof l.t === 'number' && Number.isFinite(l.t) && l.t < PLAIN_T)
    .map(l => ({ t: Math.max(0, l.t + deltaMs / 1000), x: l.x }))
    .sort((a, b) => a.t - b.t)
    .map(l => `${formatLrcTime(l.t)}${l.x || '♪'}`);
  return [...headers, ...shifted].join('\n');
}

export function applyOffsetToAllLines(raw, offsetMs) {
  if (!offsetMs) return raw;
  return nudgeLrcFromIndex(raw, 0, offsetMs);
}
