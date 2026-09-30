import { TABLER } from '../icons/tabler/index.js';

const PAINT_OUTLINE = 'fill="none" stroke="currentColor"';
const PAINT_FILLED = 'fill="currentColor" stroke="currentColor"';
const GEOM = 'viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export function ico(name, size = 14) {
  const body = TABLER[name];
  if (!body) return '';
  const paint = name.endsWith('-filled') ? PAINT_FILLED : PAINT_OUTLINE;
  return `<svg class="ico" width="${size}" height="${size}" ${GEOM} ${paint} aria-hidden="true">${body}</svg>`;
}

export function iconBody(name) {
  return TABLER[name] || '';
}

export function hydrateIcons(root) {
  if (!root) return 0;
  const nodes = Array.from(root.querySelectorAll('[data-ico]'));
  let filled = 0;
  for (const el of nodes) {
    const name = el.getAttribute('data-ico');
    const body = TABLER[name];
    if (!body) continue;
    if (name.endsWith('-filled')) {
      el.setAttribute('fill', 'currentColor');
      el.setAttribute('stroke', 'currentColor');
    }
    el.innerHTML = body;
    el.removeAttribute('data-ico');
    filled++;
  }
  return filled;
}

export const TABLER_NAMES = Object.keys(TABLER);
