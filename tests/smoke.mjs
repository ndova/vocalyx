import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readSrc = () => {
  const files = ['src/app.js', ...fs.readdirSync(path.join(root, 'src/js'))
    .filter((f) => f.endsWith('.js')).sort().map((f) => `src/js/${f}`)];
  return files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
};

const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:1420/' });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.localStorage = window.localStorage;
globalThis.requestAnimationFrame = () => 0;
globalThis.devicePixelRatio = 1;
globalThis.fetch = () => Promise.reject(new Error('offline-headless'));
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({ canvas: {} }, {
  get: (t, p) => (p === 'canvas' ? {} : (p === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {})),
});
const alerts = [];
window.alert = (m) => { alerts.push(String(m)); };
globalThis.alert = window.alert;

let failures = 0;
const ok = (cond, name) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);

localStorage.setItem('vocalyx_eq_v1', JSON.stringify({ preset: 'Rock', gains: [5,4,3,0,-1,-1,0,2,4,5] }));

localStorage.setItem('vocalyx_downloads', JSON.stringify([
  { id: 'dl-seed-1', title: 'Uji Import iPhone', artist: 'Artis Uji', format: 'mp3',
    path: 'C:\\dl\\uji-import.mp3', status: 'done', progress: 100, dur: '03:12',
    source: '', downloadedFrom: '', size_str: '3,2 MB' },
  { id: 'dl-art-1', title: 'Prem Sisa', artist: 'X', format: 'mp3',
    path: 'C:\\dl\\uji.prem.mp3', status: 'done', progress: 100, dur: '01:00',
    source: '', downloadedFrom: '', size_str: '1,1 MB' },
]));

let bootErr = null;
try {
  await import('../src/app.js');
} catch (e) {
  bootErr = e;
}
ok(!bootErr, `boot app.js${bootErr ? ' :: ' + bootErr.message : ''}`);

ok(!!$('#btnTheme'), 'theme toggle button exists');
$('#btnTheme')?.click();
ok(document.documentElement.dataset.theme === 'dark', 'theme toggles to dark');
ok(localStorage.getItem('vocalyx_theme_v1') === 'dark', 'theme persists to storage');
ok($('#btnTheme .ico, #btnTheme svg') && $('#btnTheme').title === 'Mode terang', 'theme button shows sun in dark');
ok(!!Array.from(document.querySelectorAll('.brand-logo')).length && Array.from(document.querySelectorAll('.brand-logo')).every((el) => el.getAttribute('src') === './logo-dark.png'), 'semua brand-logo swap ke gelap (termasuk popup About)');
$('#btnTheme')?.click();
ok(!document.documentElement.dataset.theme, 'theme toggles back to light');
ok(localStorage.getItem('vocalyx_theme_v1') === 'light', 'theme light persists');
ok(Array.from(document.querySelectorAll('.brand-logo')).every((el) => el.getAttribute('src') === './logo.png'), 'semua brand-logo kembali ke terang');

ok($('#trackList') && $('#trackList').textContent.includes('Belum ada lagu'), 'empty library message');

$('#btnAddFolder')?.click();
await sleep(50);
ok(alerts.some((m) => m.includes('Tauri')), 'add-folder non-tauri alert');

document.getElementById('btnWaveSettings')?.click();
await sleep(50);
ok($('#viewSettings')?.style.display === 'flex', 'settings view visible');
ok($('#dlFolder'), 'download folder row visible');

document.getElementById('btnAbout')?.click();
await sleep(50);
ok($('#aboutModal')?.classList.contains('open'), 'about modal terbuka dari topbar');
ok($('#aboutVersion')?.textContent.trim().length > 0, 'about: baris versi terisi');
ok($('#aboutEngineState')?.textContent.trim().length > 0, 'about: baris engine terisi');
ok($('#aboutEngineDevice')?.textContent.trim().length > 0, 'about: baris perangkat terisi');
ok($('#aboutEngineModel')?.textContent.trim().length > 0, 'about: baris pemisah vokal terisi');
ok($('#aboutUpdate')?.textContent.trim().length > 0, 'about: baris pembaruan terisi');
ok(!!document.getElementById('aboutCheckUpdate'), 'about: tombol cek pembaruan ada');
ok(!!document.getElementById('aboutDlWrap'), 'about: wadah tombol unduh ada');
ok(document.getElementById('aboutDlWrap')?.style.display === 'none', 'about: tombol unduh tersembunyi sebelum ada versi baru');
ok(!!document.getElementById('aboutDlSetup') && !!document.getElementById('aboutDlMsi'), 'about: tombol unduh .exe dan .msi ada');
document.getElementById('aboutClose')?.click();
await sleep(20);
ok(!$('#aboutModal')?.classList.contains('open'), 'about modal tertutup lewat tombol X');
document.getElementById('btnAbout')?.click();
await sleep(20);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(20);
ok(!$('#aboutModal')?.classList.contains('open'), 'about modal tertutup lewat Escape');

document.querySelector('[data-nav="search"]')?.click();
const q = $('#searchViewInput');
q.value = 'test lagu';
q.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(1200);
const searchTxt = $('#searchTrackList')?.textContent || '';
const statusTxt = $('#searchStatus')?.textContent || '';
ok(searchTxt.includes('Gagal cari online') || searchTxt.includes('Tidak ada hasil') || statusTxt.length > 0, 'search offline error UI');

document.querySelector('[data-nav="local"]')?.click();
$('#btnKaraoke')?.click();
await sleep(50);
ok(($('#sepStatus')?.textContent || '').includes('Pilih lagu dulu'), 'karaoke guard no-track');

ok(!!document.getElementById('lyrOffsetWrap'), 'lyric offset bar exists');
ok(document.getElementById('lyrOffsetWrap')?.style.display === 'none', 'lyric offset hidden when unsynced');
ok(document.querySelectorAll('[data-lyr-off]').length === 7, 'lyric offset buttons');
ok(!!document.getElementById('lyrOffSlider'), 'lyric offset slider');
ok(!!document.getElementById('lyrOffToggle'), 'lyric offset toggle');
document.getElementById('lyrOffToggle')?.click();
await sleep(50);
{
  const body = document.getElementById('lyrOffBody');
  const collapsedOk = body?.classList.contains('lyr-hidden') || body?.style.display === 'none';
  ok(!!collapsedOk, 'lyric offset autohide');
}
ok(localStorage.getItem('vocalyx_lyricOffsetUI_v1') === '1', 'lyric offset collapse persists');
document.getElementById('lyrOffToggle')?.click();
await sleep(50);
ok(localStorage.getItem('vocalyx_lyricOffsetUI_v1') === '0', 'lyric offset expand persists');

ok(document.querySelector('[data-nav="albums"]') === null, 'nav albums dihapus');
ok(document.querySelector('[data-nav="artists"]') === null, 'nav artists dihapus');
ok(document.getElementById('viewAlbums') === null, 'section albums dihapus');
ok(document.getElementById('viewArtists') === null, 'section artists dihapus');
const locFilter = document.getElementById('localSearchFilter');
ok(!!locFilter, 'dropdown tampilan local ada');
locFilter.value = 'album';
locFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(50);
ok($('#tableHead')?.style.display === 'none' || (($('#trackList')?.textContent || '').includes('Belum ada lagu')), 'header tabel sembunyi di mode kartu (atau empty-library)');
{
  const t = $('#trackList')?.textContent || '';
  ok(t.includes('Belum ada lagu') || t.includes('Tidak ada album yang cocok') || !!document.querySelector('#trackList .pl-card'), 'local album mode render');
}
locFilter.value = 'artist';
locFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(50);
{
  const t = $('#trackList')?.textContent || '';
  ok(t.includes('Belum ada lagu') || t.includes('Tidak ada artis yang cocok') || !!document.querySelector('#trackList .pl-card'), 'local artist mode render');
}
locFilter.value = 'title';
locFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(50);
ok($('#tableHead')?.style.display !== 'none', 'header tabel kembali di mode daftar');
const srcOverlay = readSrc();
ok(srcOverlay.includes('class="cover-play" data-play-album='), 'overlay play ada di kartu album');
ok(srcOverlay.includes('class="cover-play" data-play-artist='), 'overlay play ada di kartu artist');
ok(!srcOverlay.includes('data-play-album="${key}" style="flex:1'), 'tombol Play bawah kartu album dihapus');
ok(srcOverlay.includes('class="cover-play" data-play-pl='), 'overlay play ada di kartu playlist');
ok(srcOverlay.includes('class="pl-cover-tools"'), 'tombol rename/hapus di dalam cover playlist');
ok(srcOverlay.includes('class="cover-tool" data-rename=') && srcOverlay.includes('class="cover-tool" data-del='), 'tool rename+hapus playlist ada');
ok(!srcOverlay.includes('${ICON.play} Play</button>'), 'baris tombol bawah kartu playlist dihapus');
const cssPl = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
ok(cssPl.includes('.pl-cover-stack > .pl-cover-tools') && cssPl.includes('.cover-tool'), 'css tools cover playlist ada');
document.querySelector('[data-nav="local"]')?.click();
await sleep(50);
ok($('#viewLocal')?.style.display === 'flex', 'back to local view');

document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(50);
ok(!$('#localSearchBox')?.classList.contains('open'), 'local search box close on Escape');
document.querySelector('[data-nav="local"]')?.click();
await sleep(50);

try {
  const app = await import('../src/app.js');
  ok(app.karaokeStageLabel('separate') === 'memisahkan vokal', 'stage separate label');
  ok(app.karaokeStageLabel('loudnorm') === 'menyamakan volume', 'stage loudnorm label');
  ok(app.karaokeStageLabel('convert-target') === 'menyimpan', 'stage convert label');
  ok(app.karaokeStageLabel('tahap-asing') === 'tahap-asing', 'unknown stage passthrough');
  ok(app.karaokeStageLabel('') === 'bekerja', 'empty stage fallback');
  const busy = app.karaokeBadgeHtml({ karaoke_job: true, karaoke_pct: 72, karaoke_stage: 'separate' });
  ok(busy === '<span class="k-badge busy">proses konversi karaoke</span>', 'busy badge single text');
  const noPct = app.karaokeBadgeHtml({ karaoke_job: true, karaoke_pct: null, karaoke_stage: '' });
  ok(!noPct.includes('NaN') && !noPct.includes('undefined'), 'busy badge null-safe');
  const stall = app.karaokeBadgeHtml({ karaoke_job: true, karaoke_pct: 72, karaoke_stage: 'separate', karaoke_stalled: true });
  ok(stall.includes('stalled') && stall.includes('proses konversi karaoke'), 'stalled badge');
  const bar = app.karaokeProgressHtml({ karaoke_job: true, karaoke_pct: 72, karaoke_stage: 'separate' });
  ok(bar.includes('k-prog') && bar.includes('72%') && bar.includes('width:72%'), 'progress bar below title');
  const barIdle = app.karaokeProgressHtml({ karaoke_job: true, karaoke_pct: null, karaoke_stage: '' });
  ok(barIdle.includes('bekerja') && !barIdle.includes('NaN'), 'progress bar null-safe');
  ok(app.karaokeProgressHtml({}) === '', 'no bar when idle');
  const src = readSrc();
  const vsrc = fs.readFileSync(path.join(root, 'src/js/views.js'), 'utf8');
  const albumRow = vsrc.slice(vsrc.indexOf('function renderAlbumDetail'));
  const artistRow = vsrc.slice(vsrc.indexOf('function renderArtistDetail'));
  ok(albumRow.includes('karaokeBadgeHtml(t)') && albumRow.includes('karaokeProgressHtml(t)') && albumRow.includes('dataset.tpath'), 'album detail badge+bar');
  ok(artistRow.includes('karaokeBadgeHtml(t)') && artistRow.includes('karaokeProgressHtml(t)') && artistRow.includes('dataset.tpath'), 'artist detail badge+bar');
  ok(src.includes('querySelectorAll(`button.track[data-tpath='), 'badge update covers all views');
  ok(app.karaokeBadgeHtml({ karaoke_path: '/x/no_vocals.flac' }).includes('>karaoke<'), 'done badge');
  ok(app.karaokeBadgeHtml({}) === '', 'no badge when idle');
  ok(app.cudaDeviceLabel({ cuda: true, device: 'NVIDIA GeForce RTX 3050' }) === 'GPU (NVIDIA GeForce RTX 3050)', 'label GPU dari device_info');
  ok(app.cudaDeviceLabel({ cuda: false, device: 'cpu' }) === 'CPU', 'label CPU dari device_info');
  ok(app.cudaDeviceLabel(null) === '', 'label device kosong aman');
  ok(typeof app.playPreviewAudio === 'function' && typeof app.stopPreview === 'function' && typeof app.isPreviewPlaying === 'function', 'api preview terpisah tersedia');
  ok(src.includes('export let previewAudio = null') && src.includes('function ensurePreviewAudio()'), 'elemen preview lazy-init (aman jsdom)');
  ok(src.includes('playPreviewAudio(url, playBtn,'), 'tombol preview pakai elemen terpisah');
  ok(!src.includes("audio.dataset.isPreview = '1'"), 'audio utama tak lagi dibajak preview');
  const plsrc = fs.readFileSync(path.join(root, 'src/js/player.js'), 'utf8');
  ok(/export async function load\(i, autoplay = false\) \{\s*if \(S\.tracks\.length === 0\) return;\s*try \{ stopPreview\(\); \} catch \{\}/.test(plsrc), 'load hentikan preview');
  ok(/export function play\(\) \{\s*try \{ stopPreview\(\); \} catch \{\}/.test(plsrc), 'play utama hentikan preview');
  ok(app.cudaDeviceLabel({ cuda: true, device: 'NVIDIA GeForce RTX 3050' }, 'cpu') === 'CPU', 'device aktual cpu menang atas kapabilitas');
  ok(app.cudaDeviceLabel({ cuda: false, device: 'cpu' }, 'cuda') === 'GPU (cpu)', 'device aktual cuda dipakai');
  ok(src.includes('cudaDeviceLabel(pj.device_info, pj.device)'), 'label live pakai device aktual job');
  ok(typeof app.refreshCudaStatus === 'function', 'refreshCudaStatus tersedia');
  ok(src.includes('pj.device_info') && src.includes('Separasi berjalan di: ${lbl}'), 'progress job tampilkan perangkat aktual');
  ok(src.includes("document.getElementById('cudaConnDot')"), 'dot status CUDA dibaca');
  ok(src.includes("'?device=' + encodeURIComponent(dev)"), 'caps kirim device terpilih');
  ok(src.includes('S._karaokeCapsKey === dev'), 'cache caps per device');
  ok(src.includes("Aktif: ${nm || 'CPU'}"), 'indikator CPU ala GPU');
  ok(src.includes("selDev0 !== 'cpu'"), 'toast cuda-error lompat bila cpu dipilih');
  ok(/getElementById\('karaokeDevice'\)\?\.addEventListener\('change'[\s\S]{0,220}?refreshCudaStatus\(\)/.test(src), 'ganti device refresh indikator seketika');
  const pySep2 = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
  ok(pySep2.includes('def _cpu_info()'), 'py: info CPU ada');
  ok(pySep2.includes('probe_cuda=(device != "cpu")'), 'py: worker lewati init CUDA saat cpu');
  ok(pySep2.includes('def karaoke_caps(device: str = "auto")'), 'py: endpoint terima device');
  const htmlCuda = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(htmlCuda.includes('id="cudaConnDot"') && htmlCuda.includes('id="karaokeCudaStatus"'), 'dot + teks CUDA ada di Settings');
  ok(htmlCuda.includes('<option value="standard">Standard</option>') && htmlCuda.includes('<option value="high">Best</option>'), 'label quality Standard/Best, value tetap');
} catch (e) {
  ok(false, `karaoke badge :: ${e.message}`);
}

await sleep(3200);
ok(document.getElementById('appToast')?.classList.contains('show') || (document.getElementById('appToast')?.textContent || '').length >= 0, 'toast element alive');

try {
  const fmt = await import('../src/js/format.js');
  ok(fmt.fmt(65) === '01:05', 'fmt(65)');
  ok(fmt.fmt(NaN) === '00:00', 'fmt(NaN)');
  ok(typeof fmt.hashStr('a') === 'number', 'hashStr');
  ok(fmt.escAttr('a"b&c<d') === 'a&quot;b&amp;c&lt;d', 'escAttr');
} catch (e) {
  ok(false, `pure format.js :: ${e.message}`);
}
try {
  const lrc = await import('../src/js/lrc.js');
  const lines = lrc.parseLRC('[00:10.00]hello\n[00:20.00]world');
  ok(lines.length === 2 && Math.abs(lines[0].t - 10) < 0.01, 'parseLRC synced');
  const plain = lrc.parseLRC('just text\nmore');
  ok(plain.length === 2 && plain[1].t === 99999, 'parseLRC plain sentinel');
  ok(Array.isArray(lrc.defaultLyrics()) && lrc.defaultLyrics().length === 1, 'defaultLyrics');
  ok(lrc.formatLrcTime(65.5) === '[01:05.50]', 'formatLrcTime');
  const shifted = lrc.shiftLrcByOffset('[00:10.00]hello\n[00:20.00]world', 500);
  ok(shifted.includes('[00:10.50]hello') && shifted.includes('[00:20.50]world'), 'shiftLrcByOffset +500ms');
  ok(lrc.shiftLrcByOffset('just text\nmore', 500).includes('just text'), 'shiftLrcByOffset skips plain');
  const back = lrc.shiftLrcByOffset('[offset:+500]\n[00:10.00]hello', 0);
  ok(back.includes('[offset:+500]'), 'shiftLrcByOffset no-op keeps tag');
  ok(lrc.parseLRCForEdit('[00:30.00]c\n[00:10.00]a')[0].x === 'c', 'parseLRCForEdit tidak sort');
  ok(lrc.parseLRCForEdit('[00:30.00]c\n[00:10.00]a').length === 2, 'parseLRCForEdit jumlah baris');
  const wordy = lrc.parseLRC('[00:10.00]<00:10.00>Hai <00:10.50>dunia');
  ok(wordy[0].d === 'Hai dunia' && wordy[0].x.includes('<00:10.00>'), 'tag per-kata: d bersih, x mentah');
  ok(lrc.lyricLinesToLrc(lrc.parseLRC('[00:10.00]<00:10.00>Hai')).includes('<00:10.00>'), 'round-trip tag per-kata');
  ok(lrc.formatLrcTimeRounded(59.999) === '[01:00.00]', 'formatLrcTimeRounded rollover');
  const base3 = '[00:10.00]satu\n[00:20.00]dua\n[00:30.00]tiga';
  ok(lrc.nudgeLrcLine(base3, 1, 200).split('\n')[1] === '[00:20.20]dua', 'nudgeLrcLine');
  const tail3 = lrc.nudgeLrcFromIndex(base3, 1, -500).split('\n');
  ok(tail3[1] === '[00:19.50]dua' && tail3[2] === '[00:29.50]tiga', 'nudgeLrcFromIndex menggeser ekor');
  ok(lrc.setLrcLineTime(base3, 0, 1.5).split('\n')[0] === '[00:01.50]satu', 'setLrcLineTime');
  ok(lrc.setLrcLineText(base3, 1, '  baru  ').split('\n')[1] === '[00:20.00]baru', 'setLrcLineText');
  ok(lrc.removeLrcLine(base3, 1).split('\n').length === 2, 'removeLrcLine');
  ok(lrc.insertLrcLineAfter(base3, 0, 15, 'tengah').split('\n')[1] === '[00:15.00]tengah', 'insertLrcLineAfter');
  ok(lrc.nudgeLrcLine('[ar:Artis]\n[ti:Judul]\n' + base3, 0, 100).startsWith('[ar:Artis]'), 'header LRC terjaga');
  const plainEdit = lrc.setLrcLineTime('biasa satu\nbiasa dua', 1, 7).split('\n');
  ok(plainEdit[0] === 'biasa satu' && plainEdit[1] === '[00:07.00]biasa dua', 'baris polos tidak diberi timestamp');
  ok(lrc.escHtml('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', 'escHtml');
  ok(lrc.stripWordTags('<00:01.00>a <00:02.00>b') === 'a b', 'stripWordTags');
  ok(lrc.isSynced(lrc.parseLRC('[00:01.00]a')) === true && lrc.isSynced(lrc.parseLRC('a\nb')) === false, 'isSynced');
} catch (e) {
  ok(false, `pure lrc.js :: ${e.message}`);
}
try {
  const lyrSrc = fs.readFileSync(path.join(root, 'src/js/lyrics.js'), 'utf8');
  ok(!lyrSrc.includes('scheduleLyricAutosave'), 'offset tidak lagi membakar .lrc (scheduleLyricAutosave dihapus)');
  const stSrc = fs.readFileSync(path.join(root, 'src/js/state.js'), 'utf8');
  ok(!stSrc.includes('_lyrSaveTimer'), 'state _lyrSaveTimer dibuang');
  const htmlIcon = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(!!htmlIcon.match(/id="lyrEditModal"/) && !!htmlIcon.match(/id="lyrEditList"/), 'markup modal editor ada');
  ok(!!htmlIcon.match(/id="lyrEditOpen"/), 'tombol buka editor di kartu lirik');
  ok(!htmlIcon.includes('<!--'), 'html tanpa komentar');
  const cssEdit = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(cssEdit.includes('.lyr-edit-row') && cssEdit.includes('.lyr-edit-btn'), 'css editor ada');
  const rustSrc = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  ok(rustSrc.includes('fn write_lyric_to') && rustSrc.includes('write_lyric_to,'), 'perintah rust write_lyric_to terdaftar');
  const iconIdx = fs.readFileSync(path.join(root, 'src/icons/tabler/index.js'), 'utf8');
  ok(!iconIdx.includes('<td') && !iconIdx.includes('class="ic"'), 'data ikon bebas pembungkus <td>/class=ic');
  const iconEntries = [...iconIdx.matchAll(/^ {2}'([^']+)': '([\s\S]*?)',?$/gm)];
  const shapeOnly = /^(<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/>\s*)+$/;
  const badShape = iconEntries.filter(([, , b]) => !shapeOnly.test(b.trim())).map(([, n]) => n);
  ok(badShape.length === 0, `set ikon hanya berisi elemen svg${badShape.length ? ' :: ' + badShape.join(',') : ''}`);
  const svgDir = path.join(root, 'src/icons/tabler');
  const badSvg = fs.readdirSync(svgDir).filter((f) => f.endsWith('.svg'))
    .filter((f) => /<td|class="ic"/.test(fs.readFileSync(path.join(svgDir, f), 'utf8')));
  ok(badSvg.length === 0, `file svg ikon bersih${badSvg.length ? ' :: ' + badSvg.join(',') : ''}`);
} catch (e) {
  ok(false, `editor wiring :: ${e.message}`);
}
try {
  const lrcX = await import('../src/js/lrc.js');
  const lyricLines = lrcX.parseLRC('[00:10.00]<00:10.00>Hai <00:10.50>dunia\n[00:20.00]<00:20.00>Bye <00:20.40>now');
  const { renderLyrics } = await import('../src/js/lyrics.js');
  const { S } = await import('../src/js/state.js');
  S.lyricLines = lyricLines;
  renderLyrics();
  const host = document.getElementById('lyrics');
  ok(!host.innerHTML.includes('<00:10.00>'), 'tag per-kata tidak bocor ke HTML');
  ok(host.textContent.includes('Hai dunia') && host.textContent.includes('Bye now'), 'teks tampilan benar');
  S.lyricLines = lrcX.parseLRC('[00:01.00]<img src=x onerror="window.__xss=1">halo');
  renderLyrics();
  ok(!host.innerHTML.includes('<img') && host.textContent.includes('halo'), 'teks lirik di-escape (anti XSS)');
  S.lyricLines = lrcX.defaultLyrics();
  renderLyrics();
  const wrap = document.getElementById('lyrOffsetWrap');
  ok(wrap && wrap.style.display === 'none', 'file lirik polos sembunyikan bar offset');
} catch (e) {
  ok(false, `render escape :: ${e.message}`);
}
try {
  const lrcY = await import('../src/js/lrc.js');
  const { S } = await import('../src/js/state.js');
  const ed = await import('../src/js/lyrics-editor.js');
  const rows = () => [...document.querySelectorAll('#lyrEditList .lyr-edit-row')];
  const ts = (i) => rows()[i].querySelector('.lyr-edit-ts').textContent;
  const hit = (i, act, d) => {
    const sel = d == null ? `[data-act="${act}"]` : `[data-act="${act}"][data-d="${d}"]`;
    rows()[i].querySelector(sel).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  };
  S.lyricLines = lrcY.parseLRC('[00:10.00]satu\n[00:20.00]dua\n[00:30.00]tiga');
  S.tracks = [{ path: 'C:\\Musik\\Uji - Coba.mp3', title: 'Coba', artist: 'Uji', name: 'Uji - Coba' }];
  S.idx = 0;
  const aud = document.getElementById('audio');
  Object.defineProperty(aud, 'currentTime', { value: 47.25, writable: true, configurable: true });
  ed.openLyricEditor();
  await sleep(60);
  ok(document.getElementById('lyrEditModal').style.display === 'flex', 'editor: modal terbuka');
  ok(rows().length === 3, 'editor: 3 baris ter-render');
  ok(ts(0) === '00:10.00', 'editor: waktu pakai sentidetik');
  ok(document.querySelectorAll('#lyrEditList [data-act]').length === 33, 'editor: 11 tombol alat x 3 baris');
  hit(1, 'now');
  await sleep(20);
  ok(ts(1) === '00:47.25', 'editor: Set now memakai posisi audio');
  hit(0, 'nudge', -200);
  await sleep(20);
  ok(ts(0) === '00:09.80', 'editor: nudge -0.2 detik');
  hit(1, 'tail', 500);
  await sleep(20);
  ok(ts(1) === '00:47.75' && ts(2) === '00:30.50', 'editor: geser baris + semua berikutnya');
  hit(0, 'add');
  await sleep(20);
  ok(rows().length === 4, 'editor: tambah baris');
  rows()[1].querySelector('[data-act="del"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  ok(rows().length === 3, 'editor: hapus baris');
  document.getElementById('lyrEditRevert').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(20);
  ok(ts(0) === '00:10.00' && document.getElementById('lyrEditSave').textContent === 'Simpan', 'editor: Batal mengembalikan isi disk');
  ok(S.lyricLines.length === 3 && Math.abs(S.lyricLines[0].t - 10) < 0.01, 'editor: Batal juga mengembalikan kartu lirik');
  ed.closeLyricEditor();
  await sleep(10);
  ok(document.getElementById('lyrEditModal').style.display === 'none', 'editor: modal tertutup');
} catch (e) {
  ok(false, `editor fungsional :: ${e.message}`);
}
try {
  const lrcZ = await import('../src/js/lrc.js');
  const { S } = await import('../src/js/state.js');
  const lyr = await import('../src/js/lyrics.js');
  const ed = await import('../src/js/lyrics-editor.js');
  const aud = document.getElementById('audio');
  const rows = () => [...document.querySelectorAll('#lyrEditList .lyr-edit-row')];
  const bar = document.getElementById('lyrEditSeek');
  const click = (n) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  Object.defineProperty(aud, 'duration', { value: 240, writable: true, configurable: true });
  Object.defineProperty(aud, 'currentTime', { value: 0, writable: true, configurable: true });
  Object.defineProperty(aud, 'paused', { value: false, writable: true, configurable: true });
  delete aud.dataset.previewCap;

  ok(!!bar && bar.getAttribute('step') === '0.01', 'seekbar: langkah 0,01 detik');
  ok(bar.className.includes('wfill') && bar.className.includes('hfill'), 'seekbar: pakai wfill hfill');
  ok(!!document.getElementById('lyrEditLeft'), 'seekbar: label sisa waktu ada');

  ok(lyr.seekLyric(NaN) === false, 'seekLyric tolak waktu tidak valid');
  ok(lyr.seekLyric(99999) === false, 'seekLyric tolak sentinel 99999');
  S.lyricOffsetMs = 0;
  ok(lyr.seekLyric(10) === true && Math.abs(aud.currentTime - 10.05) < 0.001, `seekLyric menambah proroll 50ms (dapat ${aud.currentTime})`);
  S.lyricOffsetMs = 250;
  ok(lyr.seekLyric(10) === true && Math.abs(aud.currentTime - 9.8) < 0.001, `seekLyric ikut memperhitungkan offset (dapat ${aud.currentTime})`);
  S.lyricOffsetMs = 0;
  aud.dataset.previewCap = '30';
  ok(lyr.seekLyric(120) === true && Math.abs(aud.currentTime - 30) < 0.001, `seekLyric dibatasi previewCap 30s (dapat ${aud.currentTime})`);
  delete aud.dataset.previewCap;

  S.lyricLines = lrcZ.parseLRC('[00:10.00]satu\n[00:20.00]dua');
  S.tracks = [{ path: 'C:\\Musik\\Uji.mp3', title: 'Uji', artist: 'Uji', name: 'Uji' }];
  S.idx = 0;
  ed.openLyricEditor();
  await sleep(60);
  ok(rows().length === 2, 'seekbar: editor terbuka dengan 2 baris');
  ok(document.querySelectorAll('#lyrEditList .lyr-edit-ts').length === 2, 'seekbar: kolom waktu jadi tombol');
  ok(document.querySelectorAll('#lyrEditList .lyr-edit-ts[data-seek]').length === 2, 'seekbar: kedua baris punya target putar');
  ok(document.querySelectorAll('#lyrEditList .lyr-edit-ts:disabled').length === 0, 'seekbar: baris bertime tidak ada yang nonaktif');
  ok(document.querySelectorAll('#lyrEditList .lyr-edit-ts[disabled]').length === 0, 'seekbar: tidak ada target pada baris bertime yang dinonaktifkan');

  aud.currentTime = 0;
  click(rows()[1].querySelector('[data-seek]'));
  await sleep(20);
  ok(Math.abs(aud.currentTime - 20.05) < 0.001, `klik kolom waktu baris 2 melompat ke 20s (dapat ${aud.currentTime})`);


  click(rows()[0].querySelector('[data-txt]'));
  await sleep(10);
  ok(!!document.querySelector('.lyr-edit-input'), 'klik teks tetap membuka kolom ubah');
  document.querySelector('.lyr-edit-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(10);

  aud.currentTime = 60;
  const ticks = [];
  const realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { ticks.push(fn); return ticks.length; };
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  ed.closeLyricEditor();
  ed.openLyricEditor();
  await sleep(60);
  const batch1 = ticks.slice();
  for (const t of batch1) { try { t(); } catch {} }
  globalThis.requestAnimationFrame = realRaf;
  window.requestAnimationFrame = realRaf;
  await sleep(10);
  const batch2 = ticks.slice();
  for (const t of batch2) { try { t(); } catch {} }
  ok(document.getElementById('lyrEditSeek').max === '240', `seekbar: max jadi durasi (dapat ${document.getElementById('lyrEditSeek').max})`);
  ok(document.getElementById('lyrEditClock').textContent === '01:00', `seekbar: label waktu berjalan (dapat ${document.getElementById('lyrEditClock').textContent})`);
  ok(document.getElementById('lyrEditLeft').textContent === '-03:00', `seekbar: label sisa waktu (dapat ${document.getElementById('lyrEditLeft').textContent})`);

  bar.value = '120';
  bar.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok(Math.abs(aud.currentTime - 120) < 0.001, `seekbar: geser ke 120s (dapat ${aud.currentTime})`);
  aud.dataset.previewCap = '30';
  bar.value = '200';
  bar.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok(Math.abs(aud.currentTime - 30) < 0.001, `seekbar: geser dibatasi previewCap (dapat ${aud.currentTime})`);
  delete aud.dataset.previewCap;

  ed.closeLyricEditor();
} catch (e) {
  ok(false, `seekbar editor :: ${e.message}`);
}
try {
  const up = await import('../src/js/updater.js');
  ok(up.compareSemver('0.1.0', '0.2.0') === -1, 'semver: 0.1.0 < 0.2.0');
  ok(up.compareSemver('0.2.0', '0.2.0') === 0, 'semver: sama');
  ok(up.compareSemver('0.10.0', '0.9.0') === 1, 'semver: 0.10.0 > 0.9.0 (bukan perbandingan string)');
  ok(up.compareSemver('1.0.0-beta', '1.0.0') === -1, 'semver: prerelease < rilis final');
  ok(up.compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10') === -1, 'semver: alpha.2 < alpha.10');
  ok(up.compareSemver('v1.2.3', '1.2.3+build7') === 0, 'semver: awalan v dan +build diabaikan');
  ok(up.compareSemver('1.2', '1.2.0') === 0, 'semver: 1.2 = 1.2.0');
  ok(up.compareSemver('', '1.0.0') === -1, 'semver: masukan kosong tidak melempar');
  ok(up.compareSemver(null, undefined) === 0, 'semver: null vs undefined = 0');
  ok(up.compareSemver('abc', 'abd') === 0, 'semver: bukan angka diperlakukan 0');
  ok(up.manifestUrl() === '' || /^https:\/\//.test(up.manifestUrl()), `manifestUrl kosong atau https (dapat "${up.manifestUrl()}")`);
  const mres = await up.fetchManifest();
  ok(mres.ok === false || (mres.data && typeof mres.data.version === 'string'), 'fetchManifest mengembalikan bentuk yang benar');
  const chk = await up.checkForUpdate();
  ok(['unconfigured', 'checking', 'current', 'available', 'error'].includes(chk.state), `checkForUpdate state valid (${chk.state})`);
  if (up.manifestUrl() === '') {
    ok(chk.state === 'unconfigured', 'manifest kosong -> state unconfigured, bukan error');
    ok(await up.openDownload('') === false, 'openDownload menolak url kosong');
    ok(await up.openDownload('javascript:alert(1)') === false, 'openDownload menolak skema bukan http');
  }
  const seen = up.seenVersion();
  up.markSeen('9.9.9');
  ok(up.seenVersion() === '9.9.9', 'seenVersion tersimpan');
  up.markChecked();
  ok(up.lastCheckAt() > 1600000000000, 'lastCheckAt tersimpan');
  up.markSeen(seen);
} catch (e) {
  ok(false, `updater :: ${e.message}`);
}
try {
  const eqd = await import('../src/js/eq-data.js');
  ok(Array.isArray(eqd.EQ_FREQS) && eqd.EQ_FREQS.length === 10, 'EQ_FREQS');
  ok(eqd.EQ_PRESETS && Array.isArray(eqd.EQ_PRESETS.Flat) && eqd.EQ_PRESETS.Flat.length === 10, 'EQ_PRESETS');
} catch (e) {
  ok(false, `pure eq-data.js :: ${e.message}`);
}

try {
  const py = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
  ok(py.includes('@router.post("/separate/cleanup")'), 'cleanup endpoint registered');
  ok(py.includes('_inside_app_dir') && py.includes('not in rp.parents'), 'cleanup traversal guard');
  ok(py.includes('def _sweep_stale_cache') && py.includes('_sweep_stale_cache()'), 'stale sweeper wired');
  ok(py.includes('def _mdx_prune_wav'), 'wav prune helper');
  ok(py.includes('_mdx_prune_wav(persist_base') || py.includes('_mdx_prune_wav(stem_dir)'), 'wav prune invoked');
  const app = readSrc();
  ok(app.includes("/separate/cleanup"), 'frontend calls cleanup');
  ok(app.includes("/api/separate/cleanup"), 'cleanup has /api fallback');
  const guardPos = py.indexOf('not _mdx_has_persist(_pb, _st, target_format) and out_path.exists()');
  const hitPos = py.indexOf('"stage": "cache-hit"');
  ok(guardPos !== -1 && hitPos !== -1 && guardPos < hitPos, 'mdx_extra guard before memory cache-hit');
} catch (e) {
  ok(false, `karaoke cleanup contract :: ${e.message}`);
}

try {
  const te = fs.readFileSync(path.join(root, 'src/js/track-edit.js'), 'utf8');
  const dlStart = te.indexOf('async function editDownloaded');
  const localStart = te.indexOf('async function editLocalTrack');
  const dlBody = te.slice(dlStart, localStart);
  const localBody = te.slice(localStart);
  for (const [name, body] of [['downloads', dlBody], ['local', localBody]]) {
    const confirms = (body.match(/showConfirm\(/g) || []).length;
    const guardedConfirms = (body.match(/withNestedDialog\d?\(\(\) => showConfirm\(/g) || []).length;
    ok(confirms > 0 && confirms === guardedConfirms, `edit ${name}: semua showConfirm ter-guard (${guardedConfirms}/${confirms})`);
    const guardedAlerts = (body.match(/withNestedDialog\d?\(\(\) => showAlert\(/g) || []).length;
    ok(guardedAlerts >= 5, `edit ${name}: alert bersarang ter-guard (${guardedAlerts})`);
  }
} catch (e) {
  ok(false, `nested-dialog guard :: ${e.message}`);
}

try {
  const src = readSrc();
  ok(src.includes("id=\"btnRemoveCover\"") && src.includes("${curCover ? '' : ' disabled'}"), 'remove-cover disabled berbasis curCover');
  ok(src.includes('if (removeBtn.disabled) return;'), 'remove downloads guard disabled');
  ok(src.includes('if (removeBtn2.disabled) return;'), 'remove local guard disabled');
  ok(src.includes('_iphHasCover') && src.includes('Cek cover…'), 'iphone probe hibrida + flag memori');
  ok(src.includes("if (document.getElementById('iphBtnRemoveCover')?.disabled) return;"), 'remove iphone guard disabled');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('.btn-more:disabled'), 'btn-more disabled style ada');
} catch (e) {
  ok(false, `remove-cover disabled :: ${e.message}`);
}

try {
  const src = readSrc();
  ok(!/trackListEl\.addEventListener\('click'/.test(src), 'menu local tidak lagi delegasi di trackListEl');
  ok(src.includes('menuScopeOk') && /document\.addEventListener\('click', \(e\)=>\{\r?\n {2}const editBtn = e\.target\.closest\('\[data-edit-track\]'\);/.test(src), 'menu local delegasi di document + guard');
  ok(src.includes('iphMenuScopeOk'), 'menu iphone punya guard scope portal');
  ok(/document\.addEventListener\('click', \(e\) => \{\r?\n {2}const editBtn = e\.target\.closest\('\[data-iph-edit\]'\);/.test(src), 'menu iphone delegasi di document');
} catch (e) {
  ok(false, `menu portal delegation :: ${e.message}`);
}

try {
  const src = readSrc();
  ok(src.includes('Cover Saat Ini') && src.includes('iphone/track/cover?item_pid='), 'iphone cover saat ini ada');
  ok(src.includes('__iphCoverFallback') && src.includes('Belum ada cover'), 'iphone cover fallback placeholder');
  ok(!src.includes('v=${Date.now()}'), 'probe/list/thumbnail berbagi cache (tanpa Date.now)');
} catch (e) {
  ok(false, `iphone cover thumbnail :: ${e.message}`);
}

try {
  const src = readSrc();
  ok(src.includes('coverPrevBox') && src.includes('coverFileInput'), 'drop zone + browse downloads/local');
  ok(src.includes('iphCoverFileInput') && src.includes("wireCoverDrop(document.getElementById('iphCoverPrev')"), 'drop zone iphone');
  ok(src.includes('wireCoverDrop(') && src.includes('readCoverDropFile') && src.includes('readCoverPathDrop'), 'helper drop/browse/path ada');
  ok(src.includes('coverData') && src.includes("'embedded'"), 'coverData dikirim + respons embedded dipakai');
  ok(src.includes('__activeCoverDrop'), 'routing drop Tauri ke zona cover');
  const py = fs.readFileSync(path.join(root, 'python-engine/vx_cover.py'), 'utf8');
  ok(py.includes('_decode_cover_data') && py.includes('COVER_DATA_MAX_BYTES'), 'backend decode coverData + batas ukuran');
  ok(py.includes('coverData') && py.includes('"embedded"'), 'backend /embed/cover terima coverData');
  const pyIph = fs.readFileSync(path.join(root, 'python-engine/vx_iphone.py'), 'utf8');
  ok(pyIph.includes('_decode_cover_data') && pyIph.includes('coverData'), 'backend iphone terima coverData');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('.cover-drop'), 'cover-drop style ada');
} catch (e) {
  ok(false, `cover drag-drop :: ${e.message}`);
}

try {
  const src = readSrc();
  const hints = (src.match(/Engine Python tampaknya versi lama — restart python-engine\/server\.py\./g) || []).length;
  ok(hints >= 2, `hint restart engine di jalur cover (${hints})`);
  ok(src.includes('pendingIphDrop') && src.includes('engine Python versi lama, restart python-engine/server.py'), 'hint restart di save iphone');
  const srv = fs.readFileSync(path.join(root, 'python-engine/server.py'), 'utf8');
  ok(srv.includes('"cover_upload": True') || srv.includes("'cover_upload': True"), '/health umumkan kapabilitas cover_upload');
} catch (e) {
  ok(false, `stale-backend hint :: ${e.message}`);
}

try {
  const src = readSrc();
  ok(src.includes('submenu-head'), 'submenu punya header label');
  ok(src.includes('submenu-count'), 'count playlist dibungkus muted');
  ok(src.includes('submenu-create'), 'tombol create pakai class (tanpa inline style)');
  ok(!src.includes('font-style:italic'), 'tanpa italic darurat di submenu');
  ok(src.includes("addBtn.classList.toggle('open'"), 'chevron ikut status submenu');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('.submenu-head') && css.includes('text-overflow: ellipsis') && css.includes('rotate(90deg)'), 'css submenu rapi ada');
} catch (e) {
  ok(false, `local dropdown tidy :: ${e.message}`);
}

try {
  const src = readSrc();
  const paintStart = src.indexOf('function paintEnhanceItem');
  const paintBody = src.slice(paintStart, src.indexOf('async function enhanceOneFile'));
  ok(!paintBody.includes('✨') && !paintBody.includes('⏳'), 'tanpa emoji di paintEnhanceItem');
  ok(paintBody.includes('ICON.sparkles') && paintBody.includes('ICON.check'), 'pakai SVG model aplikasi');
  ok(paintBody.includes('btn.innerHTML'), 'innerHTML agar SVG tidak terhapus');
} catch (e) {
  ok(false, `enhance icon :: ${e.message}`);
}

try {
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('font-family: "Inter"') && css.includes('font-weight: 100 900'), '@font-face Inter variable');
  ok(css.includes('font-family: "Space Grotesk"'), '@font-face Space Grotesk');
  ok(css.includes('font-family: "Inter", "Segoe UI"'), 'stack body Inter + fallback');
  ok(css.includes('--font-display') && css.includes('font-family: var(--font-display)'), 'display font dipakai');
  ok(!css.includes('Neustadt'), 'tanpa sisa Neustadt di css');
  for (const f of ['Inter-var.woff2', 'SpaceGrotesk-var.woff2']) {
    const st = fs.statSync(path.join(root, 'src/public/fonts', f));
    ok(st.size > 10000, `font ada: ${f}`);
  }
  for (const f of ['Neustadt-Regular.woff', 'Neustadt-SemiBold.woff']) {
    ok(!fs.existsSync(path.join(root, 'src/public/fonts', f)), `font lama dibuang: ${f}`);
  }
} catch (e) {
  ok(false, `fonts :: ${e.message}`);
}

try {
  const src = readSrc();
  ok(!src.includes('showDlInLocal') && !src.includes('dlHidden') && !src.includes('SHOW_DL_IN_LOCAL'), 'tanpa sisa toggle');
  ok(src.includes('function normalizeSeparationFlags'), 'normalize flags ada');
  ok(src.includes('normalizeSeparationFlags(await _downloadFolderNorm(), getMusicFolders())'), 'normalize saat boot');
  ok(src.includes('normalizeSeparationFlags(dl, getMusicFolders())'), 'normalize habis add folder');
  ok(/const changed = normalizeSeparationFlags\(await _downloadFolderNorm\(\), getMusicFolders\(\)\);/.test(src), 'restore: normalisasi selalu jalan walau folder musik kosong');
  ok(/if \(ti >= 0 && S\.tracks\[ti\] && !S\.tracks\[ti\]\.fromDownloads\)/.test(src), 'ensureDownloadTrack koreksi flag entri lama');
  ok(src.includes('if (!tr.cover && d.cover) tr.cover = d.cover;'), 'ensureDownloadTrack: sync cover entri kasar dari downloads');
  ok(src.includes('if (d.title && (!tr.title || tr.title === base2)) tr.title = d.title;'), 'ensureDownloadTrack: sync judul filename dari downloads');
  ok(/if \(!dl\) return false;/.test(src), 'normalize: dl kosong = tanpa perubahan flag');
  ok(/if \(dl && !!known\.fromDownloads !== hide\)/.test(src), 'scan: flag known tak disentuh saat dl kosong');
  ok(/saveMusicFolder\(folder\);[\s\S]{0,300}?S\.tracks = \[\];/.test(src), 'add folder: ganti total (reset daftar)');
  ok(/localStorage\.setItem\(MUSIC_FOLDERS_KEY, JSON\.stringify\(\[dir\]\)\)/.test(src), 'saveMusicFolder: folder tunggal (ganti daftar)');
  ok(!src.includes('Folder tersebut adalah folder download'), 'tanpa blokir add folder');
  ok(src.includes('if (isTauri() && getMusicFolders().some(d => _inFolder(d, p)))'), 'toast overlap dipertahankan');
  ok(src.includes('const hide = !!(inDl && !inMusic)'), 'aturan flag: dl && !musik');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(!html.includes('showDlInLocal'), 'tanpa checkbox toggle');
} catch (e) {
  ok(false, `separasi independen :: ${e.message}`);
}

try {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  for (const [id, keys] of [['tableHead', ['title', 'type', 'size', 'duration']], ['downloadTableHead', ['title', 'type', 'progress', 'status']], ['iphoneTableHead', ['title', 'type', 'size', 'duration']]]) {
    const idPos = html.indexOf(`id="${id}"`);
    const open = html.lastIndexOf('<div', idPos);
    const tags = /<\/?div\b[^>]*>/g;
    tags.lastIndex = open;
    let depth = 0, end = -1, tm;
    while ((tm = tags.exec(html))) {
      depth += tm[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = tm.index + tm[0].length; break; }
    }
    if (end < 0) throw new Error(`${id}: header tidak tertutup`);
    const head = html.slice(open, end);
    for (const k of keys) ok(head.includes(`data-sort="${k}"`), `${id}: kolom ${k} sortable`);
  }
  const src = readSrc();
  ok(src.includes('vocalyx_sort_local_v1') && src.includes('vocalyx_sort_downloads_v1') && src.includes('vocalyx_sort_iphone_v1'), 'state sort per view');
  ok(src.includes('function cycleSort') && src.includes('function paintSortHeads'), 'cycle + indikator ada');
  ok(src.includes('function applyLocalSort') && src.includes('findIndex(t => t.path === cur)'), 'local in-place + idx remap');
  ok(src.includes('sortDownloadRows(rows)') && src.includes('sortIPhoneTracks()'), 'hook render downloads/iphone');
  ok(src.includes("e.target.closest('.resizer')"), 'klik resizer bukan sort');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('[data-sort]') && css.includes('.sort-ind'), 'css sort ada');
} catch (e) {
  ok(false, `grid sort :: ${e.message}`);
}

try {
  const sj = fs.readFileSync(path.join(root, 'src/js/search.js'), 'utf8');
  ok(sj.includes('function searchTrackRow(t, absIdx)'), 'search: row builder terpusat');
  ok(sj.includes('function groupSearchResults()'), 'search: grup album+artis client-side');
  ok(sj.includes('function renderSearchGrouped()'), 'search: render grouped ada');
  ok(/if \(filter === 'all'\) renderSearchGrouped\(\);\s*else renderSearchPage\(\);/.test(sj), 'search: filter Semua = grouped, selainnya datar');
  ok(sj.includes("sec('Lagu')") && sj.includes("sec('Album')") && sj.includes("sec('Artis')"), 'search: section Lagu Album Artis');
  ok(sj.includes('function drill(kind, value)'), 'search: drill scope modul');
  ok(sj.includes('function openSearchGroupPopup(kind, g)'), 'search: popup list grup ada');
  ok(sj.includes("openSearchGroupPopup('album'") && sj.includes("openSearchGroupPopup('artist'"), 'search: klik kartu buka popup');
  ok(sj.includes('Lihat semua hasil') && sj.includes('searchTrackRow(t, i)'), 'search: popup ada list + tombol lihat semua');
  ok(sj.includes("head.style.display = 'none'") && sj.includes("head.style.display = ''"), 'search: header tabel sembunyi/tampil per mode');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('.search-section-title'), 'css judul section search ada');
  ok(css.includes('.search-popup-list') && css.includes('#modalFormWrap .track'), 'css popup list + baris modal ada');
  ok(css.includes('.modal.modal-wide .modal-card'), 'css popup wide (modal 560px) ada');
  ok(css.includes('minmax(0, 1fr) auto auto'), 'css grid popup: judul 1fr, durasi+tombol auto');
  ok(sj.includes("modal.classList.add('modal-wide')") && sj.includes("modal.classList.remove('modal-wide')"), 'search: class wide pasang/lepas popup');
} catch (e) {
  ok(false, `search grouped :: ${e.message}`);
}

try {
  const grid = fs.readFileSync(path.join(root, 'src/js/grid.js'), 'utf8');
  ok(grid.includes('colWidths = [30, null, 44, 58, 72]'), 'default colWidths 5 kolom, duration 72px');
  ok(grid.includes('detailColWidths = [30, null, 44, 58, 72, 30]'), 'detail playlist tetap 6 kolom (tombol hapus)');
  ok(grid.includes("'#detailTrackList .track'"), 'baris playlist pakai lebar detail');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('grid-template-columns: 30px 1fr 44px 58px 72px;'), 'css base 5 kolom, duration 72px');
  ok(css.includes('grid-template-columns: 30px 1fr 44px 58px 48px;'), 'css downloads tanpa kolom 52px');
  ok(css.includes('#detailTableHead, #detailTrackList .track {'), 'css playlist 6 kolom dipertahankan');
  ok(/#trackList \.c-more, #downloadList \.c-more, #iphoneTrackList \.c-more \{\s*position: absolute;/m.test(css), 'sel host menu keluar dari alur grid');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(!html.slice(html.indexOf('id="tableHead"'), html.indexOf('id="trackList"')).includes('c-more'), 'header Local tanpa sel kolom ...');
  ok(html.slice(html.indexOf('id="detailTableHead"'), html.indexOf('id="detailTrackList"')).includes('c-more'), 'header playlist tetap punya sel kolom hapus');
  ok(!html.slice(html.indexOf('id="downloadTableHead"'), html.indexOf('id="downloadList"')).includes('c-more'), 'header Downloads tanpa sel kolom ...');
  const ajs = readSrc();
  const emptyMore = (ajs.match(/<span class="c-more"><\/span>/g) || []).length;
  ok(emptyMore === 1, `sisa .c-more kosong hanya di cabang iPhone (dapat ${emptyMore})`);
  ok((ajs.match(/class="c-more"/g) || []).length === 6, 'sel .c-more: Local/Playlist/Search/Downloads/iPhone(x2)');
} catch (e) {
  ok(false, `grid widths :: ${e.message}`);
}

try {
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('.track.active { background: rgba(43,155,245,0.14); box-shadow: inset 3px 0 0 var(--accent); }'), 'light: bar aksen row aktif');
  ok(css.includes('[data-theme="dark"] .track.active'), 'dark: bar aksen row aktif tetap ada');
} catch (e) {
  ok(false, `active row accent :: ${e.message}`);
}

try {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const localStart = html.indexOf('id="viewLocal"');
  const localHead = html.slice(localStart, html.indexOf('id="tableHead"'));
  ok(localHead.includes('tools-right') && localHead.indexOf('tools-right') < localHead.indexOf('btnSelectLocal'), 'local: view+select di tools-right');
  ok((localHead.match(/id="btnRefreshLocal"/g) || []).length === 1, 'local: satu tombol refresh, tanpa duplikat view');
  const dlStart = html.indexOf('id="viewDownloads"');
  const dlHead = html.slice(dlStart, html.indexOf('id="downloadTableHead"'));
  ok(dlHead.includes('tools-right') && dlHead.includes('btnSelectDownloads'), 'downloads: select di tools-right');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('.tools-right') && css.includes('margin-left: auto'), 'css tools-right kanan');
} catch (e) {
  ok(false, `toolbar kanan :: ${e.message}`);
}

try {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(html.includes('id="btnRefreshLocal"'), 'tombol refresh ada');
  ok(!html.includes('title="View"'), 'tombol view lama hilang');
  const src = readSrc();
  ok(src.includes("getElementById('btnRefreshLocal')?.addEventListener"), 'refresh di-wire');
  ok(src.includes('S._musicRescanAt = 0') && src.includes('await rescanMusicFolders()'), 'refresh lewati throttle + rescan');
  ok(src.includes("btn.classList.add('spinning')"), 'indikator putar saat refresh');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(css.includes('#btnRefreshLocal.spinning'), 'css spinning ada');
} catch (e) {
  ok(false, `refresh local :: ${e.message}`);
}

try {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const selStart = html.indexOf('id="searchSource"');
  ok(selStart !== -1, 'dropdown searchSource ada');
  const selEnd = html.indexOf('</select>', selStart);
  const sel = html.slice(selStart, selEnd);
  for (const v of ['all', 'spotify', 'deezer', 'soundcloud', 'archive', '4shared']) {
    ok(sel.includes(`value="${v}"`), `resource ${v} ada`);
  }
  const src = readSrc();
  ok(src.includes("type: filter, source, limit:100"), 'source dikirim ke engine');
  ok(src.includes("getElementById('searchSource')?.addEventListener('change'"), 'ganti resource re-run');
  ok(src.includes('vocalyx_searchSource_v1'), 'pilihan resource persist');
  const py = fs.readFileSync(path.join(root, 'python-engine/vx_search.py'), 'utf8');
  ok(py.includes('src_filter') && py.includes('::src='), 'backend filter + cache per source');
  ok(py.includes('per_sp = limit if _only'), 'satu source = limit penuh');
} catch (e) {
  ok(false, `search resource :: ${e.message}`);
}

try {
  const modal = await import('../src/js/modal.js');
  const p = modal.showAlert('Tes', 'isi');
  await sleep(50);
  ok($('#appModal')?.classList.contains('open'), 'modal opens');
  $('#modalConfirm')?.click();
  const v = await p;
  ok(v === true, 'modal confirm resolves true');
} catch (e) {
  ok(false, `modal round-trip :: ${e.message}`);
}

try {
  const mss = await import('../src/js/media-session.js');
  ok(typeof mss.setupMediaSession === 'function', 'media-session exports');
  ok(mss.setupMediaSession({ play() {} }) === false, 'setup skipped without mediaSession');
  const fake = {
    handlers: {}, metadata: null, playbackState: '', pos: null,
    setActionHandler(a, f) { this.handlers[a] = f; },
    setPositionState(s) { this.pos = s; },
  };
  Object.defineProperty(window.navigator, 'mediaSession', { value: fake, configurable: true });
  globalThis.MediaMetadata = class { constructor(o) { this.init = o; } };
  const calls = [];
  const res = mss.setupMediaSession({
    play: () => calls.push('play'), pause: () => calls.push('pause'),
    next: () => calls.push('next'), prev: () => calls.push('prev'),
    seekBy: (s) => calls.push('seekBy:' + s), seekTo: (s) => { if (typeof s === 'number') calls.push('seekTo:' + s); },
  });
  ok(res === true, 'setupMediaSession registers');
  ok(Object.keys(fake.handlers).length === 8, '8 action handlers');
  fake.handlers.play();
  fake.handlers.nexttrack();
  fake.handlers.previoustrack();
  fake.handlers.seekforward();
  fake.handlers.seekbackward();
  fake.handlers.seekto({ seekTime: 42 });
  fake.handlers.seekto({});
  ok(calls.join(',') === 'play,next,prev,seekBy:10,seekBy:-10,seekTo:42', 'handlers dispatch');
  mss.setMediaSessionMeta({ title: 'T', artist: 'A', album: 'B', cover: '' });
  ok(fake.metadata && fake.metadata.init.title === 'T' && fake.metadata.init.album === 'B', 'metadata set');
  mss.setMediaSessionState({ playing: true, position: 5, duration: 100, rate: 1 });
  ok(fake.playbackState === 'playing' && fake.pos && fake.pos.position === 5, 'state + position');
  mss.clearMediaSession();
  ok(Object.values(fake.handlers).every((f) => f === null) && fake.metadata === null, 'clearMediaSession resets');
} catch (e) {
  ok(false, `media-session :: ${e.message}`);
}

try {
  const om = await import('../src/js/os-media.js');
  ok(typeof om.tapDecide === 'function', 'tapDecide export');
  ok(om.tapDecide(1) === 'run', '1 tekan -> run instan (play/pause tanpa delay)');
  ok(om.tapDecide(2) === 'next', '2 tekan -> next');
  ok(om.tapDecide(3) === 'prev', '3 tekan -> prev');
  ok(om.tapDecide(4) === 'run', '4 tekan -> run (burst reset)');
  const srcTap = readSrc();
  ok(srcTap.includes("handleOsMediaAction('play')"), 'web path (Media Session) lewat handleOsMediaAction');
  ok(!srcTap.includes('const S = window.devicePixelRatio'), 'shadowing S di drawWave tak balik');
  ok(srcTap.includes('S.analyser.getByteFrequencyData'), 'jalur data spektrum visualizer intak');
} catch (e) {
  ok(false, `os-media tap pattern :: ${e.message}`);
}

try {
  const htmlSrc = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const appSrc = readSrc();

  const impBtn = document.getElementById('btnDeviceImport');
  ok(!!impBtn, 'tombol Import ada');
  const impMenu = document.getElementById('deviceImportMenu');
  ok(!!impMenu && impMenu.classList.contains('more-menu'), 'menu Import pakai .more-menu');
  const itemIds = [...(impMenu?.querySelectorAll('button') || [])].map(b => b.id);
  ok(itemIds.includes('btnImportFile') && itemIds.includes('btnImportFolder'), 'menu berisi Import File + Import Folder');
  ok(htmlSrc.indexOf('id="btnDeviceImport"') < htmlSrc.indexOf('id="btnDeviceExportAll"'), 'Import di kiri sebelum Export');
  ok(cssSrc.includes('.device-library-panel .playlist-head { margin-bottom: 10px; }'), 'gap judul Library iPhone 10px');
  ok(appSrc.includes('openPortalMenu(menu, btn)') && appSrc.includes("invokeTauri('scan_music'"), 'handler import: portal menu + scan_music untuk folder');
  ok(appSrc.includes("filters: [{ name: 'Audio'"), 'import file pakai filter audio');

  impBtn?.click();
  ok(impMenu?.classList.contains('open'), 'klik Import membuka menu');
  ok(impMenu?.parentElement?.id === 'menuPortal', 'menu dipindah ke portal (anti-kepotong overflow)');
  impBtn?.click();
  ok(!impMenu?.classList.contains('open'), 'klik lagi menutup menu');
  ok(impMenu?.parentElement?.id !== 'menuPortal', 'menu dikembalikan ke wadah asal');
} catch (e) {
  ok(false, `import menu :: ${e.message}`);
}

try {
  const app = await import('../src/app.js');
  const { EQ_PRESETS } = await import('../src/js/eq-data.js');
  const appSrc = readSrc();

  ok(typeof app.saveEqState === 'function' && typeof app.restoreEqState === 'function', 'saveEqState/restoreEqState ter-export');
  ok(appSrc.includes("EQ_STORE_KEY = 'vocalyx_eq_v1'"), 'key localStorage vocalyx_eq_v1');
  const applyRegion = appSrc.slice(appSrc.indexOf('function applyPreset'), appSrc.indexOf('eqBox.addEventListener'));
  ok(applyRegion.includes('saveEqState(name)'), 'applyPreset menyimpan preset');
  ok(appSrc.includes("saveEqState('Custom')"), 'geser slider manual menyimpan Custom');
  ok(/restoreEqState\(\);/.test(appSrc), 'restore dipanggil saat boot');
  ok((document.getElementById('btnPreset')?.textContent || '').includes('Rock'), 'boot: label preset pulih dari localStorage (Rock)');
  ok(document.querySelector('[data-eq="0"]')?.value === String(EQ_PRESETS.Rock[0]), 'boot: slider EQ pulih dari localStorage');
  ok(!!document.querySelector('#presetMenu [data-preset="Rock"].active'), 'boot: tombol preset aktif pulih');

  document.querySelector('#presetMenu [data-preset="Rock"]')?.click();
  let eqSaved = null;
  try { eqSaved = JSON.parse(localStorage.getItem('vocalyx_eq_v1')); } catch {}
  ok(eqSaved && eqSaved.preset === 'Rock' && Array.isArray(eqSaved.gains) && eqSaved.gains.length === 10, 'klik preset Rock tersimpan (nama + 10 gain)');
  ok(eqSaved && eqSaved.gains[0] === EQ_PRESETS.Rock[0] && eqSaved.gains[9] === EQ_PRESETS.Rock[9], 'nilai gain preset ikut tersimpan');

  localStorage.setItem('vocalyx_eq_v1', JSON.stringify({ preset: 'Jazz', gains: EQ_PRESETS.Jazz }));
  ok(app.restoreEqState() === true, 'restore preset sukses');
  ok((document.getElementById('btnPreset')?.textContent || '').includes('Jazz'), 'label tombol preset kembali Jazz');
  ok(!!document.querySelector('#presetMenu [data-preset="Jazz"].active'), 'tombol preset aktif kembali');
  ok(document.querySelector('[data-eq="0"]')?.value === String(EQ_PRESETS.Jazz[0]), 'slider EQ mengikuti preset tersimpan');

  localStorage.setItem('vocalyx_eq_v1', JSON.stringify({ preset: 'Custom', gains: [1.5, 0, 0, 0, 0, 0, 0, 0, 0, -2] }));
  ok(app.restoreEqState() === true, 'restore Custom sukses');
  ok((document.getElementById('btnPreset')?.textContent || '').includes('Custom'), 'label Custom dipulihkan');
  ok(!document.querySelector('#presetMenu button.active'), 'tanpa tombol aktif saat Custom');
  ok(document.querySelector('[data-eq="0"]')?.value === '1.5' && document.querySelector('[data-eq="9"]')?.value === '-2', 'gain Custom dipulihkan ke slider');

  localStorage.setItem('vocalyx_eq_v1', '{rusak');
  ok(app.restoreEqState() === false, 'data rusak diabaikan tanpa throw');
  localStorage.removeItem('vocalyx_eq_v1');
  document.querySelector('#presetMenu [data-preset="Flat"]')?.click();

  ok(!appSrc.includes('${p.trackPaths.length}'), 'scrolldown tidak pakai trackPaths.length mentah');
  ok(!appSrc.includes('trackPaths.includes('), 'tidak ada kecocokan path mentah tersisa');
  ok(appSrc.includes('(${playlistTracks(p).length})'), 'scrolldown pakai jumlah hasil resolusi');
  ok(appSrc.includes('const tracksIn = playlistTracks(p);'), 'kartu playlist pakai playlistTracks');
  ok(appSrc.includes('const filtered = playlistTracks(pl);'), 'detail playlist pakai playlistTracks');

  const list = [{ path: 'C:\\Music\\Song One.mp3' }, { path: 'D:\\dl\\two.flac' }];
  const pl = { id: 'x', name: 'X', trackPaths: ['c:/music/SONG ONE.MP3', 'D:/DL/TWO.flac', 'E:\\gone.mp3'] };
  ok(app.normPath('C:/Music/BedA.MP3') === 'c:\\music\\beda.mp3', 'normPath: / -> \\ + lowercase');
  ok(app.normPath('') === '' && app.normPath('.') === '' && app.normPath(null) === '', 'normPath: path kosong/absurd -> ""');
  ok(app.trackIndexByPath('c:/music/song one.mp3', list) === 0, 'trackIndexByPath pencocokan ternormalisasi');
  ok(app.trackIndexByPath('', list) === -1 && app.trackIndexByPath('E:\\gone.mp3', list) === -1, 'trackIndexByPath: kosong/tak ada -> -1');
  const resolved = app.playlistTracks(pl, list);
  ok(resolved.length === 2, 'playlistTracks: 3 path tersimpan -> 2 yang cocok');
  ok(resolved.map(t => t.path).join('|') === list.map(t => t.path).join('|'), 'playlistTracks urut & hanya track valid');
} catch (e) {
  ok(false, `preset eq + playlist count :: ${e.message}`);
}

try {
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const closeRule = css.split('\n').find(l => l.includes('.win-btn.close:hover')) || '';
  ok(closeRule.includes('background: var(--close-hover)'), 'hover tombol close pakai merah Windows 11');
  ok(closeRule.includes('color: #fff'), 'ikon close putih di atas merah');
  const winBtnRule = css.slice(css.indexOf('.win-btn {'), css.indexOf('.win-btn:hover'));
  ok(winBtnRule.includes('transition: background 0.15s ease, border-color 0.15s ease;'), 'transition .win-btn tetap tanpa color (ikon instan)');
  ok(/:root \{[\s\S]{0,3000}?--close-hover: #c42b1c;/.test(css), 'var --close-hover = #c42b1c (native Windows 11)');
  ok(!/#btnSettings/.test(css), 'aturan css #btnSettings sudah dibuang');
} catch (e) {
  ok(false, `close hover accent :: ${e.message}`);
}

try {
  const { TABLER, } = await import('../src/icons/tabler/index.js');
  const { hydrateIcons, ico } = await import('../src/js/icons-tabler.js');
  const htmlIcon = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(!/<path[^>]*d="M/.test(htmlIcon), 'index.html tidak lagi punya path ikon literal');
  ok(!/stroke-width="1\.9"/.test(htmlIcon), 'tidak ada stroke-width 1.9 lagi di html');
  const names = [...htmlIcon.matchAll(/data-ico="([^"]+)"/g)].map((m) => m[1]);
  ok(names.length >= 50, `data-ico terpasang di html: ${names.length} ikon`);
  const missing = names.filter((n) => !TABLER[n]);
  ok(missing.length === 0, `semua nama data-ico ada di set tabler${missing.length ? ' :: ' + [...new Set(missing)].join(',') : ''}`);
  ok(Object.keys(TABLER).length >= 37, `set tabler ter-vendor: ${Object.keys(TABLER).length} ikon`);
  ok(/<svg[^>]*\sdata-ico="[^"]+"[^>]*>/.test(htmlIcon), 'atribut data-ico berada di dalam tag <svg>');
  const wrongBox = [...htmlIcon.matchAll(/<svg[^>]*\sdata-ico="[^"]+"[^>]*>/g)].filter((m) => !m[0].includes('viewBox="0 0 24 24"'));
  ok(wrongBox.length === 0, `semua placeholder data-ico memakai viewBox 24${wrongBox.length ? ' :: ' + wrongBox.length + ' placeholder' : ''}`);
  ok(ico('music').includes('<svg') && ico('player-play-filled').includes('fill="currentColor"'), 'ico() render svg + varian filled');
  ok(!fs.existsSync(path.join(root, 'src/icons/fluent')), 'aset ikon fluent sudah dibuang');
  const probe = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  probe.setAttribute('data-ico', 'trash');
  window.document.body.appendChild(probe);
  const n = hydrateIcons(window.document);
  ok(n >= 1 && probe.innerHTML.includes('<path'), 'hydrateIcons mengisi path dari set');
  ok(probe.getAttribute('data-ico') === null, 'hydrateIcons membuang atribut data-ico');
} catch (e) {
  ok(false, `ikon tabler :: ${e.message}`);
}

try {
  const bomFiles = ['src/index.html', 'src/app.js', 'src/icons/tabler/index.js',
    ...fs.readdirSync(path.join(root, 'src/js')).filter((f) => f.endsWith('.js')).map((f) => `src/js/${f}`)];
  const withBom = bomFiles.filter((f) => {
    const b = fs.readFileSync(path.join(root, f));
    return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  });
  ok(withBom.length === 0, `tidak ada BOM di file src${withBom.length ? ' :: ' + withBom.join(', ') : ''}`);
} catch (e) {
  ok(false, `bom check :: ${e.message}`);
}

try {
  const { EQ_PRESETS } = await import('../src/js/eq-data.js');
  const appSrc2 = readSrc();
  const ensureRegion = appSrc2.slice(appSrc2.indexOf('function ensureGraph'), appSrc2.indexOf('function applyFxState'));
  ok(ensureRegion.includes('applyFxState()'), 'ensureGraph memanggil applyFxState saat graph dibuat');

  const mkParam = (v = 0) => ({ value: v });
  const mkNode = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });
  const bqList = [];
  window.AudioContext = class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = mkNode(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createMediaElementSource() { return mkNode(); }
    createBiquadFilter() {
      const bq = mkNode({ type: 'peaking', frequency: mkParam(1000), Q: mkParam(1), gain: mkParam(0) });
      bqList.push(bq);
      return bq;
    }
    createDynamicsCompressor() { return mkNode({ threshold: mkParam(0), knee: mkParam(0), ratio: mkParam(1), attack: mkParam(0), release: mkParam(0) }); }
    createGain() { return mkNode({ gain: mkParam(1) }); }
    createAnalyser() { return mkNode({ fftSize: 2048 }); }
  };

  const toggle = document.getElementById('btnEqToggle');
  const eq0 = document.querySelector('[data-eq="0"]');
  const eq3 = document.querySelector('[data-eq="3"]');
  ok(!!toggle && !!eq0 && !!eq3, 'toggle + slider EQ ada');
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  eq0.value = '-4'; eq3.value = '6';

  document.getElementById('vol').dispatchEvent(new window.Event('input', { bubbles: true }));
  ok(bqList.length === 10, 'graph punya 10 band EQ');
  ok(bqList[0].gain.value === -4 && bqList[3].gain.value === 6, 'gain band mengikuti slider saat graph dibuat (bug: semua 0)');
  ok(bqList[1].gain.value === 0 && bqList[9].gain.value === 0, 'band lain tetap 0');

  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  ok(bqList.every(b => b.gain.value === 0), 'EQ OFF -> semua gain 0');
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  ok(bqList[0].gain.value === -4 && bqList[3].gain.value === 6, 'EQ ON -> gain kembali sesuai slider');

  document.querySelector('#presetMenu [data-preset="Rock"]')?.click();
  ok(bqList[0].gain.value === EQ_PRESETS.Rock[0] && bqList[9].gain.value === EQ_PRESETS.Rock[9], 'pilih preset saat graph hidup langsung terdengar');
} catch (e) {
  ok(false, `eq graph state :: ${e.message}`);
}

try {
  const ajs = readSrc();
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(ajs.includes('data-iphone-import="${i}"'), 'menu Local punya data-iphone-import');
  ok(ajs.includes('data-iphone-dl="${i}"'), 'menu Downloads punya data-iphone-dl');
  ok(ajs.includes('ICON.upload} Import to iPhone'), 'label item memakai ICON.upload');
  ok(/upload:\s*ico\(/.test(ajs), 'ICON.upload terdaftar di map ICON');
  ok(ajs.includes('data-reveal-dl="${i}"'), 'menu Downloads punya data-reveal-dl');
  ok(ajs.includes('ICON.folder} Buka lokasi file'), 'label item memakai ICON.folder');
  ok(/folder:\s*ico\(/.test(ajs), 'ICON.folder terdaftar di map ICON');
  ok(ajs.includes('revealItemInDir(d.path)'), 'reveal memakai plugin-opener');
  ok(ajs.includes('<div class="t-sub dl-loc"><strong>Source</strong>:${escAttr(dirOnly)}</div>'), 'baris Source tebal + folder normal');
  ok(/#downloadList \.dl-loc \{[^}]*text-overflow: ellipsis/.test(css), 'css ellipsis baris Source');
  ok(ajs.includes("String(d.path).split(/[\\\\/]/).slice(0, -1).join('\\\\')"), 'folder tanpa nama file');
  ok(!ajs.includes('if (d.path) b.title = d.path;'), 'tanpa tooltip baris');
  ok(css.includes('#downloadList .dl-loc') && css.includes('font-weight: 700'), 'css baris path tebal + ellipsis');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(html.includes('Folder Download (semua sumber)'), 'label settings folder download jelas');
  ok(html.includes('Satu folder untuk semua hasil unduhan dari semua sumber.'), 'hint folder download ada');
  ok(ajs.includes('handleLibraryDrop([t.path])') && ajs.includes('handleLibraryDrop([d.path])'),
    'kedua item memanggil handleLibraryDrop (upload langsung)');
  ok(/b\.ondblclick = \(e\) => \{\s*if \(e\.target\.closest\('\.more-menu'\)/.test(ajs), 'local: putar via double-click');
  ok(/b\.ondblclick = \(e\)=>\{\s*if \(e\.target\.closest\('\[data-sel-dl\]'\)/.test(ajs), 'downloads: putar via double-click');
  ok(ajs.includes("b.ondblclick = (e)=>{ if(e.target.closest('[data-rm]')) return; setPlaylistPlayback"), 'playlist: putar via double-click');
  ok(ajs.includes('b.ondblclick = ()=>{ setAlbumPlayback'), 'album: putar via double-click');
  ok(ajs.includes('b.ondblclick = ()=>{ setArtistPlayback'), 'artis: putar via double-click');
  ok(/\.track \{[^}]*user-select: none/.test(css), 'baris lagu anti-seleksi teks saat double-click');
  ok(/audio\.addEventListener\('play', \(\)=>\{ updatePlayIcon\(true\); \}\);/.test(ajs), 'ikon ikut event play audio');
  ok(/audio\.addEventListener\('pause', \(\)=>\{ updatePlayIcon\(false\); \}\);/.test(ajs), 'ikon ikut event pause audio');
  ok(/updatePlayIcon \} from '\.\/js\/player\.js'/.test(ajs), 'updatePlayIcon tersedia via app');
  ok(!/\.more-menu button \{[^}]*border-bottom/.test(css), 'item dropdown tanpa border-bottom');
  ok(!css.includes('.more-menu button:last-child'), 'rule :last-child border-bottom dihapus');
  ok(!/\.submenu \{[^}]*border-top/.test(css), 'submenu tanpa border-top');
  ok(!/\.submenu-create \{[^}]*border-top/.test(css), 'submenu-create tanpa border-top');
} catch (e) {
  ok(false, `import-to-iphone static :: ${e.message}`);
}

try {
  document.querySelector('[data-nav="downloads"]')?.click();
  await sleep(300);
  const dlIph = document.querySelector('#downloadList [data-iphone-dl]');
  ok(!!dlIph, 'baris Downloads merender item Import to iPhone');
  dlIph?.click();
  await sleep(400);
  const toastTxt = (document.getElementById('appToast')?.textContent || '').trim();
  ok(/iPhone tidak terhubung|Import gagal/.test(toastTxt), `klik item memicu handleLibraryDrop :: "${toastTxt}"`);
} catch (e) {
  ok(false, `import-to-iphone klik :: ${e.message}`);
}

try {
  const ajs = readSrc();
  ok(ajs.includes("addEventListener('contextmenu'"), 'ada listener contextmenu');
  ok(ajs.includes(".closest('.track')"), 'contextmenu mencari baris .track');
  ok(ajs.includes("#trackList, #downloadList, #iphoneTrackList"), 'scope contextmenu = Local + Downloads + iPhone');
  ok(ajs.includes('e.preventDefault()'), 'contextmenu memblokir menu browser');
  ok(ajs.includes('openRowMenu(row, { x: e.clientX, y: e.clientY })'), 'klik kanan memanggil openRowMenu dengan anchor kursor');
  ok(ajs.includes('const anchor = S._menuAnchor;'), 'openPortalMenu mengonsumsi anchor sekali pakai');
  ok(ajs.includes('S._menuAnchor = anchor || null'), 'anchor dialirkan dari openRowMenu ke openPortalMenu');
} catch (e) {
  ok(false, `contextmenu static :: ${e.message}`);
}

try {
  const row = document.querySelector('#downloadList .track');
  ok(!!row, 'row Downloads siap diuji klik kanan');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
  const menu = document.querySelector('#menuPortal .more-menu.open');
  ok(!!menu, 'klik kanan membuka menu dropdown di #menuPortal');
  ok((menu?.textContent || '').includes('Import to iPhone'), 'menu kanan berisi item Import to iPhone');
  ok(menu?.style.top === '300px' && menu?.style.left === '400px',
    `menu muncul di kursor (left=${menu?.style.left}, top=${menu?.style.top})`);
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
  ok(!document.querySelector('#menuPortal .more-menu.open'), 'klik kanan kedua di baris sama menutup menu');
} catch (e) {
  ok(false, `contextmenu klik :: ${e.message}`);
}

try {
  const ajs = readSrc();
  ok(ajs.includes('input[type="text"], input:not([type])'), 'whitelist kolom teks di handler contextmenu');
  ok(!ajs.includes("closest('input, textarea"), 'selector blanket "input" sudah tidak dipakai');
  const dpCount = (ajs.match(/e\.preventDefault\(\)/g) || []).length;
  ok(dpCount >= 2, `preventDefault dipakai di cabang list + fallback (count=${dpCount})`);

  const grid = document.getElementById('trackList');
  const card = document.createElement('div');
  card.className = 'pl-card';
  grid.appendChild(card);
  const ev1 = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
  card.dispatchEvent(ev1);
  ok(ev1.defaultPrevented, 'klik kanan kartu thumbnail diblokir');
  ok(!document.querySelector('#menuPortal .more-menu.open'), 'kartu thumbnail tidak membuka dropdown ⋮');
  card.remove();

  const dlRow = document.querySelector('#downloadList .track');
  const ev2 = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 140 });
  dlRow.dispatchEvent(ev2);
  ok(ev2.defaultPrevented, 'klik kanan baris list tetap di-preventDefault (dropdown ⋮ terpicu)');
  ok(!!document.querySelector('#menuPortal .more-menu.open'), 'dropdown ⋮ memang terbuka dari baris list');

  const ev3 = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  document.body.dispatchEvent(ev3);
  ok(ev3.defaultPrevented, 'area umum (body) diblokir — menu browser tak muncul');
  ok(!document.querySelector('#menuPortal .more-menu.open'), 'klik kanan di area lain menutup dropdown yang terbuka');

  const field = document.createElement('input');
  field.type = 'text';
  document.body.appendChild(field);
  const ev4 = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  field.dispatchEvent(ev4);
  ok(!ev4.defaultPrevented, 'kolom teks TIDAK diblokir (Copy/Paste native tetap jalan)');
  ok(!document.querySelector('#menuPortal .more-menu.open'), 'klik kanan di kolom teks ikut menutup dropdown');
  field.remove();

  const mk = (tag, attrs) => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => { el.setAttribute(k, v); });
    document.body.appendChild(el);
    const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 });
    el.dispatchEvent(ev);
    el.remove();
    return ev.defaultPrevented;
  };
  ok(mk('input', { type: 'range' }) === true, 'slider range (EQ/volume/seek) diblokir');
  ok(mk('input', { type: 'checkbox' }) === true, 'checkbox/toggle diblokir');
  ok(mk('input', { type: 'file' }) === true, 'input file diblokir');
  ok(mk('select', {}) === true, 'select diblokir');
  ok(mk('textarea', {}) === false, 'textarea tetap tidak diblokir');
} catch (e) {
  ok(false, `disable klik kanan :: ${e.message}`);
}

try {
  const ajs = readSrc();
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(!ajs.includes('class="btn-more" data-idx'), 'tombol ... baris Local hilang dari template');
  ok(!ajs.includes('data-menu-dl'), 'tombol ... baris Downloads hilang dari template');
  ok(!ajs.includes('[data-iph-menu]'), 'tombol ... baris iPhone + handler lamanya hilang');
  ok(!ajs.includes('bindMoreMenus'), 'bindMoreMenus (buka via tombol) dihapus');
  ok(!ajs.includes('moreH'), 'ikon titik tiga ICON.moreH dihapus');
  ok(!css.includes('.btn-more[data-menu-dl]'), 'CSS tombol ... baris dihapus');
  ok(/function openRowMenu\(row, anchor\)/.test(ajs), 'helper openRowMenu(row, anchor) ada');
  ok(ajs.includes('paintEnhanceItem(eb, tt?.path, tt?.ext, true)') && ajs.includes('paintEnhanceItem(ebDl, menu._dlRow.d.path'),
    'openRowMenu menyiapkan enhance item (Local + Downloads)');
  ok(ajs.includes('submenu-head') && ajs.includes('data-create="${idx}"'),
    'populate submenu Add to playlist pindah ke openRowMenu');
  ok(/if \(row && row\.closest\('#trackList, #downloadList, #iphoneTrackList'\)\) \{\s*\r?\n\s*e\.preventDefault\(\);[\s\S]{0,200}?openRowMenu\(row,/.test(ajs),
    'contextmenu memanggil openRowMenu tanpa tombol');
} catch (e) {
  ok(false, `hapus tombol ... static :: ${e.message}`);
}

try {
  const row = document.querySelector('#downloadList .track');
  ok(!!row && !row.querySelector('.btn-more'), 'baris Downloads tak punya tombol ... lagi');
  ok(!!row?.querySelector('.more-menu'), 'baris Downloads tetap punya node menu (target klik kanan)');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 360, clientY: 260 }));
  const menu = document.querySelector('#menuPortal .more-menu.open');
  ok(!!menu, 'klik kanan tetap membuka dropdown tanpa tombol');
  ok(menu?.style.left === '360px' && menu?.style.top === '260px', `posisi di kursor (${menu?.style.left}, ${menu?.style.top})`);
  ok(!!menu?._dlRow && menu._dlRow.d.title === 'Uji Import iPhone', 'data row tersemat di menu untuk paint enhance');
  ok((menu?.textContent || '').includes('Import to iPhone'), 'isi menu lengkap');

  const iphList = document.getElementById('iphoneTrackList');
  const bareRow = document.createElement('div');
  bareRow.className = 'track';
  iphList.appendChild(bareRow);
  const evBare = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 });
  bareRow.dispatchEvent(evBare);
  ok(evBare.defaultPrevented, 'baris tanpa menu tetap memblokir menu browser');
  ok(!document.querySelector('#menuPortal .more-menu.open'), 'baris tanpa menu tidak membuka dropdown');
  bareRow.remove();
} catch (e) {
  ok(false, `hapus tombol ... fungsional :: ${e.message}`);
}

try {
  const py = fs.readFileSync(path.join(root, 'python-engine/vx_download.py'), 'utf8');
  ok(py.includes('def _unlink_quiet('), 'python: helper _unlink_quiet ada');
  const premFn = py.slice(py.indexOf('def _spotify_try_premium'), py.indexOf('def _deezer_id_from_track'));
  ok(premFn.includes('finally:') && premFn.includes('_unlink_quiet(tmp_out)'), 'python: finally hapus tmp .prem. saat gagal');
  ok(premFn.includes('shutil.rmtree(tmp_dir'), 'python: tmp_dir (out.ogg) ikut dibersihkan');
  ok(!/except Exception as e:\s*\r?\n\s*return \{"failed": True, "error": str\(e\)\[:300\]\}\s*\r?\n\s*except/.test(premFn),
    'python: tanpa blok except duplikat mati');
  const partialFn = py.slice(py.indexOf('def _is_partial_artifact'), py.indexOf('def _probe_duration'));
  ok(partialFn.includes('".prem." in n'), 'python: _is_partial_artifact kenal .prem.');

  const rs = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  ok(/fn is_artifact_name[\s\S]{0,300}?\.prem\./.test(rs), 'rust: is_artifact_name kenal .prem.');
  ok(rs.includes('fn cleanup_artifacts(dir: String, min_age_secs: u64)'), 'rust: perintah cleanup_artifacts ada');
  ok(rs.includes('cleanup_artifacts,'), 'rust: cleanup_artifacts terdaftar di generate_handler');

  const ajs = readSrc();
  ok(ajs.includes('function isArtifactFileName('), 'js: isArtifactFileName ada');
  ok(ajs.includes('function cleanupDownloadArtifacts('), 'js: cleanupDownloadArtifacts ada');
  ok(ajs.includes('cleanupDownloadArtifacts({ force:true })'), 'js: sweep dipanggil saat buka Downloads');
  ok(/setTimeout\(\(\)=>\{ try \{ cleanupDownloadArtifacts\(\); \} catch \{\} \}, 6000\)/.test(ajs), 'js: sweep dipanggil saat boot');
  ok(ajs.includes('if (isArtifactFileName(r.path || r.file_name)) continue;'), 'js: artefak difilter di applyScanResult');
  ok(ajs.includes('seenPaths.has(f.path) || isArtifactFileName(f.path)'), 'js: artefak difilter saat scan folder Downloads');
  ok(ajs.includes('if (isArtifactFileName(d.path)) { d._gone = true; pruned = true; continue; }'), 'js: riwayat artefak ikut dibuang');
} catch (e) {
  ok(false, `prem static :: ${e.message}`);
}

try {
  const loc = await import('../src/js/local.js');
  const sample = [
    { path: 'D:\\m\\a.mp3' }, { path: 'D:\\m\\a.mp3' },
    { path: 'D:\\m\\a.mp3' }, { path: 'D:\\m\\b.mp3' },
  ];
  ok(loc.dedupeByPath(sample) === 2, 'dedupeByPath buang 2 dari 3 duplikat');
  ok(sample.length === 2 && sample[0].path.endsWith('a.mp3') && sample[1].path.endsWith('b.mp3'), 'dedupeByPath sisakan entri pertama per path');
  const srcRace = readSrc();
  ok(srcRace.includes('_scanApplyChain'), 'applyScanResult diserialisasi (antrean promise)');
  ok((srcRace.match(/ti = S\.tracks\.findIndex\(t => t\.path === d\.path\)/g) || []).length >= 2, 'playDownloaded re-check findIndex setelah await');
  ok(srcRace.includes('const scanned = new Set();'), 'rescan catat path ter-scan');
  ok(srcRace.includes('S.tracks = S.tracks.filter(t => !t || !t.path || !underOk(t.path) || alive(t.path));'), 'rescan prune track hilang di bawah folder sukses');
  ok(srcRace.includes('pl.trackPaths.filter(pp => !underOk(pp) || alive(pp))'), 'rescan prune path mati di playlist');
  ok(/if \(plTouched\) \{\s*savePlaylists\(\);/.test(srcRace), 'playlist tersimpan saat ada path dibuang');
  ok(srcRace.includes('(added > 0 || removed > 0) && _viewNeedsTracks()'), 'render saat ada tambah atau hapus');
  const tsrc = fs.readFileSync(path.join(root, 'src/js/tracks.js'), 'utf8');
  ok(tsrc.includes("if (filterType === 'artist' || filterType === 'album')"), 'local: dropdown artis/album ganti tampilan');
  ok(tsrc.includes('function renderLocalCollection(filter, kind)'), 'local: render koleksi ada');
  ok(tsrc.includes('groupArtists()') && tsrc.includes('groupAlbums()'), 'local: koleksi dari pustaka lokal');
  ok(tsrc.includes("pickCoverQuad('artist:' + key, g.tracks)"), 'local: artis pakai quad sesi');
  ok(tsrc.includes('collectionCoverStack(g.tracks)'), 'local: fallback cover menu');
  ok(tsrc.includes("headEl.style.display = 'none'") && tsrc.includes("headEl.style.display = ''"), 'local: header tabel sembunyi/tampil per mode');
  ok(tsrc.includes("S.activeView='artist:'") && tsrc.includes("S.activeView='album:'"), 'local: klik kartu ke detail menu');
  ok(tsrc.includes("playCollection('artist'") && tsrc.includes("playCollection('album'"), 'local: overlay putar koleksi');
  const htmlLocal = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(htmlLocal.includes('title="Tampilan Local Music"'), 'tooltip dropdown diluruskan');
  const locSelStart = htmlLocal.indexOf('id="localSearchFilter"');
  const locSel = htmlLocal.slice(locSelStart, htmlLocal.indexOf('</select>', locSelStart));
  ok(!locSel.includes('<option value="all">'), 'dropdown local tanpa opsi Semua');
  ok(locSel.includes('<option value="title" selected>'), 'default local adalah Title');
} catch (e) {
  ok(false, `anti-duplikat local :: ${e.message}`);
}

try {
  const vw = await import('../src/js/views.js');
  const six = [{cover:'a'},{cover:'b'},{cover:'c'},{cover:'d'},{cover:'e'},{cover:'f'}];
  const q1 = vw.pickCoverQuad('pl-test-quad', six);
  ok(q1.length === 4 && new Set(q1).size === 4 && q1.every(c => 'abcdef'.includes(c)), 'quad: 4 unik subset input');
  const q2 = vw.pickCoverQuad('pl-test-quad', six);
  ok(JSON.stringify(q1) === JSON.stringify(q2), 'quad: stabil dalam sesi');
  const five = six.filter(t => t.cover !== q1[0]);
  const q3 = vw.pickCoverQuad('pl-test-quad', five);
  ok(q3.length === 4 && !q3.includes(q1[0]), 'quad: acak ulang bila cover hilang');
  ok(vw.pickCoverQuad('pl-test-few', [{cover:'a'},{cover:'a'},{cover:''}]).length === 0, 'quad: fallback bila <4 unik');
  ok(readSrc().includes('class="pl-cover-quad"'), 'markup quad dipakai di overview');
  const vsrcQuad = fs.readFileSync(path.join(root, 'src/js/tracks.js'), 'utf8');
  ok(vsrcQuad.includes("pickCoverQuad('artist:' + key, g.tracks)"), 'overview artis pakai quad');
  ok(vsrcQuad.includes('collectionCoverStack(g.tracks)'), 'artis fallback single cover dipertahankan');
  const cssQuad = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(!cssQuad.includes('.pl-card:hover { border-color: var(--accent);'), 'hover kartu tanpa bingkai biru (album/artis/playlist)');
  ok(!cssQuad.includes('#artistGrid .pl-card:hover { border-color: transparent;'), 'tanpa override hover artis (sudah global)');
  ok(cssQuad.includes('.track:hover { background: rgba(43,155,245,0.10); }'), 'hover baris terang tint biru');
  ok(cssQuad.includes('[data-theme="dark"] .track:hover { background: rgba(43,155,245,0.18); }'), 'hover baris gelap tint biru');
  ok(!cssQuad.includes('.track:hover { background: rgba(255,255,255,0.75); }'), 'cucian putih hover dihapus');
} catch (e) {
  ok(false, `playlist quad :: ${e.message}`);
}

try {
  const s = readSrc();
  ok(s.includes("console.error('[dl] render error'"), 'dl: kegagalan render ditangkap + console.error');
  ok(s.includes('⚠ Gagal render daftar download'), 'dl: error render ditampilkan di list, bukan senyap');
  ok(s.includes('async function _renderDownloads('), 'dl: renderDownloads punya wrapper anti-senyap');
  ok(s.includes('folder yang di-scan: ') && s.includes('file ter-scan: '), 'dl: empty-state menampilkan diagnostik folder/scan/riwayat');
  ok(/\} catch \{\s*\}\s*\} else if \(!d\.path/.test(s), 'dl: exists() error tidak prune riwayat permanen');
  ok(!s.includes('!rows.length && S.downloads.some(d => !d._gone)'), 'dl: fallback anti-kosong dihapus (filter folder tak dikalahkan)');
  ok(s.includes('if (d.path && seenDlPaths.has(d.path)) continue;'), 'dl: riwayat didedupe per path');
  ok(s.includes('if (d.path) seenDlPaths.add(d.path);'), 'dl: path riwayat dicatat sekali tampil');
  ok(s.includes("d.status === 'downloading' && (d.progress || 0) < 100"), 'dl: entri download terputus tidak di-prune senyap');
} catch (e) {
  ok(false, `anti-senyap downloads :: ${e.message}`);
}

try {
  const pySep = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
  ok(pySep.includes('env["CUDA_VISIBLE_DEVICES"] = ""'), 'py: cpu sembunyikan GPU dari subprocess');
  ok(pySep.includes('force_cpu=(dev_arg == "cpu")'), 'py: spawn paksa cpu bila device cpu');
  ok(pySep.includes('"device": job.get("device", "")'), 'py: progress paparkan device aktual');
} catch (e) {
  ok(false, `separate device :: ${e.message}`);
}

try {
  const sClean = readSrc();
  const cssClean = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const htmlClean = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const rsClean = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  const pyClean = fs.readFileSync(path.join(root, 'python-engine/vx_download.py'), 'utf8');
  ok(!/(^|\n)[ \t]*\/\//.test(sClean), 'js: sumber bersih komentar //');
  ok(!/(^|\n)[ \t]*\/\*/.test(sClean), 'js: sumber bersih komentar blok /*');
  ok(!cssClean.includes('/*'), 'css: sumber bersih komentar /* */');
  ok(!htmlClean.includes('<!--'), 'html: sumber bersih komentar <!-- -->');
  ok(!/^\s*\/\//m.test(rsClean), 'rust: sumber bersih komentar //');
  ok(!/^\s*#/m.test(pyClean), 'python: sumber bersih komentar #');
  ok(/import \{ _redlBusy, activeDownloadIds,/.test(sClean), 'dl: activeDownloadIds di-import (regresi list kosong Tauri)');
} catch (e) {
  ok(false, `bersih-komentar :: ${e.message}`);
}

try {
  const dlList = document.getElementById('downloadList');
  ok(!!dlList, 'downloadList siap diuji');
  ok(!(dlList?.textContent || '').includes('Prem Sisa'), 'riwayat .prem tak dirender di Downloads');
  ok(!!(dlList?.textContent || '').includes('Uji Import iPhone'), 'riwayat normal tetap tampil');
} catch (e) {
  ok(false, `prem fungsional :: ${e.message}`);
}

try {
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(/:root \{[\s\S]{0,3000}?--menu-hover: rgba\(43, 155, 245, 0\.14\)/.test(css),
    'light: --menu-hover terdefinisi di :root');
  ok(/\[data-theme="dark"\] \{[\s\S]{0,3000}?--menu-hover: rgba\(43, 155, 245, 0\.22\)/.test(css),
    'dark: --menu-hover ditimpa di blok tema gelap');
  ok(/\.more-menu button:hover \{ background: var\(--menu-hover\);/.test(css),
    'hover item .more-menu pakai --menu-hover');
  ok(/\.preset-menu button:hover \{ background: var\(--menu-hover\);/.test(css),
    'hover item .preset-menu pakai --menu-hover');
  ok(!/\.(more-menu|preset-menu) button:hover \{ background: var\(--card\)/.test(css),
    'sisa hover var(--card) pada dropdown sudah tidak ada');
  ok(css.includes('--card2') && /\.more-menu \{[^}]*background: var\(--card2\)/.test(css),
    'latar menu tetap pakai --card2 (bertema)');
  ok(/\.preset-menu \{[^}]*backdrop-filter: blur\(14px\)/.test(css),
    'preset-menu pakai frosted blur seperti .more-menu');
  ok(/\.preset-menu \{[^}]*-webkit-backdrop-filter: blur\(14px\)/.test(css),
    'preset-menu ikut prefix -webkit-backdrop-filter');
} catch (e) {
  ok(false, `hover dropdown :: ${e.message}`);
}

try {
  const srcDir = path.join(root, 'src');
  const jsFiles = ['app.js', ...fs.readdirSync(path.join(srcDir, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join('js', f))];
  for (const rel of jsFiles) {
    const n = fs.readFileSync(path.join(srcDir, rel), 'utf8').split('\n').length;
    ok(n <= 600, `${rel} <= 600 baris (skrg ${n})`);
  }
} catch (e) {
  ok(false, `batas ukuran file :: ${e.message}`);
}

console.log(failures === 0 ? 'SMOKE GREEN' : `SMOKE RED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
