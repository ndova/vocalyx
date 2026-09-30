export function fmt(s) {
  if (!isFinite(s) || s == null) return '00:00';
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function coverHtml(t) {
  if (t.cover) {
    return `<img src="${t.cover}" alt="cover" class="t-cover" loading="lazy" />`;
  }
  const initial = (t.title?.[0] || t.name?.[0] || '?').toUpperCase();
  const hue = Math.abs(hashStr(t.artist + t.title)) % 360;
  return `<div class="t-cover placeholder" style="background: hsl(${hue} 55% 22%); color: hsl(${hue} 70% 85%);">${initial}</div>`;
}

export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function escAttr(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
