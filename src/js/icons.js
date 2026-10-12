import { ico } from './icons-tabler.js';

const _ico = (name, size = 14) => ico(name, size);

const ICON = {
  pencil: ico('pencil'),
  sparkles: ico('sparkles'),
  listPlus: ico('playlist-add'),
  play: ico('player-play-filled'),
  pause: ico('player-pause-filled'),
  x: ico('x'),
  trash: ico('trash'),
  download: ico('download', 16),
  downloadLg: ico('download', 18),
  check: ico('check'),
  music: ico('music', 28),
  musicSm: ico('music'),
  slash: ico('circle-x'),
  plus: ico('plus'),
  chevronRight: ico('chevron-right'),
  upload: ico('upload'),
  folder: ico('folder'),
};
export { _ico, ICON };
