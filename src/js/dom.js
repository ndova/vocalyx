export const $ = (s) => document.querySelector(s);

export const audio = $('#audio');
export const trackListEl = $('#trackList');
export const lyricsEl = $('#lyrics');
export const canvas = $('#waveCanvas');
export const ctx = canvas.getContext('2d');
export const seek = $('#seek');
export const tCur = $('#tCur');
export const tLeft = $('#tLeft');
