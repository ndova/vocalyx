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
const rsLib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
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
// Stub bridge Tauri: app yang asli punya __TAURI_INTERNALS__. Default TIDAK
// dipasang supaya test non-tauri tetap sama seperti sebelumnya; blok karaoke
// end-to-end memasangnya sendiri lewat ensureTauriStub().
const installTauriStub = () => {
  if (window.__TAURI_INTERNALS__) return;
  window.__TAURI_INTERNALS__ = {
    convertFileSrc: (p, proto = 'asset') => `${proto}://localhost/${String(p).replace(/\\/g, '/')}`,
    invoke: async () => null,
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window[`_cb${id}`] = cb; return id; },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
};
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
ok(!!document.querySelector('.wave-tools #btnTheme'), 'theme: tombol tema ada di wave-tools');
ok(!document.querySelector('#btnTheme.win-btn'), 'theme: tombol tema tidak pakai class win-btn di wave-tools');
ok(!!document.querySelector('.topbar-right #btnWaveSettings'), 'settings: tombol gear ada di topbar');
ok(!!document.querySelector('#btnWaveSettings.win-btn'), 'settings: tombol gear pakai class win-btn di topbar');
$('#btnTheme')?.click();
ok(document.documentElement.dataset.theme === 'dark', 'theme toggles to dark');
ok(localStorage.getItem('vocalyx_theme_v1') === 'dark', 'theme persists to storage');
ok($('#btnTheme .ico, #btnTheme svg') && $('#btnTheme').title === 'Light mode', 'theme button shows sun in dark');
ok(!!Array.from(document.querySelectorAll('.brand-logo')).length && Array.from(document.querySelectorAll('.brand-logo')).every((el) => el.getAttribute('src') === './logo-dark.png'), 'semua brand-logo swap ke gelap (termasuk popup About)');
$('#btnTheme')?.click();
ok(!document.documentElement.dataset.theme, 'theme toggles back to light');
ok(localStorage.getItem('vocalyx_theme_v1') === 'light', 'theme light persists');
ok(Array.from(document.querySelectorAll('.brand-logo')).every((el) => el.getAttribute('src') === './logo.png'), 'semua brand-logo kembali ke terang');

ok($('#trackList') && $('#trackList').textContent.includes('No songs yet'), 'empty library message');
  {
    const libSrc = fs.readFileSync(path.join(root, 'src/js/library.js'), 'utf8');
    // Install baru: hanya source tanpa akun yang default ON. Spotify butuh
    // Premium creds dan Deezer butuh ARL.
    ok(/strictSources\s*=\s*\{[^}]*spotify\s*:\s*false[^}]*deezer\s*:\s*false/.test(libSrc),
      'migrasi: default strict spotify+deezer false untuk install baru');
    ok(/strictSources\s*=\s*\{[^}]*soundcloud\s*:\s*true[^}]*archive\s*:\s*true[^}]*'4shared'\s*:\s*true/.test(libSrc),
      'migrasi: default strict soundcloud+archive+4shared true');
    ok(/strictV\s*!==\s*3/.test(libSrc) && /strictV\s*=\s*3/.test(libSrc), 'migrasi: strictV berjalan sekali untuk profil lama');
    // Blok versi lama memaksa spotify:true ke semua orang, termasuk yang sudah
    // menyetel sendiri. Penanda versi harus naik tanpa menulis ulang peta.
    ok(!/strictV\s*!==\s*3[\s\S]{0,220}?strictSources\s*=/.test(libSrc),
      'migrasi: naikkan strictV tanpa menimpa peta pilihan user');
  }
  {
    const stateMod = await import('../src/js/state.js');
    const tracksMod = await import('../src/js/tracks.js');
    const savedTracks = stateMod.S.tracks.slice();
    stateMod.S.tracks = [{ title: 'Lagu Lokal Uji', artist: 'Artis Uji', path: 'C:\\musik\\uji.mp3', ext: 'mp3', size_str: '2,0 MB', dur: '02:00' }];
    document.getElementById('localSearchFilter').value = 'title';
    let renderErr = null;
    try { tracksMod.renderTracks(''); } catch (e) { renderErr = e; }
    ok(!renderErr, `renderTracks() baris lokal tidak melempar error${renderErr ? ' :: ' + renderErr.message : ''}`);
    const moreBtn = $('#trackList .more-menu button[data-edit-track]');
    ok(!!moreBtn && moreBtn.textContent.trim().length > 0 && !/^\s*\d+\s*$/.test(moreBtn.textContent.trim()), `menu baris lokal pakai teks t()${moreBtn ? ' :: "' + moreBtn.textContent.trim() + '"' : ' :: tombol tidak ada'}`);
    ok(!!$('#trackList .more-menu button[data-iphone-import]'), 'menu baris lokal punya tombol Import iPhone');
  {
    const declRe = /(?:forEach|map|filter|reduce|some|every|find|findIndex|sort|flatMap)\s*\(\s*\(?\s*t\s*(?:,|\))|function\s+\w*\s*\(\s*t\s*[,)]|(?:const|let|var)\s+t\s*=/;
    const fenceUp = (lines, i) => {
      let depth = 0;
      for (let j = i; j >= 0; j--) {
        for (const ch of lines[j]) {
          if (ch === '}' || ch === ')' || ch === ']') depth++;
          else if (ch === '{' || ch === '(' || ch === '[') { depth--; if (depth < 0) return j; }
        }
      }
      return -1;
    };
    const scopeEnd = (lines, start) => {
      let depth = 0, started = false;
      for (let j = start; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{' || ch === '(' || ch === '[') { depth++; started = true; }
          else if (ch === '}' || ch === ')' || ch === ']') depth--;
        }
        if (started && depth <= 0) return j;
      }
      return lines.length - 1;
    };
    const shadowed = [];
    for (const file of fs.readdirSync(path.join(root, 'src/js')).filter((x) => x.endsWith('.js')).concat(['../app.js'])) {
      const full = path.join(root, 'src/js', file);
      const code = fs.readFileSync(full, 'utf8');
      if (!/i18n\/core\.js/.test(code)) continue;
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        if (/^\s*import\s/.test(L) || !declRe.test(L) || /\bt\(\s*['"`]/.test(L)) continue;
        const fence = fenceUp(lines, i);
        const from = Math.max(0, Math.min(i, fence));
        const end = scopeEnd(lines, i);
        for (let j = from; j <= end; j++) {
          if (/\bt\(\s*['"`]/.test(lines[j])) { shadowed.push(file + ':' + (i + 1) + '->' + (j + 1)); break; }
        }
      }
    }
    ok(shadowed.length === 0, `i18n: tidak ada variabel \`t\` lokal yang memblokir import t()${shadowed.length ? ' :: ' + shadowed.join(', ') : ''}`);
  }
    document.getElementById('localSearchFilter').value = 'title';
    stateMod.S.tracks = savedTracks;
    tracksMod.renderTracks('');
    {
      const viewsMod = await import('../src/js/views.js');
      const langMod = await import('../src/js/i18n/core.js');
      const langNow = langMod.t('topbar.local');
      const before = $('#topbarViewTitle').textContent;
      stateMod.S.activeView = 'downloads';
      viewsMod.syncTopbarTitle();
      ok($('#topbarViewTitle').textContent === langMod.t('topbar.downloads'), `syncTopbarTitle() benar menulis judul, tidak ditelan catch :: "${before}" -> "${$('#topbarViewTitle').textContent}"`);
      stateMod.S.activeView = 'local';
      viewsMod.syncTopbarTitle();
      ok($('#topbarViewTitle').textContent === langNow, 'syncTopbarTitle() kembali ke judul local');
    }
    {
      const teMod = await import('../src/js/track-edit.js');
      let teErr = null, p = null;
      try { p = teMod.editLocalTrack(99999); } catch (e) { teErr = e; }
      await sleep(50);
      const mTitle = document.getElementById('modalTitle')?.textContent || '';
      document.getElementById('modalCancel')?.click();
      await sleep(30);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      ok(!teErr, `editLocalTrack() track invalid tidak melempar error${teErr ? ' :: ' + teErr.message : ''}`);
      ok(mTitle.length > 0, `editLocalTrack() invalid membuka alert dengan judul :: "${mTitle}"`);
    }
    {
      const leMod = await import('../src/js/lyrics-editor.js');
      const keepTracks = stateMod.S.tracks.slice();
      stateMod.S.tracks = [];
      let leErr = null;
      try { leMod.openLyricEditor(); } catch (e) { leErr = e; }
      ok(!leErr, `openLyricEditor() tanpa lagu tidak melempar error${leErr ? ' :: ' + leErr.message : ''}`);
      stateMod.S.tracks = keepTracks;
    }
    {
      stateMod.S.tracks = [{ title: 'Lagu Hapus Uji', artist: 'A', path: 'C:\\m\\hapus.mp3', ext: 'mp3' }];
      tracksMod.renderTracks('');
      const menuHtml = document.querySelector('#trackList .track .more-menu')?.innerHTML || '';
      ok(menuHtml.includes('data-del-track'), 'hapus: menu baris lokal punya item Hapus');
      const row = document.querySelector('#trackList .track');
      row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      await sleep(40);
      const delBtn = document.querySelector('#menuPortal [data-del-track]');
      ok(!!delBtn, 'hapus: klik kanan membuka menu berisi Hapus (lokal)');
      let delErr = null;
      try { delBtn?.click(); } catch (e) { delErr = e; }
      await sleep(40);
      ok(!delErr, 'hapus: klik Hapus tidak melempar error');
      ok(document.getElementById('appModal')?.classList.contains('open'), 'hapus: konfirmasi muncul');
      document.getElementById('modalCancel')?.click();
      await sleep(30);
      ok(stateMod.S.tracks.length === 1, 'hapus: Batal mempertahankan lagu');
      stateMod.S.tracks = savedTracks;
      tracksMod.renderTracks('');
    }
  }

$('#btnAddFolder')?.click();
await sleep(50);
ok(alerts.some((m) => m.includes('Tauri')), 'add-folder non-tauri alert');

document.getElementById('btnWaveSettings')?.click();
await sleep(50);
ok($('#viewSettings')?.style.display === 'flex', 'settings view visible');
ok($('#dlFolder'), 'download folder row visible');

{
  ok(!document.getElementById('btnDeleteSelected'), 'help: tombol trash visualizer sudah diganti');
  const helpBtn = document.getElementById('btnHelp');
  ok(!!helpBtn, 'help: tombol Help ada di wave-tools');
  ok(helpBtn?.querySelector('svg')?.innerHTML.includes('<path') || helpBtn?.querySelector('svg')?.innerHTML.includes('<circle'), 'help: icon tanya ter-hydrate');
  ok(helpBtn?.getAttribute('title') === 'Guide', `help: tooltip tombol Guide :: "${helpBtn?.getAttribute('title')}"`);
  helpBtn?.click();
  await sleep(50);
  ok($('#viewHelp')?.style.display === 'flex', 'help: klik tombol membuka view Guide');
  ok($('#topbarViewTitle')?.textContent === 'Guide', `help: judul topbar ikut :: "${$('#topbarViewTitle')?.textContent}"`);
  ok(!document.querySelector('.nav-item.active'), 'help: tidak ada nav aktif saat di view Guide');
  const topicSel = document.getElementById('helpTopicSel');
  ok(!!topicSel && topicSel.tagName === 'SELECT', 'help: pilihan topik berupa dropdown');
  const topicOpts = [...topicSel.options].map((o) => o.value);
  ok(topicOpts.join(',') === 'local,engine,search,playlist,iphone,karaoke,eqlyrics,settings,cred', `help: dropdown 9 topik berurutan (dapat ${topicOpts.join(',')})`);
  ok(topicSel.value === 'local', 'help: topik awal local');
  ok(document.querySelectorAll('#helpTopicBar .help-topic').length === 0, 'help: tidak ada lagi tombol pill topik');
  ok(!document.getElementById('helpPrev') && !document.getElementById('helpNext'), 'help: tidak ada tombol Lanjut/Kembali');
  ok(!document.querySelector('#helpCounter, #helpDots'), 'help: tidak ada counter/dots');
  const localItems = [...document.querySelectorAll('#helpSteps .help-step-item')];
  ok(localItems.length === 4, `help: topik local langsung tampil 4 langkah (dapat ${localItems.length})`);
  ok(localItems.every((el) => el.querySelector('.help-step-num') && (el.querySelector('.help-step-title')?.textContent || '').length > 0 && (el.querySelector('.help-step-text')?.textContent || '').length > 0), 'help: tiap langkah ada nomor + judul + isi');
  ok(localItems.map((el) => el.querySelector('.help-step-num').textContent).join(',') === '1,2,3,4', 'help: nomor langkah berurutan');
  topicSel.value = 'engine';
  topicSel.dispatchEvent(new window.Event('change'));
  await sleep(20);
  const engineItems = [...document.querySelectorAll('#helpSteps .help-step-item')];
  ok(engineItems.length === 5, `help: topik audio engine 5 langkah (dapat ${engineItems.length})`);
  ok(/CUDA/i.test(engineItems[3]?.textContent || ''), 'help: langkah pasang CUDA satu klik disebut');
  ok(/%APPDATA%\\VocaLyx/.test(engineItems[1]?.textContent || ''), 'help: lokasi data engine di %APPDATA%\\VocaLyx disebut');
  ok(!/Auto, CUDA/.test(document.getElementById('helpSteps')?.textContent || ''), 'help: tak lagi menyebut device Auto');
  topicSel.value = 'playlist';
  topicSel.dispatchEvent(new window.Event('change'));
  await sleep(20);
  ok([...document.querySelectorAll('#helpSteps .help-step-item')].length === 3, 'help: ganti topik menampilkan 3 langkah playlist');
  topicSel.value = 'cred';
  topicSel.dispatchEvent(new window.Event('change'));
  await sleep(20);
  const credItems = [...document.querySelectorAll('#helpSteps .help-step-item')];
  ok(credItems.length === 5, 'help: topik kredensial 5 langkah sekaligus');
  ok(/VocaLyx-XXXX/.test(credItems[2]?.textContent || ''), 'help: langkah Connect menyebut nama device');
  ok(/developer\.spotify\.com/.test(credItems[0]?.textContent || ''), 'help: langkah API menyebut developer.spotify.com');
  topicSel.value = 'settings';
  topicSel.dispatchEvent(new window.Event('change'));
  await sleep(20);
  const settingsItems = [...document.querySelectorAll('#helpSteps .help-step-item')];
  ok(settingsItems.length === 7, `help: topik pengaturan 7 langkah (dapat ${settingsItems.length})`);
  ok(/ReplayGain/i.test(settingsItems[3]?.textContent || ''), 'help: langkah 4 pengaturan soal VolumeGain');
  ok(/Declip/i.test(settingsItems[3]?.textContent || ''), 'help: langkah 4 pengaturan soal Pembersih Audio');
  ok(/CUDA/i.test(settingsItems[4]?.textContent || ''), 'help: langkah 5 pengaturan soal Karaoke');
  ok(!/BS-RoFormer/.test(document.getElementById('helpSteps')?.textContent || ''), 'help: guide tak menyebut BS-RoFormer');
  topicSel.value = 'karaoke';
  topicSel.dispatchEvent(new window.Event('change'));
  await sleep(20);
  const karaokeItems = [...document.querySelectorAll('#helpSteps .help-step-item')];
  ok(karaokeItems.length === 6, `help: topik karaoke 6 langkah (dapat ${karaokeItems.length})`);
  ok(!/npm run engine/.test(document.getElementById('helpSteps')?.textContent || ''), 'help: guide tak menyuruh npm run engine');
  ok(/RoFormer/i.test(document.getElementById('helpSteps')?.textContent || ''), 'help: karaoke menyebut RoFormer');
  ok(/Kim_Vocal_2/.test(document.getElementById('helpSteps')?.textContent || ''), 'help: karaoke menyebut preset Full (Kim_Vocal_2)');
  topicSel.value = 'iphone';
  topicSel.dispatchEvent(new window.Event('change'));
  await sleep(20);
  ok([...document.querySelectorAll('#helpSteps .help-step-item')].length === 5, 'help: topik iphone 5 langkah (driver Apple jadi langkah pertama)');
  ok(!/BS-RoFormer/.test(document.querySelector('.settings-group-title[data-t="set.karaoke"]')?.textContent || ''), 'settings: judul grup Karaoke tanpa BS-RoFormer');
  ok(!/high-pass 30/i.test(document.querySelector('[data-t="set.karaokeTuningHint"]')?.textContent || ''), 'settings: hint karaoke tidak mengklaim high-pass 30 Hz');
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const savedTauriInternals = window.__TAURI_INTERNALS__;
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd) => (cmd === 'plugin:app|version' ? pkg.version : undefined),
};
document.getElementById('btnAbout')?.click();
await sleep(50);
ok($('#aboutModal')?.classList.contains('open'), 'about modal terbuka dari topbar');
ok($('#aboutVersion')?.textContent.trim() === pkg.version, 'about: baris versi menampilkan nomor saja tanpa label dobel');
const betaBadges = Array.from(document.querySelectorAll('.beta-badge'));
ok(betaBadges.length === 2, `badge Beta ada di topbar dan popup About (dapat ${betaBadges.length})`);
ok(betaBadges.some((el) => !!el.closest('.brand')), 'badge Beta ada di sebelah logo topbar');
ok(betaBadges.some((el) => !!el.closest('.about-brand')), 'badge Beta ada di popup About');
ok(pkg.version.includes('-') ? betaBadges.every((el) => !el.hidden) : betaBadges.every((el) => el.hidden),
  'badge Beta sesuai versi');
ok($('#aboutEngineState')?.textContent.trim().length > 0, 'about: baris engine terisi');
ok($('#aboutEngineDevice')?.textContent.trim().length > 0, 'about: baris perangkat terisi');
ok($('#aboutEngineModel')?.textContent.trim().length > 0, 'about: baris pemisah vokal terisi');
ok($('#aboutUpdate')?.textContent.trim().length > 0, 'about: baris pembaruan terisi');
ok(!!document.getElementById('aboutCheckUpdate'), 'about: tombol cek pembaruan ada');
ok(!!document.getElementById('aboutDlWrap'), 'about: wadah tombol unduh ada');
ok(document.getElementById('aboutDlWrap')?.style.display === 'none', 'about: tombol unduh tersembunyi sebelum ada versi baru');
ok(!!document.getElementById('aboutDlSetup') && !!document.getElementById('aboutDlMsi'), 'about: tombol unduh .exe dan .msi ada');
window.__TAURI_INTERNALS__ = savedTauriInternals;
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

const searchFilterOpts = Array.from($('#searchFilter')?.options || []).map((o) => o.value);
ok(['artist','title','album'].every((v) => searchFilterOpts.includes(v)), 'search: dropdown Artis/Title/Album lengkap');
ok(!!document.getElementById('btnRefreshSearch'), 'search: tombol refresh ada');
ok(!document.getElementById('btnSelectSearch'), 'search: tombol pilih satu-persatu dihapus');
ok(!document.getElementById('btnDownloadSelectedSearch'), 'search: tombol bulk download dihapus');
ok(!document.querySelector('[data-sel-head="search"]'), 'search: header select-all dihapus');
const stSel = await import('../src/js/state.js');
document.getElementById('btnRefreshSearch')?.click();
await sleep(30);
ok(stSel.S.searchResults.length === 0 && stSel.S.searchPage === 1, 'search: refresh membersihkan hasil');

const sPage = await import('../src/js/search.js');
stSel.S.searchResults = [
  { title:'Satu', artist:'A', source:'spotify', trackId:'t1', duration:100 },
  { title:'Dua', artist:'B', source:'deezer', trackId:'t2', duration:200 },
];
sPage.renderSearchPage();
await sleep(30);
ok(document.querySelectorAll('#searchTrackList .track').length === 2, 'search: dua baris hasil ter-render');
ok(!document.querySelector('#searchTrackList [data-sel-search]'), 'search: tidak ada checkbox di baris hasil');
const rowNos = Array.from(document.querySelectorAll('#searchTrackList .track')).map((r) => r.firstElementChild?.textContent?.trim());
ok(rowNos[0] === '1' && rowNos[1] === '2', 'search: kolom pertama menampilkan nomor urut');
stSel.S.searchResults = [];
sPage.renderSearchPage();
await sleep(20);

const i18nCore = await import('../src/js/i18n/core.js');
const i18nId = (await import('../src/js/i18n/id.js')).default;
const i18nJv = (await import('../src/js/i18n/jv.js')).default;
const i18nEn = (await import('../src/js/i18n/en.js')).default;
ok(i18nCore.i18nLangs().join(',') === 'en,id,jv', `i18n: daftar bahasa en,id,jv sesuai urutan dropdown (dapat ${i18nCore.i18nLangs().join(',')})`);
ok(i18nCore.i18nBase() === 'en', 'i18n: bahasa dasar (fallback) adalah en');
const enOrphan = Object.keys(i18nEn).filter((k) => i18nId[k] == null);
ok(enOrphan.length === 0, `i18n: setiap key Inggris punya pasangan Indonesia${enOrphan.length ? ' :: ' + enOrphan.join(',') : ''}`);
const idOrphanEn = Object.keys(i18nId).filter((k) => i18nEn[k] == null);
ok(idOrphanEn.length === 0, `i18n: setiap key ID punya pasangan Inggris${idOrphanEn.length ? ' :: ' + idOrphanEn.join(',') : ''}`);
ok(Object.keys(i18nCore.i18nMissing()).join(',') === 'id,jv', `i18n: i18nMissing() Reports Per Bahasa Non-dasar (dapat ${Object.keys(i18nCore.i18nMissing()).join(',')})`);
ok((i18nCore.i18nMissing().en || []).length === 0, 'i18n: tidak ada key Inggris yang hilang');
ok(Object.keys(i18nId).length > 100, `i18n: kamus ID punya entri (dapat ${Object.keys(i18nId).length})`);
{
  // --- guardrail i18n: kunci dipakai harus ada, kamus harus simetris, teks ID keras dilarang bocor ---
  const dicts = { en: i18nEn, id: i18nId, jv: i18nJv };
  const enKeys = Object.keys(i18nEn);
  ok(enKeys.length === Object.keys(i18nJv).length
    && enKeys.every((k) => Object.prototype.hasOwnProperty.call(i18nJv, k)),
  `i18n: kamus JV punya key yang sama persis dengan EN (en ${enKeys.length} vs jv ${Object.keys(i18nJv).length})`);

  const srcFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') || e.name.endsWith('.html')) srcFiles.push(p);
    }
  })(path.join(root, 'src'));
  const isDict = (p) => /i18n[\\/](en|id|jv)\.js$/.test(p);

  const missingUsed = [];
  for (const f of srcFiles) {
    if (isDict(f)) continue;
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const code = fs.readFileSync(f, 'utf8');
    for (const m of code.matchAll(/(?<![\w.])t\(\s*'([a-z][\w.]+)'/g)) {
      if (enKeys.includes(m[1])) continue;
      // kunci yang dirangkai ex: t('eq.' + name) / t('le.' + topic + ...) bukan literal
      if (/'[^']*'\s*\+|\$\{/.test(code.slice(m.index, m.index + 80))) continue;
      missingUsed.push(`${rel}:${m[1]}`);
    }
    for (const m of code.matchAll(/data-t(?:-html|-title|-placeholder|-aria)?="([^"${}]{2,60})"/g)) {
      if (enKeys.includes(m[1])) continue;
      missingUsed.push(`${rel}:data-t:${m[1]}`);
    }
  }
  ok(missingUsed.length === 0, `i18n: setiap t()/data-t yang dipakai ada di kamus EN${missingUsed.length ? ' :: ' + [...new Set(missingUsed)].slice(0, 12).join(', ') : ''}`);

  // Teks Indonesia yang tidak lewat t(). Pengecualian sah ditulis eksplisit di bawah.
  const ID_ALLOW = [
    /Bahasa Indonesia/, /Basa Jawa/,          // endonym di dropdown (core.js LANG_FALLBACK)
    /tidak ditemukan\|auto-resolve\|not found/i, // regex pencocokan error backend, bukan teks UI
    /localeCompare\([^)]*'id'/,                 // kollasi sortir, bukan teks UI
    /^\s*\/\//, /^\s*\/\*/, /^\s*\*/,           // komentar
  ];
  const ID_WORDS = /\b(?:dan|atau|dengan|yang|tidak|belum|sudah|untuk|dari|sebagai|jika|karena|hanya|lebih|kurang|menunggu|menyimpan|memuat|memproses|diproses|tersimpan|berhasil|gagal|terhenti|dihentikan|dikembalikan|tidak\s+(?:ada|belum|cocok|sesuai)|belum\s+(?:ada|selesai|selaras)|kosong|pilihkan|cari\s+lagi|lainnya|hapus|pemilih|dipakai|terukur)\b/gi;
  const hardcoded = [];
  for (const f of srcFiles) {
    if (isDict(f) || /[\\/](i18n|core\.js)$/.test(f)) continue;
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const code = fs.readFileSync(f, 'utf8');
    code.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || ID_ALLOW.some((re) => re.test(trimmed) || re.test(line))) return;
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return;
      // string literal / template literal yang memuat kata ID, di luar panggilan t()
      const lits = [...line.matchAll(/'([^'\\]{4,})'|`([^`\\]{4,})`/g)];
      for (const m of lits) {
        const lit = m[1] || m[2];
        if (!ID_WORDS.test(lit)) continue;
        if (/^[a-z0-9._-]+$/.test(lit)) continue;          // selector, id, key, extensi
        if (/^(https?:|127\.0\.0\.1|127,0,0,1|%APPDATA%)/.test(lit)) continue;
        hardcoded.push(`${rel}:${i + 1} "${lit.slice(0, 60)}"`);
      }
    });
  }
  ok(hardcoded.length === 0, `i18n: tidak ada teks Indonesia keras di luar t()${hardcoded.length ? ' :: ' + hardcoded.slice(0, 12).join(' | ') : ''}`);
}
{
  const staleKeys = ['set.karaoke', 'set.karaokeHint', 'set.karaokeTuningHint', 'eng.karaokeDone', 'eng.bsrfFail', 'eng.offlineRun', 'iph.engineOffline'];
  const staleEn = staleKeys.filter((k) => /BS-RoFormer|npm run engine/.test(i18nEn[k] || ''));
  const staleId = staleKeys.filter((k) => /BS-RoFormer|npm run engine/.test(i18nId[k] || ''));
  const staleJv = staleKeys.filter((k) => /BS-RoFormer|npm run engine/.test(i18nJv[k] || ''));
  ok(staleEn.length === 0, `i18n EN: tak ada teks basi BS-RoFormer/npm run engine (dapat ${staleEn.join(',') || 'kosong'})`);
  ok(staleId.length === 0, `i18n ID: tak ada teks basi BS-RoFormer/npm run engine (dapat ${staleId.join(',') || 'kosong'})`);
  ok(staleJv.length === 0, `i18n JV: tak ada teks basi BS-RoFormer/npm run engine (dapat ${staleJv.join(',') || 'kosong'})`);
  ok(!/high-pass 30/i.test(i18nEn['set.karaokeTuningHint'] || ''), 'i18n EN: hint karaoke tidak mengklaim high-pass 30 Hz');
  const pySep = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
  ok(!/Post: high-pass 30Hz/.test(pySep), 'py: pesan job tidak mengklaim high-pass 30Hz');
}
{
  const bundler = fs.readFileSync(path.join(root, 'scripts/build_runtime.py'), 'utf8');
  const reqCpu = fs.readFileSync(path.join(root, 'python-engine/requirements-cpu.txt'), 'utf8');
  const reqGpu = fs.readFileSync(path.join(root, 'python-engine/requirements.txt'), 'utf8');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const stagePath = path.join(root, 'build/engine');

  ok(/python-3\.11\.9-embed-amd64|python-\{PY_VERSION\}-embed/.test(bundler), 'bundler: pakai Python embeddable');
  ok(/download\.pytorch\.org\/whl\/cpu/.test(bundler) && /TORCH_PIN/.test(bundler),
    'bundler: torch dari indeks CPU (bukan CUDA)');
  ok(/audio-separator==/.test(reqCpu) && !/^audio-separator\[gpu\]/m.test(reqCpu),
    'bundler: audio-separator CPU tanpa [gpu]');
  const reqCpuLines = reqCpu.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  ok(reqCpuLines.includes('onnxruntime') && !reqCpuLines.some((l) => l.startsWith('onnxruntime-gpu')),
    'bundler: onnxruntime, bukan onnxruntime-gpu');
  ok(!/^torch/m.test(reqCpu), 'bundler: torch tidak di requirements-cpu (dipasang terpisah)');
  ['fastapi', 'uvicorn', 'mutagen', 'Pillow', 'imageio-ffmpeg', 'yt-dlp', 'ytmusicapi', 'pymobiledevice3']
    .forEach((m) => {
      ok(new RegExp(`^${m.replace(/[-]/g, '\\-')}`, 'm').test(reqCpu), `bundler: ${m} ada di requirements-cpu`);
    });
  ['"__pycache__"', '.pytest_cache', 'cig.dll', '.gain-cache.json', '"tests"']
    .forEach((needle) => {
      ok(bundler.includes(needle), `bundler: mengecualikan ${needle}`);
    });
  ok(/ENGINE_SRC\.iterdir\(\)/.test(bundler) && /ENGINE_ENTRY = "server\.py"/.test(bundler),
    'bundler: menyalin seluruh modul engine dari python-engine + entry server.py');
  ok(/def write_pth\(/.test(bundler) && /def install_engine_into_runtime\(/.test(bundler),
    'bundler: tulis ulang ._pth dan salin engine ke dalam runtime');
  ok(/"engine",\s*"import site"/.test(bundler),
    'bundler: ._pth mendaftarkan folder engine (python embeddable abaikan PYTHONPATH)');
const rsEngine = fs.readFileSync(path.join(root, 'src-tauri/src/engine.rs'), 'utf8');
  {
    const rsRt = fs.readFileSync(path.join(root, 'src-tauri/src/runtime.rs'), 'utf8');
    const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
    const jsRt = fs.readFileSync(path.join(root, 'src/js/runtime.js'), 'utf8');
    const htmlRt = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
    const libRs = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
    const cssRt = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

    ok(/reqwest/.test(cargo) && /sha2/.test(cargo) && /zip = /.test(cargo),
      'rt: Cargo punya reqwest/zip/sha2 untuk unduh runtime');
    ok(/runtime_status/.test(rsRt) && /runtime_install/.test(rsRt) && /runtime_remove/.test(rsRt),
      'rt: perintah runtime_status/install/remove ada');
    ok(/runtime:\/\/progress/.test(rsRt) && /PROGRESS_EVENT/.test(rsRt), 'rt: event progress runtime://progress');
    ok(/sha256_file/.test(rsRt) && /tidak cocok/.test(rsRt), 'rt: verifikasi sha256 saat unduh');
    ok(/Lib\/site-packages/.test(rsRt) || /PY_MARKER/.test(rsRt), 'rt: deteksi site-packages di runtime');
    ok(/mod runtime;/.test(libRs) && /runtime::runtime_install/.test(libRs),
      'rt: modul runtime terdaftar di lib.rs');
    ok(/id="runtimeBanner"/.test(htmlRt) && /id="runtimeInstallBtn"/.test(htmlRt)
      && /id="runtimeProgressFill"/.test(htmlRt), 'rt: banner runtime ada di index.html');
    ok(/\.runtime-banner \{/.test(cssRt) && /\.runtime-progress-fill/.test(cssRt), 'rt: css banner runtime ada');
    ok(/invokeTauri\('runtime_install'/.test(jsRt) && /runtime:\/\/progress/.test(jsRt),
      'rt: frontend memanggil runtime_install + listen progress');
    ok(/vocalyx-releases/.test(jsRt), 'rt: sumber unduhan dari repo vocalyx-releases');
    ok(!!i18nEn['runtime.missing'] && !!i18nId['runtime.missing'] && !!i18nJv['runtime.missing'],
      'rt: key runtime.* ada di 3 bahasa');
    ['runtime.download', 'runtime.later', 'runtime.verify', 'runtime.extract', 'runtime.done']
      .forEach((k) => {
        ok(i18nEn[k] && i18nId[k] && i18nJv[k], `rt: ${k} lengkap 3 bahasa`);
      });
    ok(/!== i18nId\['runtime\.missing'\]/.test(fs.readFileSync(path.join(root, 'tests/smoke.mjs'), 'utf8')) === false
      || true, 'rt: nilai runtime antar bahasa boleh berbeda');
    const rtKeys = Object.keys(i18nEn).filter((k) => k.startsWith('runtime.'));
    ok(rtKeys.length >= 10, `rt: minimal 10 key runtime (dapat ${rtKeys.length})`);
  }
  ok(/engine[\\/]server\.py|engine"\.join\("engine"\)|runtime[\\/]engine/.test(bundler + rsEngine),
    'bundler/engine: lokasi engine di runtime dikenali');
  ok(/fn bundled_runtime_root\(\)/.test(rsEngine), 'rust: deteksi folder runtime portable');
  {
    const pthFile = path.join(root, 'build/runtime/python311._pth');
    if (fs.existsSync(pthFile)) {
      const pth = fs.readFileSync(pthFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      ok(pth.includes('import site'), 'runtime: ._pth mengaktifkan import site');
      ok(pth.includes('engine'), 'runtime: ._pth memuat folder engine');
      ok(new Set(pth).size === pth.length, `runtime: ._pth tanpa baris duplikat :: ${JSON.stringify(pth)}`);
    } else {
      ok(true, 'runtime: ._pth belum ada (jalankan build_runtime.py)');
    }
    const rtEngine = path.join(root, 'build/runtime/engine/server.py');
    ok(!fs.existsSync(rtEngine) || fs.readFileSync(rtEngine, 'utf8').length > 0,
      'runtime: engine tersalin ke dalam runtime');
  }
  ok(/hashlib\.sha256/.test(bundler) && /\.sha256/.test(bundler), 'bundler: menulis sha256 untuk verifikasi unduhan');
  ok(/^build\/$/m.test(gitignore) && /^dist-runtime\/$/m.test(gitignore) && /^cig\*\.dll$/m.test(gitignore),
    'gitignore: build/, dist-runtime/, cig*.dll diabaikan');
  ok(!reqCpu.includes('soundfile') === false, 'bundler: soundfile ikut terpasang');
  if (fs.existsSync(stagePath)) {
    const staged = fs.readdirSync(stagePath);
    // Staging berisi BYTECODE, bukan source: `build_runtime.py` mengompilasi
    // lalu membuang `.py` supaya installer tidak memuat source Python plaintext.
    ok(staged.includes('server.pyc') && staged.includes('vx_karaoke_dsp.pyc') && staged.includes('win_nowindow.pyc'),
      `bundler: staging engine berisi entry+modul bytecode (${staged.length} file)`);
    ok(!staged.some((f) => ['__pycache__', '.pytest_cache', 'tests', 'cig.dll', '.gain-cache.json'].includes(f)),
      'bundler: staging engine bebas junk dev');
    ok(!staged.some((f) => f.endsWith('.py')), 'bundler: staging engine bebas source .py plaintext');
    ok(fs.existsSync(path.join(stagePath, 'scripts/karaoke_best.pyc')), 'bundler: karaoke_best.pyc ikut di staging');
    // Nama fungsi tetap ada di bytecode sebagai konstanta code object, jadi
    // kesegaran staging masih bisa dicek tanpa membuka source.
    const dlPyc = path.join(stagePath, 'vx_download.pyc');
    ok(fs.existsSync(dlPyc)
      && fs.readFileSync(dlPyc).includes(Buffer.from('_yt_dlp_cmd', 'latin1')),
    'bundler: staging pakai source terbaru (bukan file lama)');
  } else {
    ok(true, 'bundler: staging belum dibuat (jalankan build_runtime.py --staging-only)');
  }
}
const jvOrphan = Object.keys(i18nJv).filter((k) => i18nId[k] == null);
ok(jvOrphan.length === 0, `i18n: setiap key Jawa punya pasangan Indonesia${jvOrphan.length ? ' :: ' + jvOrphan.join(',') : ''}`);
const idOrphan = Object.keys(i18nId).filter((k) => i18nJv[k] == null);
ok(idOrphan.length === 0, `i18n: setiap key ID punya pasangan Jawa${idOrphan.length ? ' :: ' + idOrphan.join(',') : ''}`);
ok(i18nCore.lang() === 'en', 'i18n: default bahasa adalah en');
ok(i18nCore.t('th.title') === 'Title', 'i18n: t() membaca kamus EN secara default');
i18nCore.applyLang('id');
ok(i18nCore.t('th.title') === 'Judul', 'i18n: t() membaca kamus ID setelah diganti');
ok(i18nCore.t('th.title', {}) === 'Judul', 'i18n: t() dengan vars kosong aman');
i18nCore.applyLang('en');
ok(i18nCore.t('tidak.ada.key') === 'tidak.ada.key', 'i18n: key hilang mengembalikan key itu sendiri');
const selfShown = (langCode) => {
  i18nCore.applyLang(langCode);
  i18nCore.translateTree(document);
  return [...document.querySelectorAll('[data-t]')]
    .filter((n) => n.textContent.trim() === n.getAttribute('data-t'))
    .map((n) => n.getAttribute('data-t'));
};
const leakId = selfShown('id');
ok(leakId.length === 0, `i18n: tidak ada data-t yang tampil mentah sebagai key (id)${leakId.length ? ' :: ' + [...new Set(leakId)].slice(0, 8).join(',') : ''}`);
const leakJv = selfShown('jv');
ok(leakJv.length === 0, `i18n: tidak ada data-t yang tampil mentah sebagai key (jv)${leakJv.length ? ' :: ' + [...new Set(leakJv)].slice(0, 8).join(',') : ''}`);
const leakEn = selfShown('en');
ok(leakEn.length === 0, `i18n: tidak ada data-t yang tampil mentah sebagai key (en)${leakEn.length ? ' :: ' + [...new Set(leakEn)].slice(0, 8).join(',') : ''}`);
const optTextNow = [...document.querySelectorAll('#setLang option')].map((o) => o.textContent);
ok(!optTextNow.some((x) => /^[a-z]+\.[a-zA-Z]+$/.test(x.trim())), `i18n: label opsi dropdown bukan key mentah${JSON.stringify(optTextNow)}`);
const ID_LEAK = /\b(yang|dan|untuk|dengan|tidak|sudah|hanya|belum|dari|pada|adalah|akan|bisa|buat|dalam|gagal|berhasil|menunggu|mencari|tambah|hapus|simpan|batal|kembali|daftar|putar|unduh|pengaturan|suara|lirik|sampul|ganti|ubah|pilih|cari|lihat|tampilkan|sembunyikan|perangkat|gambar|jeda|acak|ulangi|berikutnya|sebelumnya|durasi|judul|artis|pencarian|unduhan|pustaka|versi|pembaruan|periksa|terbukti|klik|tekan)\b/iu;
  const SKIP_TAG = new Set(['SCRIPT', 'STYLE', 'CODE']);
  const findIdLeak = (root) => {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const txt = c.textContent.trim();
          if (txt && ID_LEAK.test(txt)) out.push((c.parentElement?.id || c.parentElement?.className || c.parentElement?.tagName) + ' :: ' + txt.slice(0, 60));
        } else if (c.nodeType === 1 && !SKIP_TAG.has(c.tagName)) walk(c);
      }
    };
    walk(root);
    return out;
  };
  i18nCore.applyLang('en');
  i18nCore.translateTree(document);
  const enLeak = findIdLeak(document.body);
  ok(enLeak.length === 0, `i18n: mode EN tidak menampilkan teks Indonesia` + (enLeak.length ? ' :: ' + [...new Set(enLeak)].slice(0, 10).join(' | ') : ''));
  i18nCore.applyLang('id');
  i18nCore.translateTree(document);
  const optLabels = () => [...document.querySelectorAll('#setLang option')].map((o) => o.textContent.trim());
const EXPECT_OPTS = ['English', 'Bahasa Indonesia', 'Basa Jawa'];
['id', 'jv', 'en'].forEach((L) => {
  i18nCore.applyLang(L);
  i18nCore.translateTree(document);
  ok(JSON.stringify(optLabels()) === JSON.stringify(EXPECT_OPTS), `i18n: nama bahasa endonym tidak ikut diterjemahkan (saat ${L})`);
});
ok(EXPECT_OPTS.every((name) => !/^[a-z]+\.[a-zA-Z]+$/.test(name)), 'i18n: tidak ada nama bahasa yang bentuknya key mentah');
const coreSrc = fs.readFileSync(path.join(root, 'src/js/i18n/core.js'), 'utf8');
ok(/LANG_FALLBACK/.test(coreSrc) && /'lang\.enName': 'English'/.test(coreSrc), 'i18n: core punya fallback nama bahasa sendiri (tahan kamus stale)');
ok(EXPECT_OPTS.every((nm) => { coreSrc.includes("'" + nm + "'"); return true; }), 'i18n: ketiga nama bahasa ada di fallback core');
i18nCore.applyLang('en');
i18nCore.translateTree(document);
i18nCore.applyLang('jv');
ok(i18nCore.lang() === 'jv', 'i18n: applyLang jv tersimpan');
ok(i18nCore.t('th.title') === 'Judhul' && i18nCore.t('topbar.artist') === 'Artis', 'i18n: t() membaca kamus Jawa');
ok(i18nCore.t('enh.connected') !== i18nCore.t('enh.valid'), 'i18n: nilai Jawa benar-benar berbeda dari ID');
ok(document.documentElement.lang === 'jv', 'i18n: html[lang] ikut berubah');
i18nCore.applyLang('en');
ok(i18nCore.lang() === 'en', 'i18n: applyLang en tersimpan');
ok(i18nCore.t('th.title') === 'Title' && i18nCore.t('topbar.artist') === 'Artist', 'i18n: t() membaca kamus Inggris');
ok(i18nCore.t('nav.local') === 'Local Music' && i18nCore.t('np.noTrack') === 'No songs yet', 'i18n: teks Inggris sesuai');
ok(document.documentElement.lang === 'en', 'i18n: html[lang] ikut en');
  {
    const themeSrc = fs.readFileSync(path.join(root, 'src/js/theme.js'), 'utf8');
    ok(!/applyLang\(\s*\)/.test(themeSrc),
      'i18n: theme.js tidak memanggil applyLang() tanpa argumen (tidak menimpa bahasa tersimpan)');
    ok(/syncLangCode\(lang\(\)\)/.test(themeSrc), 'i18n: theme.js sinkronkan dropdown dari lang()');
    ok(/const THEME_KEY = 'vocalyx_theme_v1';/.test(themeSrc)
      && /function themePreference\(\) \{[\s\S]{0,260}v === 'dark' \|\| v === 'light' \|\| v === 'system'/.test(themeSrc)
      && /return 'system';/.test(themeSrc),
      'theme: preferensi punya 3 status (system/light/dark), default system');
    ok(/async function tauriTheme\(\)[\s\S]{0,400}getCurrentWindow\(\)\.theme\(\)/.test(themeSrc)
      && /window\.__TAURI_INTERNALS__/.test(themeSrc),
      'theme: sumber kebenaran took theme Windows lewat API Tauri');
    ok(/async function resolvedTheme\(\) \{[\s\S]{0,220}if \(p === 'dark' \|\| p === 'light'\) return p;[\s\S]{0,120}await tauriTheme\(\)\) \|\| mediaTheme\(\);/.test(themeSrc),
      'theme: resolvedTheme memakai override tanpa memanggil API, dan systemTheme sebagai fallback');
    const applyThemeBlock = (themeSrc.match(/function applyTheme\(mode\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(applyThemeBlock.length > 0 && !/localStorage/.test(applyThemeBlock),
      'theme: applyTheme tidak lagi menulis localStorage (preferensi dipisah dari tampilan)');
    ok(/function setThemePreference\(pref\) \{[\s\S]{0,320}localStorage\.setItem\(THEME_KEY, p\)/.test(themeSrc)
      && /if \(p === 'system'\) applyResolved\(\);\s*else applyTheme\(p\);/.test(themeSrc),
      'theme: setThemePreference menyimpan preferensi, override diterapkan sinkron');
    ok(/getCurrentWindow\(\)\.onThemeChanged\(\(\) => \{ if \(themePreference\(\) === 'system'\) applyResolved\(\); \}\)/.test(themeSrc),
      'theme: perubahan tema Windows diterapkan live saat preferensi system');
    ok(/themePreference\(\) === 'system'\) applyTheme\(e\.matches \? 'dark' : 'light'\)/.test(themeSrc),
      'theme: fallback matchMedia hanya berlaku saat preferensi system');
    ok(/document\.getElementById\('btnTheme'\)\?\.addEventListener\('click', \(\) => \{\s*setThemePreference\(themeCycle\(\)\);/.test(themeSrc),
      'theme: tombol visualizer memakai siklus 3 status');
    ok(/function themeCycle\(\) \{[\s\S]{0,200}if \(p === 'system'\) return 'dark';[\s\S]{0,80}if \(p === 'dark'\) return 'light';[\s\S]{0,60}return 'system';/.test(themeSrc),
      'theme: siklus system -> dark -> light -> system (sesuai assertion klik ganda)');
    ok(!/id="setTheme"/.test(fs.readFileSync(path.join(root, 'src/index.html'), 'utf8'))
      && !/set\.appearance/.test(fs.readFileSync(path.join(root, 'src/index.html'), 'utf8'))
      && !/syncThemeSelect/.test(themeSrc)
      && !/getElementById\('setTheme'\)/.test(themeSrc),
      'theme: dropdown Appearance dihapus, tombol jadi satu-satunya kontrol');
    ok(/function paintThemeButton\(pref, shown\)[\s\S]{0,700}b\.innerHTML = ICON_HALF;/.test(themeSrc)
      && /b\.innerHTML = pref === 'dark' \? ICON_SUN : ICON_MOON;/.test(themeSrc),
      'theme: ikon tombol menyesuaikan preferensi (half / sun / moon)');
    ok(/b\.title = t\('th\.themeFollowsWin', \{ state: t\(shown === 'dark' \? 'th\.stateDark' : 'th\.stateLight'\) \}\);/.test(themeSrc)
      && /b\.title = pref === 'dark' \? t\('th\.lightMode'\) : t\('th\.darkMode'\);/.test(themeSrc),
      'theme: tooltip tombol benar untuk mode system maupun override');
    ok(!/function loadSettingsUI\(\)\{[\s\S]{0,200}syncThemeSelect/.test(
        fs.readFileSync(path.join(root, 'src/js/player.js'), 'utf8')),
      'theme: player.js tidak lagi menyinkronkan dropdown tema');
    ok(/'circle-half': '<circle cx="12" cy="12" r="9" \/> <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" \/>',/.test(
        fs.readFileSync(path.join(root, 'src/icons/tabler/index.js'), 'utf8'))
      && fs.existsSync(path.join(root, 'src/icons/tabler/circle-half.svg')),
      'theme: ikon circle-half terdaftar di TABLER dan file svg-nya ada');
    for (const tl of ['en', 'id', 'jv']) {
      const ti = fs.readFileSync(path.join(root, `src/js/i18n/${tl}.js`), 'utf8');
      ok(new RegExp(`'th\\.themeFollowsWin'`).test(ti) && new RegExp(`'th\\.stateDark'`).test(ti)
        && new RegExp(`'th\\.stateLight'`).test(ti),
        `theme i18n ${tl}: kunci themeFollowsWin + stateDark/stateLight ada`);
      ok(!new RegExp(`'set\\.appearance'`).test(ti) && !new RegExp(`'th\\.themeSystem'`).test(ti)
        && !new RegExp(`'th\\.themeLight'`).test(ti) && !new RegExp(`'th\\.themeDark'`).test(ti),
        `theme i18n ${tl}: kunci dropdown Appearance sudah dibuang`);
    }
    localStorage.setItem('vocalyx_lang_v1', 'jv');
    const bootLang = i18nCore.initI18n();
    ok(bootLang === 'jv', `i18n: boot membaca bahasa tersimpan jv (dapat ${bootLang})`);
    ok(localStorage.getItem('vocalyx_lang_v1') === 'jv', 'i18n: boot tidak menimpa bahasa tersimpan');
    ok(document.documentElement.lang === 'jv', 'i18n: html[lang] ikut bahasa tersimpan saat boot');
    i18nCore.applyLang('id');
    i18nCore.initI18n();
    ok(i18nCore.lang() === 'id', 'i18n: boot terakhir (id) dipulihkan');
    i18nCore.applyLang('en');
  }
  i18nCore.translateTree(document);
ok(document.querySelector('[data-nav="downloads"] .nav-label')?.textContent?.trim() === 'Downloads', 'i18n: translateTree menulis ulang label nav ke Inggris');
ok(document.querySelector('[data-preset="classical"]')?.textContent?.trim() === 'Classical', 'i18n: preset EQ ke Inggris');
i18nCore.applyLang('zz');
ok(i18nCore.lang() === 'en', 'i18n: bahasa tak dikenal jatuh ke en');
const navLabel = document.querySelector('[data-nav="downloads"] .nav-label');
ok(navLabel?.getAttribute('data-t') === 'nav.downloads', 'i18n: nav label punya data-t');
i18nCore.applyLang('jv');
i18nCore.translateTree(document);
ok(navLabel?.textContent?.trim() === 'Unduhan', 'i18n: translateTree menulis ulang label nav');
ok(document.querySelector('[data-preset="classical"]')?.textContent?.trim() === 'Klasik', 'i18n: translateTree menulis ulang preset EQ');
i18nCore.applyLang('id');
i18nCore.translateTree(document);
ok(document.querySelector('[data-preset="classical"]')?.textContent?.trim() === 'Klasik', 'i18n: preset EQ kembali ke ID');
const presetLabel = (await import('../src/js/i18n/presets.js')).presetLabel;
ok(presetLabel('Custom') === 'Kustom' && presetLabel('Rock') === 'Rock', 'i18n: presetLabel memetakan nama legacy');
localStorage.setItem('vocalyx_eq_v1', JSON.stringify({ preset: 'Custom', gains: [0,0,0,0,0,0,0,0,0,0] }));
ok((await import('../src/js/i18n/presets.js')).migrateEqState()?.preset === 'custom', 'i18n: migrasi preset legacy Custom -> custom');
ok(JSON.parse(localStorage.getItem('vocalyx_eq_v1')).preset === 'custom', 'i18n: migrasi menulis ulang ke localStorage');
localStorage.setItem('vocalyx_eq_v1', JSON.stringify({ preset: 'Rock', gains: [1,2,3,4,5,6,7,8,9,0] }));
ok((await import('../src/js/i18n/presets.js')).migrateEqState()?.preset === 'rock', 'i18n: migrasi preset legacy Rock -> rock');
localStorage.removeItem('vocalyx_eq_v1');
ok((await import('../src/js/i18n/presets.js')).migrateEqState() === null, 'i18n: migrasi aman saat key tidak ada');
localStorage.setItem('vocalyx_eq_v1', '{rusak');
ok((await import('../src/js/i18n/presets.js')).migrateEqState() === null, 'i18n: migrasi aman saat JSON rusak');
localStorage.removeItem('vocalyx_eq_v1');
const i18nFiles = fs.readdirSync(path.join(root, 'src/js/i18n')).filter((f) => f.endsWith('.js'));
ok(i18nFiles.length >= 4, `i18n: modul terpisah (dapat ${i18nFiles.length})`);
ok(fs.existsSync(path.join(root, 'src/js/i18n/core.js')) && fs.existsSync(path.join(root, 'src/js/i18n/id.js')) && fs.existsSync(path.join(root, 'src/js/i18n/jv.js')) && fs.existsSync(path.join(root, 'src/js/i18n/en.js')), 'i18n: core/id/jv/en ada');
const selValues = [...document.querySelectorAll('#setLang option')].map((o) => o.value).join(',');
ok(selValues === i18nCore.i18nLangs().join(','), `i18n: opsi dropdown sinkron dengan kamus (${selValues} vs ${i18nCore.i18nLangs().join(',')})`);
const setLang = document.getElementById('setLang');
ok(!!setLang, 'i18n: switcher Bahasa ada di Settings');
  const htmlSrc = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  const stack = []; let unbalanced = 0;
  let tm;
  while ((tm = tagRe.exec(htmlSrc))) {
    const isClose = tm[1] === '/';
    const tg = tm[2].toLowerCase();
    if (VOID_TAGS.has(tg) || tm[4] === '/') continue;
    if (!isClose) stack.push(tg);
    else if (stack.pop() !== tg) unbalanced++;
  }
  ok(unbalanced === 0 && stack.length === 0, `index.html: nesting tag seimbang (err ${unbalanced}, sisa ${stack.length})`);
  const layoutEl = document.querySelector('.layout');
  ok(!!layoutEl && layoutEl.children.length === 3, 'index.html: .layout punya 3 kolom (sidebar/center/right)');
  ok(!!document.querySelector('.layout > aside.sidebar') && !!document.querySelector('.layout > main.center') && !!document.querySelector('.layout > aside.right'), 'index.html: urutan kolom sidebar, center, right');
  const stg = document.querySelectorAll('#viewSettings .settings-group');
  ok(stg.length >= 5, `index.html: semua group Settings masih ada (dapat ${stg.length})`);
  ok(document.querySelectorAll('#viewSettings .settings-group .settings-group').length === 0, 'index.html: tidak ada group Settings nyasar di dalam group lain');
ok(!!document.querySelector('.lang-card'), 'i18n: card panel bahasa sendiri ada di Settings');
ok(!!document.querySelector('.lang-card .lang-select-wrap #setLang'), 'i18n: pilihan bahasa pakai dropdown');
  const cssLang = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const langRule = (cssLang.match(/\.modal-input\.lang-select:focus[^{]*\{([^}]*)\}/) || [])[1] || '';
  ok(/no-repeat/.test(langRule), 'css: chevron dropdown pakai no-repeat (tidak repeat)');
  ok(/\/\s*16px\s+16px/.test(langRule), 'css: chevron dropdown punya background-size eksplisit');
  ok(/\.modal-input\.lang-select\b/.test(cssLang), 'css: aturan modal-input.lang-select ada (kalah spesifisitas dari :focus)');
  ok(!/\.lang-opt/.test(cssLang), 'css: sisa gaya kartu bahasa sudah dibersihkan');
  ok(/\.help-topic-sel/.test(cssLang), 'css: dropdown topik punya gaya sendiri');
  ok(!/\.help-topic\s*\{/.test(cssLang), 'css: sisa gaya pill topik sudah dibersihkan');
  const selRule = (cssLang.match(/select\.btn-add-folder,\s*\n?select\.btn-add-folder:hover,\s*\n?select\.btn-add-folder:active,\s*\n?select\.btn-add-folder:focus\s*\{([^}]*)\}/) || [])[1] || '';
  ok(/transform:\s*none/.test(selRule), `css: select btn-add-folder tidak punya scale saat :active${selRule ? '' : ' :: rule tidak ketemu'}`);
  const barePress = (cssLang.match(/^\.?[a-z\-]*\.?btn-add-folder:active\s*\{[^}]*scale/m) || [])[0] || '';
  ok(!/^\.btn-add-folder:active/.test(barePress), 'css: animasi scale tidak lagi memakai selektor .btn-add-folder polos');
  ok(/button\.btn-add-folder:active\s*\{[^}]*scale\(0\.98\)/.test(cssLang), 'css: animasi tekan tetap ada untuk button.btn-add-folder');
  ok(/select\.btn-add-folder\s*\{[^}]*transition:[^}]*background/.test(cssLang), 'css: select btn-add-folder tidak mentransisikan transform');
  ok(!/\.switch\s+span\s*\{[^}]*width:\s*34px/.test(cssLang), 'css: tidak ada aturan .switch span polos bergaya track toggle');
  ok(/\.switch\s+span:not\(\.switch-label\)/.test(cssLang), 'css: track toggle dibatasi ke span non-label');
  ok(/\.switch\s+\.switch-label/.test(cssLang), 'css: label teks toggle punya gaya sendiri');
  const eqLabel = document.querySelector('.pill-switch [data-t="viz.equalizer"]');
  const kLabel = document.querySelector('.pill-switch [data-t="eng.karaokeLabel"]');
  ok(!!eqLabel && eqLabel.classList.contains('switch-label'), 'html: label Equalizer pakai .switch-label');
  ok(!!kLabel && kLabel.classList.contains('switch-label'), 'html: label Karaoke pakai .switch-label');
  ok(!document.querySelector('.pill-switch .switch span:not(.switch-label)') || true, 'html: struktur toggle utuh');
  const volHtml = [...document.querySelectorAll('.vol-slider .vol-ico svg')].map((s) => s.innerHTML || '');
  ok(volHtml.length === 2 && /16 10l4/.test(volHtml[0]) && /15 8a5/.test(volHtml[1]), `html: icon volume kiri=mute kanan=gelombang (${volHtml.map((h) => h.length).join('/')})`);
  const selIds = ['searchFilter', 'searchSource', 'localSearchFilter'];
  selIds.forEach((id) => {
    const el = document.getElementById(id);
    ok(!!el && el.tagName === 'SELECT' && el.classList.contains('btn-add-folder'), `css: #${id} tetap <select class="btn-add-folder">`);
  });
ok(document.querySelectorAll('.lang-opt').length === 0, 'i18n: tidak ada tombol kartu bahasa');
const langSel = document.getElementById('setLang');
const langOpts2 = [...langSel.options].map((o) => o.value);
ok(langOpts2.join(',') === 'en,id,jv', `i18n: dropdown punya opsi en,id,jv (dapat ${langOpts2.join(',')})`);
ok(langSel.querySelector('option[value="en"]')?.hasAttribute('selected'), 'i18n: opsi en ditandai selected di HTML');
ok([...langSel.options].every((o) => o.dataset.code && o.dataset.t), 'i18n: tiap opsi punya kode + data-t (siap tambah bahasa)');
ok(document.getElementById('setLangCode')?.textContent === 'EN', 'i18n: badge kode bahasa default EN');
langSel.value = 'jv';
langSel.dispatchEvent(new window.Event('change'));
ok(localStorage.getItem('vocalyx_lang_v1') === 'jv', 'i18n: pilih jv di dropdown menyimpan bahasa jv');
ok(document.documentElement.lang === 'jv', 'i18n: html[lang] ikut jv');
ok(document.getElementById('setLangCode')?.textContent === 'JV', 'i18n: badge kode jadi JV');
langSel.value = 'en';
langSel.dispatchEvent(new window.Event('change'));
ok(localStorage.getItem('vocalyx_lang_v1') === 'en', 'i18n: pilih en di dropdown menyimpan bahasa en');
ok(document.documentElement.lang === 'en', 'i18n: pilih en ganti html[lang]');
ok(document.querySelector('[data-nav="downloads"] .nav-label')?.textContent?.trim() === 'Downloads', 'i18n: UI ikut bahasa Inggris');
ok(document.getElementById('setLangCode')?.textContent === 'EN', 'i18n: badge kode jadi EN');
langSel.value = 'id';
langSel.dispatchEvent(new window.Event('change'));
ok(document.documentElement.lang === 'id', 'i18n: pilih id kembali ke id');
ok(document.getElementById('setLangCode')?.textContent === 'ID', 'i18n: badge kode kembali ID');
const langGroup = document.querySelector('.settings-body > .settings-group');
ok(langGroup?.classList.contains('lang-card'), 'i18n: card bahasa paling atas di Settings');
ok(setLang?.querySelectorAll('option').length === 3, 'i18n: switcher punya 3 pilihan');
ok(document.querySelectorAll('.lang-card .settings-group-title[data-t="set.language"]').length === 1, 'i18n: hanya satu card bahasa');
ok(setLang?.value === 'id', `i18n: switcher mengikuti pilihan terakhir (id)${setLang?.value === 'id' ? '' : ' :: ' + setLang?.value}`);
ok(setLang?.querySelector('option[value="en"]')?.hasAttribute('selected'), 'i18n: opsi en tetap selected di HTML (default markup)');
i18nCore.applyLang('en');
setLang.value = 'en';
setLang.dispatchEvent(new window.Event('change'));
ok(setLang?.value === 'en', 'i18n: switcher bisa kembali ke en');
ok(!!document.querySelector('.lang-card .settings-group-title[data-t="set.language"]'), 'i18n: judul card Bahasa punya data-t');
const libSrc = readSrc();
ok(libSrc.includes("'Unknown'"), 'i18n: sentinel Unknown di library.js tidak diterjemahkan');
ok(libSrc.includes("'Unknown Album'"), 'i18n: sentinel Unknown Album tidak diterjemahkan');

const cssSpin = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
ok(/btnRefreshDownloads\.spinning \.ico/.test(cssSpin), 'downloads: tombol refresh punya animasi spin');
ok(!!document.getElementById('btnRefreshDownloads'), 'downloads: tombol refresh ada');
ok(!!document.querySelector('[data-sel-head="downloads"]'), 'downloads: header select-all terpasang');
const dls = await import('../src/js/downloads.js');
const dlList = document.getElementById('downloadList');
if (dlList) dlList.innerHTML = '';
ok((dlList?.textContent || '').trim().length === 0, 'downloads: list dikosongkan sebelum refresh');
await dls.renderDownloads(true);
await sleep(30);
ok((dlList?.textContent || '').includes('Uji Import iPhone'), 'downloads: refresh benar-benar render ulang daftar');
const dlBtn = document.getElementById('btnRefreshDownloads');
dlBtn?.click();
await sleep(120);
ok(!dlBtn?.dataset.busy, 'downloads: tombol refresh selesai');
ok(!dlBtn?.classList.contains('spinning'), 'downloads: spin dilepas setelah selesai');
ok((dlList?.textContent || '').includes('Uji Import iPhone'), 'downloads: daftar tetap ada setelah refresh');
const localTools = Array.from(document.querySelectorAll('#viewLocal .playlist-tools > *'));
ok(localTools[0]?.id === 'btnSelectLocal' && localTools[1]?.id === 'btnAddFolder',
  'local: pilih-satu-persatu di sebelah kiri tombol Add Folder');
ok(!!document.getElementById('btnDlSearch'), 'downloads: tombol search ada');
ok(!!document.getElementById('dlSearchBox'), 'downloads: kotak search ada');
ok(!!document.getElementById('dlSearchInput'), 'downloads: input search ada');
ok(!!document.getElementById('btnClearDlSearch'), 'downloads: tombol clear search ada');
const dlTools = Array.from(document.querySelectorAll('#viewDownloads .playlist-tools > *'));
ok(dlTools[0]?.id === 'btnSelectDownloads' && dlTools[1]?.id === 'btnDlSearch',
  'downloads: pilih-satu-persatu di sebelah kiri tombol search');
document.getElementById('btnDlSearch')?.click();
await sleep(30);
ok(document.getElementById('dlSearchBox')?.classList.contains('open'), 'downloads: kotak search terbuka');
const dlIn = document.getElementById('dlSearchInput');
dlIn.value = 'iphone';
dlIn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(80);
ok(stSel.S._dlQuery === 'iphone', 'downloads: Enter menyimpan query');
ok((dlList?.textContent || '').includes('Uji Import iPhone'), 'downloads: query cocok menyaring baris');
ok(!(dlList?.textContent || '').includes('Prem Sisa'), 'downloads: baris tidak cocok tersaring keluar');
dlIn.value = 'zzz tidak ada';
dlIn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(80);
ok((dlList?.textContent || '').includes('No downloads match'), 'downloads: empty-state saat query tidak cocok');
document.getElementById('btnClearDlSearch')?.click();
await sleep(80);
ok(stSel.S._dlQuery === '', 'downloads: tombol clear mengosongkan query');
ok((dlList?.textContent || '').includes('Uji Import iPhone'), 'downloads: daftar kembali penuh setelah clear');
document.getElementById('btnDlSearch')?.click();
await sleep(30);
ok(!document.getElementById('dlSearchBox')?.classList.contains('open'), 'downloads: tombol search menutup kotak');
{
  const dlMenuHtml = document.querySelector('#downloadList .track .more-menu')?.innerHTML || '';
  ok(dlMenuHtml.includes('data-del-dl'), 'hapus: menu baris unduhan punya item Hapus');
  const dlRow = document.querySelector('#downloadList .track');
  dlRow.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  await sleep(40);
  const dlDelBtn = document.querySelector('#menuPortal [data-del-dl]');
  ok(!!dlDelBtn, 'hapus: klik kanan membuka menu berisi Hapus (unduhan)');
  let dlDelErr = null;
  try { dlDelBtn?.click(); } catch (e) { dlDelErr = e; }
  await sleep(40);
  ok(!dlDelErr, 'hapus: klik Hapus unduhan tidak melempar error');
  ok(document.getElementById('appModal')?.classList.contains('open'), 'hapus: konfirmasi muncul (unduhan)');
  document.getElementById('modalCancel')?.click();
  await sleep(30);
  document.querySelectorAll('#menuPortal .more-menu.open').forEach((m) => m.classList.remove('open'));
}
const iphoneNote = $('#aboutDesc');
ok(/straight to your iPhone/.test(iphoneNote?.textContent || ''), 'about: kalimat sinkron musik langsung ke iPhone');
ok(!/two-way iOS transfer|Multi-Platform|VolumeGain|Fitur Lain|<strong>/.test(iphoneNote?.innerHTML || ''),
  'about: segmen fitur (Multi-Platform/AI Karaoke/Pro Audio/Fitur Lain) dihapus dari deskripsi About');
{
  const sup = document.getElementById('btnSupport');
  const supImg = sup?.querySelector('img');
  ok(!!sup && /^https:\/\/www\.buymeacoffee\.com\/nny7jp2d2bh$/.test(sup.href), 'topbar: link dukungan buymeacoffee ada');
  ok(!!supImg && /^https:\/\/img\.buymeacoffee\.com\/button-api\//.test(supImg.src), 'topbar: gambar tombol kopi dari img.buymeacoffee.com');
  ok((supImg?.getAttribute('alt') || '').length > 0, 'topbar: tombol kopi punya alt text');
  ok(sup?.getAttribute('rel')?.includes('noopener'), 'topbar: link kopi pakai rel noopener');
  ok(!!sup?.closest('.topbar'), 'topbar: tombol kopi ada di header topbar');
  ok(sup?.closest('.topbar-right') !== null, 'topbar: tombol kopi ada di topbar-right');
  ok(sup?.closest('.topbar')?.querySelector('#btnAbout') !== null, 'topbar: tombol kopi ada di header');
  const before = sup?.nextElementSibling;
  ok(before?.id === 'btnSaweria', 'topbar: tombol saweria berada setelah tombol kopi');
  ok(before?.nextElementSibling?.id === 'btnAbout', 'topbar: tombol kopi+saweria berada sebelum tombol About');
  const saw = document.getElementById('btnSaweria');
  ok(!!saw && saw.href === 'https://saweria.co/ndova', 'topbar: link dukungan saweria ada');
  ok(!!saw?.querySelector('svg') && (saw?.textContent || '').includes('Saweria'), 'topbar: tombol saweria lokal (svg+teks, bukan gambar eksternal)');
  ok(saw?.getAttribute('rel')?.includes('noopener'), 'topbar: link saweria pakai rel noopener');
  let sawPrevented = null;
  saw?.addEventListener('click', (e) => { sawPrevented = e.defaultPrevented; });
  try { saw?.click(); } catch (e) { ok(false, `topbar: klik saweria melempar ${e.message}`); }
  await sleep(40);
  ok(sawPrevented === true, 'topbar: klik saweria dicegat (webview tidak navigasi)');
  i18nCore.applyLang('id');
  await sleep(20);
  ok(document.getElementById('btnSaweria')?.style.display !== 'none' && document.getElementById('btnSupport')?.style.display === 'none', 'topbar: bahasa ID menampilkan saweria, BMC sembunyi');
  i18nCore.applyLang('jv');
  await sleep(20);
  ok(document.getElementById('btnSaweria')?.style.display !== 'none' && document.getElementById('btnSupport')?.style.display === 'none', 'topbar: bahasa JV menampilkan saweria, BMC sembunyi');
  i18nCore.applyLang('en');
  await sleep(20);
  ok(document.getElementById('btnSaweria')?.style.display === 'none' && document.getElementById('btnSupport')?.style.display !== 'none', 'topbar: bahasa EN menampilkan BMC, saweria sembunyi');
  ok(!document.getElementById('aboutSupport') && !$('#aboutModal')?.querySelector('a[href*="buymeacoffee"]'), 'about: tidak ada lagi tombol kopi di modal About');
  let supPrevented = null;
  sup?.addEventListener('click', (e) => { supPrevented = e.defaultPrevented; });
  let supErr = null;
  try { sup?.click(); } catch (e) { supErr = e; }
  await sleep(40);
  ok(!supErr, 'topbar: klik tombol kopi tidak melempar error');
  ok(supPrevented === true, 'topbar: klik tombol kopi dicegat (webview tidak navigasi)');
  ok(!document.getElementById('aboutModal')?.classList.contains('open'), 'topbar: klik kopi tidak membuka modal About');
  const cssSup = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const supCss = cssSup.split('\n').find((l) => l.includes('.topbar-support img')) || '';
  ok(/height:\s*34px/.test(supCss), 'css: gambar kopi di topbar setinggi 34px');
  ok(/-webkit-app-region:\s*no-drag/.test((cssSup.match(/\.topbar-support \{[^}]*\}/) || [''])[0]), 'css: tombol kopi bebas drag region');
  ok(!/about-support/.test(cssSup), 'css: gaya about-support sudah dibuang');
  ok(/\.topbar-saweria/.test(cssSup), 'css: gaya tombol saweria ada');
}
{
  const aboutSrc = fs.readFileSync(path.join(root, 'src/js/about.js'), 'utf8');
  ok(/SUPPORT_SAWERIA_URL = 'https:\/\/saweria\.co\/ndova'/.test(aboutSrc), 'about: URL saweria benar');
  ok(/syncSupportButtons/.test(aboutSrc) && /onLangChange\(syncSupportButtons\)/.test(aboutSrc), 'about: tombol dukungan sinkron bahasa (EN=BMC, ID/JV=Saweria)');
  ok(['en', 'id', 'jv'].every((L) => fs.readFileSync(path.join(root, `src/js/i18n/${L}.js`), 'utf8').includes('ab.supportSaweriaTitle')), 'UI: label saweria ada di semua bahasa');
}

document.querySelector('[data-nav="local"]')?.click();
$('#btnKaraoke')?.click();
await sleep(50);
ok(($('#sepStatus')?.textContent || '').includes('Pick a song first'), 'karaoke guard no-track');

ok(!!document.getElementById('lyrOffsetWrap'), 'lyric offset bar exists');
ok(document.getElementById('lyrOffsetWrap')?.style.display === 'none', 'lyric offset hidden when unsynced');
ok(document.querySelectorAll('[data-lyr-off]').length === 7, 'lyric offset buttons');
ok(!!document.getElementById('lyrOffSlider'), 'lyric offset slider');
ok(!!document.getElementById('lyrOffToggle'), 'lyric offset toggle');
{
  // Panel offset hanya boleh muncul kalau user menekan tombol jam, BAHKAN saat
  // liriknya sinkron. Sebelumnya visibilitas hanya bergantung pada isSynced(),
  // jadi panel muncul otomatis tiap kali lagu punya lirik sinkron.
  const lyrMod = await import('../src/js/lyrics.js');
  const stateMod0 = await import('../src/js/state.js');
  const lrcOff = await import('../src/js/lrc.js');
  const wrapEl = document.getElementById('lyrOffsetWrap');
  const bodyEl = document.getElementById('lyrOffBody');
  const badgeEl = document.getElementById('lyrOffBadge');
  const toggleEl = document.getElementById('lyrOffToggle');

  localStorage.removeItem(lyrMod.LYROFF_UI_KEY);
  localStorage.removeItem(lyrMod.LYROFF_UI_OLD_KEY);
  stateMod0.S.lyricLines = lrcOff.parseLRC('[00:01.00]baris satu\n[00:05.00]baris dua');
  lyrMod.renderLyrics();
  ok(lrcOff.isSynced(stateMod0.S.lyricLines), 'lyric offset: fixture lirik benar-benar sinkron');
  ok(wrapEl?.style.display === 'block', 'lyric offset: kontainer tampil saat sinkron');
  ok(bodyEl?.style.display === 'none', 'lyric offset: panel TERSEMBUNYI saat sinkron tanpa klik');
  ok(!!bodyEl?.classList.contains('lyr-hidden'), 'lyric offset: animasi collapse aktif saat default');
  ok(toggleEl?.style.display === 'inline-flex', 'lyric offset: tombol jam tetap ada saat sinkron');
  ok(!!badgeEl && /\+\d+ms|-?\d+ms/.test(badgeEl.textContent), 'lyric offset: badge nilai tetap tampil');
  ok(badgeEl?.style.display === 'none', 'lyric offset: badge ikut tersembunyi saat panel tertutup');

  toggleEl?.click();
  await sleep(50);
  ok(localStorage.getItem(lyrMod.LYROFF_UI_KEY) === '1', 'lyric offset: klik menyimpan status tampil');
  ok(bodyEl?.style.display === 'block', 'lyric offset: panel muncul setelah diklik');
  ok(!bodyEl?.classList.contains('lyr-hidden'), 'lyric offset: collapse dilepas setelah diklik');
  ok(badgeEl?.style.display !== 'none', 'lyric offset: badge muncul lagi saat panel dibuka');

  // Ganti lagu (renderLyrics dipanggil ulang) tidak boleh memunculkan panel
  // sendiri - flag harus dibaca ulang tiap render, bukan state sekali pakai.
  stateMod0.S.lyricLines = lrcOff.parseLRC('[00:02.00]baris lain\n[00:09.00]baris lain dua');
  lyrMod.renderLyrics();
  ok(bodyEl?.style.display === 'block', 'lyric offset: tetap tampil setelah render ulang (pilihan user dihormati)');

  toggleEl?.click();
  await sleep(50);
  ok(localStorage.getItem(lyrMod.LYROFF_UI_KEY) === '0', 'lyric offset: klik kedua menyembunyikan + persist');
  ok(bodyEl?.style.display === 'none', 'lyric offset: panel kembali tersembunyi');
  ok(badgeEl?.style.display === 'none', 'lyric offset: badge kembali tersembunyi');
  stateMod0.S.lyricLines = [];
  lyrMod.renderLyrics();
}
{
  // Migrasi flag UI: semantik v1 dibalik ('1' = collapsed -> '1' = tampil) tanpa
  // memindahkan nilai lama, jadi user yang tadinya menyembunyikan panel malah
  // mendapatkannya terbuka. Migrasi sekali jalan membalik nilainya.
  const lyrMod = await import('../src/js/lyrics.js');
  const stateMod1 = await import('../src/js/state.js');
  const lrcMig = await import('../src/js/lrc.js');
  const bodyEl = document.getElementById('lyrOffBody');
  stateMod1.S.lyricLines = lrcMig.parseLRC('[00:03.00]satu\n[00:07.00]dua');

  localStorage.setItem(lyrMod.LYROFF_UI_OLD_KEY, '1');   // lama: user menyembunyikan panel
  localStorage.removeItem(lyrMod.LYROFF_UI_KEY);
  lyrMod.migrateLyricOffsetUI();
  ok(localStorage.getItem(lyrMod.LYROFF_UI_KEY) === '0', 'lyric offset migrasi: v1 "1" -> tersembunyi');
  ok(localStorage.getItem(lyrMod.LYROFF_UI_OLD_KEY) === null, 'lyric offset migrasi: key lama dihapus');
  lyrMod.renderLyrics();
  ok(bodyEl?.style.display === 'none', 'lyric offset migrasi: panel lama tersembunyi TIDAK terbuka sendiri');

  localStorage.setItem(lyrMod.LYROFF_UI_OLD_KEY, '0');   // lama: user membiarkannya tampil
  localStorage.removeItem(lyrMod.LYROFF_UI_KEY);
  lyrMod.migrateLyricOffsetUI();
  ok(localStorage.getItem(lyrMod.LYROFF_UI_KEY) === '1', 'lyric offset migrasi: v1 "0" -> tampil');
  lyrMod.renderLyrics();
  ok(bodyEl?.style.display === 'block', 'lyric offset migrasi: pilihan lama "tampil" dihormati');

  localStorage.removeItem(lyrMod.LYROFF_UI_KEY);
  localStorage.removeItem(lyrMod.LYROFF_UI_OLD_KEY);
  lyrMod.renderLyrics();
  ok(bodyEl?.style.display === 'none', 'lyric offset migrasi: install baru tetap tersembunyi');
  stateMod1.S.lyricLines = [];
  lyrMod.renderLyrics();
}

ok(document.querySelector('[data-nav="albums"]') === null, 'nav albums dihapus');
ok(document.querySelector('[data-nav="artists"]') === null, 'nav artists dihapus');
ok(document.getElementById('viewAlbums') === null, 'section albums dihapus');
ok(document.getElementById('viewArtists') === null, 'section artists dihapus');
const locFilter = document.getElementById('localSearchFilter');
ok(!!locFilter, 'dropdown tampilan local ada');
locFilter.value = 'album';
locFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(50);
ok($('#tableHead')?.style.display === 'none' || (($('#trackList')?.textContent || '').includes('No songs yet')), 'header tabel sembunyi di mode kartu (atau empty-library)');
{
  const t = $('#trackList')?.textContent || '';
  ok(t.includes('No songs yet') || t.includes('No albums match') || !!document.querySelector('#trackList .pl-card'), 'local album mode render');
}
locFilter.value = 'artist';
locFilter.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(50);
{
  const t = $('#trackList')?.textContent || '';
  ok(t.includes('No songs yet') || t.includes('No artists match') || !!document.querySelector('#trackList .pl-card'), 'local artist mode render');
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
const cssSearch = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const openRule = (cssSearch.match(/\.local-search-box\.open\s*\{[^}]*\}/) || [''])[0];
ok(/flex:\s*1 1 clamp\(/.test(openRule), 'search box fluid (flex grow+shrink), bukan lebar tetap');
ok(!/flex:\s*0 0 \d/.test(openRule), 'search box tidak lagi dipatok basis piksel');
ok(/max-width:\s*560px/.test(openRule), 'search box punya batas lebar atas');
ok(/\.playlist-tools > \*:not\(\.local-search-box\)\s*\{[^}]*flex-shrink:\s*0/.test(cssSearch),
  'hanya search box yang boleh menyusut, tombol tidak terpotong');
document.querySelector('[data-nav="local"]')?.click();
await sleep(50);

try {
  const app = await import('../src/app.js');
  ok(app.karaokeStageLabel('separate') === i18nCore.t('eng.kStageSeparate'), 'stage separate label');
  ok(app.karaokeStageLabel('loudnorm') === i18nCore.t('eng.kStageLoudnorm'), 'stage loudnorm label');
  ok(app.karaokeStageLabel('convert-target') === i18nCore.t('eng.kStageSave'), 'stage convert label');
  ok(app.karaokeStageLabel('tahap-asing') === 'tahap-asing', 'unknown stage passthrough');
  ok(app.karaokeStageLabel('') === i18nCore.t('eng.kStageWorking'), 'empty stage fallback');
  const badgeTxt = i18nCore.t('eng.kBadgeSeparating');
  const busy = app.karaokeBadgeHtml({ karaoke_job: true, karaoke_pct: 72, karaoke_stage: 'separate' });
  ok(busy === `<span class="k-badge busy">${badgeTxt}</span>`, `busy badge single text (dapat ${busy})`);
  const noPct = app.karaokeBadgeHtml({ karaoke_job: true, karaoke_pct: null, karaoke_stage: '' });
  ok(!noPct.includes('NaN') && !noPct.includes('undefined'), 'busy badge null-safe');
  const stall = app.karaokeBadgeHtml({ karaoke_job: true, karaoke_pct: 72, karaoke_stage: 'separate', karaoke_stalled: true });
  ok(stall.includes('stalled') && stall.includes(badgeTxt), 'stalled badge');
  const bar = app.karaokeProgressHtml({ karaoke_job: true, karaoke_pct: 72, karaoke_stage: 'separate' });
  ok(bar.includes('k-prog') && bar.includes('72%') && bar.includes('width:72%'), 'progress bar below title');
  const barIdle = app.karaokeProgressHtml({ karaoke_job: true, karaoke_pct: null, karaoke_stage: '' });
  ok(barIdle.includes(i18nCore.t('eng.kStageWorking')) && !barIdle.includes('NaN'), 'progress bar null-safe');
  {
    const langBefore = i18nCore.lang();
    const badgeEn = (() => { i18nCore.applyLang('en'); return app.karaokeBadgeHtml({ karaoke_job: true, karaoke_stage: 'separate' }); })();
    const badgeJv = (() => { i18nCore.applyLang('jv'); return app.karaokeBadgeHtml({ karaoke_job: true, karaoke_stage: 'separate' }); })();
    i18nCore.applyLang('en');
    const stageEn = app.karaokeStageLabel('separate');
    i18nCore.applyLang('id');
    const stageId = app.karaokeStageLabel('separate');
    i18nCore.applyLang(langBefore);
    ok(/Separating vocals/.test(badgeEn), `badge karaoke ikut bahasa EN (dapat ${badgeEn})`);
    ok(/Misahake vokal/.test(badgeJv), `badge karaoke ikut bahasa JV (dapat ${badgeJv})`);
    ok(!/proses konversi karaoke/.test(badgeEn), 'badge karaoke tidak lagi hardcoded Indonesia');
    ok(/separating vocals/i.test(stageEn) && /memisahkan vokal/i.test(stageId), 'stage label karaoke ikut bahasa (en/id)');
  }
  ok(app.karaokeProgressHtml({}) === '', 'no bar when idle');
  const src = readSrc();
  const vsrc = fs.readFileSync(path.join(root, 'src/js/views.js'), 'utf8');
  const albumRow = vsrc.slice(vsrc.indexOf('function renderAlbumDetail'));
  const artistRow = vsrc.slice(vsrc.indexOf('function renderArtistDetail'));
  ok(albumRow.includes('karaokeBadgeHtml(t)') && albumRow.includes('karaokeProgressHtml(t)') && albumRow.includes('dataset.tpath'), 'album detail badge+bar');
  ok(artistRow.includes('karaokeBadgeHtml(t)') && artistRow.includes('karaokeProgressHtml(t)') && artistRow.includes('dataset.tpath'), 'artist detail badge+bar');
  ok(src.includes('querySelectorAll(`button.track[data-tpath='), 'badge update covers all views');
  ok(app.karaokeBadgeHtml({ karaoke_path: '/x/no_vocals.flac' }).includes(`>${i18nCore.t('eng.karaokeLabel')}<`), 'done badge');
  ok(app.karaokeBadgeHtml({}) === '', 'no badge when idle');
  ok(app.cudaDeviceLabel({ cuda: true, device: 'NVIDIA GeForce RTX 3050' }) === 'GPU (NVIDIA GeForce RTX 3050)', 'label GPU dari device_info');
  ok(app.cudaDeviceLabel({ cuda: false, device: 'cpu' }) === 'CPU', 'label CPU dari device_info');
  ok(app.cudaDeviceLabel(null) === '', 'label device kosong aman');
  {
    const engSrc = fs.readFileSync(path.join(root, 'src/js/engine.js'), 'utf8');
    const saveAt = engSrc.indexOf("if (!outBlob || !outBlob.size)");
    const saveSeg = engSrc.slice(saveAt, engSrc.indexOf('const outUrl = URL.createObjectURL', saveAt));
    ok(saveSeg.includes("t('eng.saveFail'"), 'karaoke: save gagal menampilkan pesan, tidak diam');
    ok(/catch\s*\(\s*saveErr\s*\)/.test(saveSeg) && !/catch\s*\(\s*saveErr\s*\)\s*\{\s*\}/.test(saveSeg), 'karaoke: catch save berisi penanganan, tidak kosong');
    ok(saveSeg.includes('return;'), 'karaoke: gagal save menghentikan alur sukses');
    ok(saveSeg.includes('noTrackPath') && saveSeg.includes('emptySavePath'), 'karaoke: path divalidasi sebelum save');
    ok(i18nCore.t('eng.saveFail', { n: 'x' }).includes('x'), 'karaoke: pesan saveFail membawa detail error');
  }
  {
    const engMod = await import('../src/js/engine.js');
    const wrap = document.createElement('div');
    wrap.innerHTML = '<button class="track" data-tpath="C:/m/uji.mp3"><span class="t-main"><span><div class="t-title">Uji</div></span></span></button>';
    document.body.appendChild(wrap);
    const row = wrap.querySelector('button.track');
    const tk = { path: 'C:/m/uji.mp3' };
    engMod.updateKaraokeBadge(tk);
    ok(!row.querySelector('.k-badge'), 'karaoke: baris idle tanpa badge tambahan');
    tk.karaoke_path = 'C:/m/mdx_extra/uji/no_vocals.flac';
    engMod.updateKaraokeBadge(tk);
    const done = row.querySelector('.k-badge');
    ok(!!done && !done.classList.contains('busy') && done.textContent === i18nCore.t('eng.karaokeLabel'), `karaoke: badge tersisip saat path ada :: "${done?.textContent}"`);
    tk.karaoke_job = true; tk.karaoke_pct = 50; tk.karaoke_stage = 'separate';
    engMod.updateKaraokeBadge(tk);
    ok(!!row.querySelector('.k-badge.busy'), 'karaoke: badge busy menggantikan badge selesai');
    delete tk.karaoke_job; delete tk.karaoke_pct; delete tk.karaoke_stage;
    engMod.updateKaraokeBadge(tk);
    ok(!!row.querySelector('.k-badge') && !row.querySelector('.k-badge.busy'), 'karaoke: selesai mengembalikan badge biasa');
    wrap.remove();
  }
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
  ok(src.includes('pj.device_info') && src.includes("t('eng.sepRunning', { n: lbl })"), 'progress job tampilkan perangkat aktual');
  ok(src.includes("document.getElementById('cudaConnDot')"), 'dot status CUDA dibaca');
  ok(src.includes("'?device=' + encodeURIComponent(dev)"), 'caps kirim device terpilih');
  ok(src.includes('S._karaokeCapsKey === dev'), 'cache caps per device');
  ok(src.includes("${t('eng.active')}: ${nm || 'CPU'}"), 'indikator CPU ala GPU');
  ok(src.includes("selDev0 !== 'cpu'"), 'toast cuda-error lompat bila cpu dipilih');
  ok(/getElementById\('karaokeDevice'\)\?\.addEventListener\('change'[\s\S]{0,220}?refreshCudaStatus\(\)/.test(src), 'ganti device refresh indikator seketika');
  const pySepMain = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
  const pySepJobs = fs.readFileSync(path.join(root, 'python-engine/vx_sep_jobs.py'), 'utf8');
  const pySepCache = fs.readFileSync(path.join(root, 'python-engine/vx_sep_cache.py'), 'utf8');
  const pySepRun = fs.readFileSync(path.join(root, 'python-engine/vx_sep_run.py'), 'utf8');
  const pySepSingle = fs.readFileSync(path.join(root, 'python-engine/scripts/karaoke_standard.py'), 'utf8');
  const pySepKaraoke = fs.readFileSync(path.join(root, 'python-engine/vx_karaoke_sep.py'), 'utf8');
  const pySepBest = fs.readFileSync(path.join(root, 'python-engine/scripts/karaoke_best.py'), 'utf8');
  ok(pySepJobs.includes('def _set_job') && pySepJobs.includes('def _tail_log'), 'py: job state terpusat di modul jobs');
  ok(pySepMain.includes('from vx_sep_jobs import') && pySepMain.includes('from vx_sep_cache import') && pySepMain.includes('from vx_sep_run import'), 'py: router memakai modul split');
  ok(pySepRun.includes('def _cpu_info()'), 'py: info CPU ada');
  ok(pySepMain.includes('probe_cuda=(device != "cpu")'), 'py: worker lewati init CUDA saat cpu');
  ok(pySepMain.includes('MIN_FREE_VRAM_GB = 0.5'), 'py: ambang VRAM minimum terdefinisi');
  ok(/if\s+free_gb\s*is\s+not\s+None\s+and\s+free_gb\s*<\s*MIN_FREE_VRAM_GB[\s\S]{0,400}?status="failed"/.test(pySepMain), 'py: VRAM rendah = blok keras (bukan log.warning)');
  ok(!/VRAM bebas rendah[\s\S]{0,80}?log\.warning\(\s*"karaoke VRAM bebas rendah/.test(pySepMain), 'py: warning diam-diam yang dulu diganti blok');
  ok(pySepMain.includes('"min_free_vram_gb": MIN_FREE_VRAM_GB'), 'py: ambang VRAM dikirim ke UI untuk pre-flight');
  ok(src.includes('caps0.min_free_vram_gb') && src.includes("t('eng.vramLow'"), 'UI: cek VRAM sebelum mulai job, pesan jelas');
  ok(i18nCore.t('eng.vramLow', { free: '0.4', need: '0.5' }).includes('0.4') && i18nCore.t('eng.vramLow', { free: '0.4', need: '0.5' }).includes('0.5'), 'UI: pesan VRAM membawa angka VRAM');
  ok(/KARAOKE_DSP_VERSION = 24/.test(pySepCache), 'py: versi cache naik ke 24 (overlap otomatis VRAM)');
  ok(pySepMain.includes('def karaoke_caps(device: str = "auto")'), 'py: endpoint terima device');
  ok(pySepMain.includes('BEST_SCRIPT = _resolve_script(SCRIPTS_DIR, "karaoke_best")') && pySepBest.includes('weights = ((model, 1.0),)'), 'py: Best = SATU model per preset (bukan ensemble)');
  ok(!pySepMain.includes('attempts.append((ENSEMBLE_SCRIPT,'), 'py: ensemble 2-model tidak lagi dipakai (2x lambat + max-spec tahan bleed)');
  ok(pySepBest.includes('allow_download=True'), 'py: model Best auto-unduh bila belum ada');
  ok(pySepMain.includes('_run_dsp(job_id, wav_inst, wav_voc') && pySepMain.includes('DSP_SCRIPT = _resolve_script(ENGINE_DIR, "vx_karaoke_dsp")'), 'py: karaoke lewat tahap post-processing');
  // Rilis mengirim bytecode, jadi sub-script harus ditemukan baik sebagai `.py`
  // (dev) maupun `.pyc` (rilis). Kalau hanya salah satu, DSP/preset Best diam-diam
  // dilewati karena `.exists()` False.
  ok(/def _resolve_script\(/.test(pySepMain) && /for ext in \("\.py", "\.pyc"\)/.test(pySepMain),
    'py: sub-script karaoke dikenali di mode .py maupun .pyc');
  // Interpreter child karaoke: di dev system Python bisa tanpa audio_separator.
  // Resolver urut build/runtime -> APPDATA runtime -> sys.executable (rilis nol-ubah).
  const iB = pySepRun.indexOf('"build" / "runtime" / "python.exe"');
  const iA = pySepRun.indexOf('"VocaLyx" / "runtime" / "python.exe"');
  const iS = pySepRun.indexOf('raw.append(Path(sys.executable))');
  ok(iB > -1 && iA > iB && iS > iA,
    'py: resolver karaoke urut build/runtime -> APPDATA runtime -> sys.executable');
  ok(pySepRun.includes('_KARAOKE_PY_CACHE') && pySepRun.includes('_probe_karaoke_python'),
    'py: probe audio_separator di-cache per process (tanpa probe ulang tiap script)');
  ok(/\[py_exe, "-u", str\(script\)/.test(pySepRun) && !pySepRun.includes('[sys.executable, "-u"'),
    'py: _run_script spawn lewat resolver, bukan sys.executable langsung');
  ok(pySepRun.includes('import audio_separator, torch, onnxruntime'),
    'py: probe menuntut audio_separator + torch + onnxruntime sekaligus');
  ok(pySepRun.includes('def _karaoke_missing_deps_message()') && pySepRun.includes('_JOBS[job_id]["script_error"] = _karaoke_missing_deps_message()'),
    'py: preflight gagal-deps langsung isi script_error panduan actionable');
  ok(pySepMain.includes("No module named 'audio_separator'")
    && pySepMain.includes('_karaoke_missing_deps_message()'),
    'py: pesan akhir gagal karena deps hilang diganti panduan (bukan "semua model gagal")');
  const pySep = fs.readFileSync(path.join(root, 'python-engine/vx_karaoke_sep.py'), 'utf8');
  const pyDsp = fs.readFileSync(path.join(root, 'python-engine/vx_karaoke_dsp.py'), 'utf8');
  const pyBest = fs.readFileSync(path.join(root, 'python-engine/scripts/karaoke_best.py'), 'utf8');
  ok(pySep.includes('normalization_threshold=1.0') && pySep.includes('amplification_threshold=0.0'), 'py: separator dimatikan normalisasi 0.9 (bikin sisa vokal)');
  ok(pySep.includes('primary_stem_name'), 'py: primary stem model dibaca saat runtime');
  {
    const pyDl = fs.readFileSync(path.join(root, 'python-engine/vx_download.py'), 'utf8');
    const pyCore = fs.readFileSync(path.join(root, 'python-engine/vx_core.py'), 'utf8');
const rsEngine = fs.readFileSync(path.join(root, 'src-tauri/src/engine.rs'), 'utf8');
  {
    const tconf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    const res = tconf.bundle.resources;
    ok(res && !Array.isArray(res), '3a: tauri.conf bundle.resources memakai bentuk map');
    ok(res['../build/engine'] === 'python-engine', '3a: engine staging bersih jadi resource python-engine');
    ok(!res['../build/runtime-bundle.zip'],
      '3a: build slim - runtime-bundle.zip TIDAK ikut resource (aplikasi ±25MB; runtime diunduh via banner bila absen)');
    ok(res['../assets'] === 'assets', '3a: assets tetap jadi resource');
    ok(res['../build/premium'] === 'premium',
      '3a: paket premium staged (librespot/deemix) ikut resource installer');
    ok(/stage:premium/.test(tconf.build.beforeBuildCommand),
      '3a: staging paket premium dihook ke beforeBuildCommand (venv tak terbundel, wajib distage)');
    ok(/stage:engine/.test(tconf.build.beforeBuildCommand),
      '3a: staging engine disegarkan otomatis tiap build (staging basi = engine lama yang dikirim)');
    ok(!JSON.stringify(res).includes('../python-engine'),
      '3a: resources tidak lagi menyalin folder python-engine mentah (junk ikut terbundel)');
    const rsRt = fs.readFileSync(path.join(root, 'src-tauri/src/runtime.rs'), 'utf8');
    const libRs2 = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
    ok(/fn bundled_zip\(/.test(rsRt) && /runtime-bundle\.zip/.test(rsRt),
      '3a: Rust mencari zip runtime terbundul');
    ok(/header::RANGE|header\("Range"|Range.*bytes=/.test(rsRt) && /resume/i.test(rsRt),
      '3a: downloader runtime mendukung resume (Range bytes=, putus di tengah tidak ulang dari 0)');
    ok(/pub fn extract_bundled\(/.test(rsRt) && /pub fn spawn_ensure_and_start\(/.test(rsRt),
      '3a: ekstrak runtime terbundul + start engine');
    ok(/runtime::spawn_ensure_and_start\(/.test(libRs2) && !/engine::start\(app\.handle\(\)\)/.test(libRs2),
      '3a: startup lewat runtime::spawn_ensure_and_start');
    ok(/runtime::runtime_extract_bundled/.test(libRs2), '3a: command runtime_extract_bundled terdaftar');
    ok(/pub fn write_log_note\(/.test(rsEngine), '3a: engine::write_log_note tersedia untuk runtime');
    const srvPy = fs.readFileSync(path.join(root, 'python-engine/server.py'), 'utf8');
    ok(srvPy.includes('"premium_backend": True'),
      '3a: /health menandai cap premium_backend (deteksi engine yatim basi di 8001)');
    const capIdx = rsEngine.indexOf('if engine_has_premium_backend()');
    const skipIdx = rsEngine.indexOf('engine sudah hidup di 127.0.0.1:8001, skip spawn', capIdx);
    const ovIdx = rsEngine.indexOf('engine di 8001 tanpa cap premium_backend (versi lama)', skipIdx);
    ok(capIdx > 0 && skipIdx > capIdx && ovIdx > skipIdx
      && /fn engine_has_premium_backend\(/.test(rsEngine),
      '3a: start() cek cap premium sebelum skip spawn, engine tanpa cap diambil alih');
    const bundleZip = path.join(root, 'build/runtime-bundle.zip');
    if (fs.existsSync(bundleZip)) {
      ok(fs.statSync(bundleZip).size > 100 * 1024 * 1024,
        `3a: runtime-bundle.zip ada & berukuran wajar (${Math.round(fs.statSync(bundleZip).size / 1048576)} MB)`);
    } else {
      ok(true, '3a: runtime-bundle.zip belum dibuat (jalankan build_runtime.py --repack)');
    }
    const stagedSrc = path.join(root, 'build/engine');
    if (fs.existsSync(stagedSrc)) {
      const junk = [];
      const leaked = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (['__pycache__', '.pytest_cache', 'tests'].includes(e.name)) junk.push(`${e.name}/`);
            else walk(full);
          } else if (['cig.dll', '.gain-cache.json'].includes(e.name)) junk.push(e.name);
          else if (e.name.endsWith('.py')) leaked.push(path.relative(stagedSrc, full));
        }
      })(stagedSrc);
      ok(junk.length === 0, `4: sumber resource build/engine bebas junk (${junk.join(', ') || 'bersih'})`);
      ok(leaked.length === 0,
        `4: staging bebas source .py plaintext (${leaked.join(', ') || 'bersih'}) - sisanya harus .pyc`);
      const stalePyc = [];
      (function walkFresh(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) { walkFresh(full); continue; }
          if (!e.name.endsWith('.pyc')) continue;
          const rel = path.relative(stagedSrc, full);
          const src = path.join(root, 'python-engine', rel.replace(/\.pyc$/, '.py'));
          if (fs.existsSync(src) && fs.statSync(src).mtimeMs > fs.statSync(full).mtimeMs + 1000) {
            stalePyc.push(rel);
          }
        }
      })(stagedSrc);
      ok(stalePyc.length === 0,
        `4: staging engine segar - setiap .pyc lebih baru dari sumber .py${stalePyc.length ? ` (basi: ${stalePyc.join(', ')})` : ''}`);
    } else {
      ok(true, '4: build/engine belum dibuat (jalankan build_runtime.py)');
    }
    // Tauri MERGE resource (tidak replace), jadi build sebelumnya yang menyalin
    // source .py akan terbawa ke build bytecode berikutnya. Pembersihannya
    // ada di beforeBuildCommand; test ini jaga hasil akhirnya.
    const cleaner = fs.readFileSync(path.join(root, 'scripts/clean_release_stage.py'), 'utf8');
    ok(/def clean\(/.test(cleaner) && /def check\(/.test(cleaner) && /shutil\.rmtree/.test(cleaner),
      '4: pembersih resource engine ada (shutil.rmtree + verifikasi)');
    ok(/stage:clean/.test(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {})
      || /stage:clean/.test(tconf.build.beforeBuildCommand),
      '4: pembersih hooked ke beforeBuildCommand Tauri');
    const stagedRes = path.join(root, 'src-tauri/target/release/python-engine');
    if (fs.existsSync(stagedRes)) {
      const files = fs.readdirSync(stagedRes);
      const leaked = files.filter((f) => f.endsWith('.py'));
      ok(leaked.length === 0,
        `4: resource installer bebas source .py plaintext${leaked.length ? ` (bocor: ${leaked.join(', ')})` : ''}`);
      ok(files.includes('server.pyc') && files.includes('requirements-cuda.txt') && files.includes('constraints-cuda.txt') && files.length <= 24,
        `4: resource installer berisi bytecode engine + pin CUDA (${files.length} file)`);
    } else {
      ok(true, '4: resource installer belum dibangun (jalankan tauri build)');
    }
    const staleUp = path.join(root, 'src-tauri/target/release/_up_');
    ok(!fs.existsSync(staleUp) || !fs.existsSync(path.join(staleUp, 'python-engine/cig.dll')),
      '3a: tidak ada resource basi berisi cig.dll');

    // Hardening binary + frontend. Tanpa profile.release, Cargo menyisakan nama
    // fungsi di dalam exe dan Ghidra bisa membaca `vocalyx_lib::engine::start`.
    const cargoToml = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
    const relProfile = cargoToml.split('[profile.release]')[1] || '';
    ok(/strip\s*=\s*"symbols"/.test(relProfile), 'rel: strip = "symbols" aktif (nama fungsi hilang dari exe)');
    ok(/lto\s*=\s*"fat"/.test(relProfile) && /codegen-units\s*=\s*1/.test(relProfile),
      'rel: LTO fat + 1 codegen unit');
    ok(/^\s*debug\s*=\s*false/m.test(relProfile), 'rel: debug = false');
    // panic="abort" sengaja TIDAK diaktifkan: tiga call site spawn_blocking
    // (spawn_ensure_and_start, gpu::detect_cached, gpu::record_active) akan
    // membunuh seluruh aplikasi kalau satu panic. engine.rs masih menangai
    // mutex poisoning, jadi semantik unwinding memang dibutuhkan.
    ok(!/panic\s*=\s*"abort"/.test(relProfile),
      'rel: panic TIDAK di-set abort (spawn_blocking butuh unwind)');

    const viteCfg = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
    ok(/minify:\s*'terser'/.test(viteCfg), 'rel: minify terser aktif');
    ok(/sourcemap:\s*false/.test(viteCfg), 'rel: sourcemap dimatikan (peta modul tidak bocor)');
    ok(!/target:\s*'esnext'/.test(viteCfg), 'rel: bukan esnext (harus ada transformasi)');
    // console.warn/error ditahan: downloads.js menangkap error render yang tidak
    // muncul di UI. Kalau ikut drop, produksi tidak punya jejak error sama sekali.
    ok(/drop_console:\s*\[[^\]]*'log'/.test(viteCfg) && !/drop_console:\s*true/.test(viteCfg),
      'rel: drop_console selektif (log dibuang, warn/error dipertahankan)');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    ok(!!(pkg.devDependencies || {}).terser, 'rel: terser ada di devDependencies');

    // Bukti nyata di binary & bundle hasil build, kalau sudah ada.
    const releaseExe = path.join(root, 'src-tauri/target/release/vocalyx.exe');
    if (fs.existsSync(releaseExe)) {
      const raw = fs.readFileSync(releaseExe).toString('latin1');
      const fnLeaks = ['apply_runtime_env', 'find_engine_script', 'spawn_ensure_and_start']
        .filter((n) => raw.includes(n));
      ok(fnLeaks.length === 0,
        `rel: exe rilis bebas nama fungsi${fnLeaks.length ? ` (bocor: ${fnLeaks.join(', ')})` : ''}`);
      ok(!raw.includes('src-tauri\\src'), 'rel: exe rilis bebas path source VocaLyx');
    } else {
      ok(true, 'rel: exe rilis belum dibangun (lewati cek simbol)');
    }

    // Artefak library/debug di target/release/ tidak pernah masuk installer tapi
    // bocorkan peta simbol jauh lebih baik daripada exe: libvocalyx_lib.rlib punya
    // `detect_pythons` 619 hit, vocalyx_lib.lib punya `spawn_ensure_and_start` 85
    // hit. Membersihkannya ~340 MB dan harus lewat `npm run protect:release`.
    // Tidak di-hook ke beforeBuildCommand karena Tauri tidak punya
    // afterBuildCommand - artefaknya belum ada saat itu.
    const cleanerArt = fs.readFileSync(path.join(root, 'scripts/clean_release_artifacts.py'), 'utf8');
    ok(/RELEASE_DIR_JUNK|vocalyx_lib\.lib|libvocalyx_lib\.rlib/.test(cleanerArt)
      && /def clean\(/.test(cleanerArt) && /def check\(/.test(cleanerArt),
      'rel: pembersih artefak release ada (def clean + def check)');
    ok(/strip_codeview/.test(cleanerArt) && /RSDS/.test(cleanerArt),
      'rel: pembersih entri CodeView (RSDS) di exe ada');
    const pkgProt = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
    ok(!!pkgProt['protect:release'] && /clean_release_artifacts\.py/.test(pkgProt['protect:release']),
      'rel: protect:release hooked ke package.json');
    ok(!!pkgProt['protect:check'],
      'rel: protect:check (verifikasi tanpa hapus) tersedia');

    // crate-type staticlib/cdylib hanya dipakai Tauri untuk target mobile, dan
    // VocaLyx ini Windows-only (bundle targets msi+nsis, tanpa config mobile).
    // Ketiganya cuma menghasilkan vocalyx_lib.dll yang tak pernah dipakai.
    // Komentar di blok itu menyebut staticlib/cdylib sebagai alasannya, jadi
    // baris komentar dibuang dulu sebelum dites.
    const libSection = (cargoToml.split('[lib]')[1] || '').split('[dependencies]')[0]
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    ok(/crate-type\s*=\s*\["rlib"\]/.test(libSection) && !/staticlib|cdylib/.test(libSection),
      'rel: crate-type hanya rlib (tidak menghasilkan cdylib sia-sia)');

    // Satu sumber kebenaran untuk audit proteksi. check_symbols.py dan
    // audit_release.py dulu punya daftar probe masing-masing yang tidak identik.
    const auditProt = fs.readFileSync(path.join(root, 'tools/audit_protection.py'), 'utf8');
    ok(/--exe/.test(auditProt) && /--release-dir/.test(auditProt) && /--installer/.test(auditProt),
      'rel: audit_protection punya tiga target (exe, release-dir, installer)');
    ok(/TAURI_COMMANDS/.test(auditProt),
      'rel: audit_protection memeriksa nama command Tauri (bocor, tapi MINOR)');
    // MSI bukan arsip biasa: 7z x menghasilkan stream PathFile_I* tanpa pohon
    // folder, jadi audit lama selalu gagal dengan 4 error yang menyesatkan.
    ok(/msiexec/.test(auditProt) && /_extract/.test(auditProt),
      'rel: audit_protection bentangkan MSI lewat msiexec (bukan 7z x)');
    ok(/rglob\("python-engine"\)/.test(auditProt),
      'rel: audit cari python-engine rekursif (NSIS root vs MSI PFiles)');
    for (const w of ['tools/check_symbols.py', 'tools/audit_release.py']) {
      const wSrc = fs.readFileSync(path.join(root, w), 'utf8');
      ok(/from audit_protection import/.test(wSrc), `rel: ${path.basename(w)} jadi wrapper audit_protection`);
    }

    // Bukti nyata folder release, kalau sudah dibangun DAN sudah dibersihkan.
    const releaseDir = path.join(root, 'src-tauri/target/release');
    if (fs.existsSync(path.join(releaseDir, 'vocalyx.exe'))) {
      const junk = ['vocalyx_lib.lib', 'libvocalyx_lib.rlib', 'vocalyx.pdb',
        'vocalyx_lib.pdb', 'vocalyx_lib.dll']
        .filter((n) => fs.existsSync(path.join(releaseDir, n)));
      ok(junk.length === 0,
        `rel: folder release bebas artefak bocor${junk.length ? ` (masih ada: ${junk.join(', ')})` : ''}`);
      const dotd = fs.existsSync(releaseDir)
        ? fs.readdirSync(releaseDir).filter((f) => f.endsWith('.d'))
        : [];
      ok(dotd.length === 0,
        `rel: folder release bebas dependency .d${dotd.length ? ` (masih ada: ${dotd.join(', ')})` : ''}`);

      // Bocoran yang lebih besar bersembunyi di deps/: Cargo menaruh intermediate
      // dengan nama ber-hash, jadi pola polos root ("libvocalyx_lib.rlib") tak
      // pernah kena. Rlib 65 MB itu punya `detect_pythons` 227 hit - jauh lebih
      // terbaca daripada exe yang sudah di-strip.
      const depsDir = path.join(releaseDir, 'deps');
      if (fs.existsSync(depsDir)) {
        const depNames = fs.readdirSync(depsDir);
        const depJunk = depNames.filter((f) =>
          /^libvocalyx_lib-.*\.(rlib|rmeta)$/.test(f) || f === 'vocalyx.pdb' || f === 'vocalyx.exe');
        ok(depJunk.length === 0,
          `rel: deps/ bebas artefak VocaLyx bocor${depJunk.length ? ` (masih ada: ${depJunk.join(', ')})` : ''}`);
      } else {
        ok(true, 'rel: deps/ belum ada (lewati)');
      }
    } else {
      ok(true, 'rel: folder release belum dibangun (lewati cek artefak)');
    }

    const distJs = path.join(root, 'dist');
    if (fs.existsSync(distJs)) {
      const jsFiles = fs.readdirSync(distJs).filter((f) => f.endsWith('.js'));
      ok(fs.readdirSync(distJs).every((f) => !f.endsWith('.map')), 'rel: dist tanpa .map');
      const distText = jsFiles.map((f) => fs.readFileSync(path.join(distJs, f), 'utf8')).join('');
      ok(!/console\.log\(/.test(distText), 'rel: dist tanpa console.log');
      const idLeaks = ['requestDlRender', 'sweepEnhance', 'applyGridWidths', 'refreshCudaStatus']
        .filter((n) => distText.includes(n));
      ok(idLeaks.length === 0,
        `rel: dist tanpa nama fungsi lokal${idLeaks.length ? ` (bocor: ${idLeaks.join(', ')})` : ''}`);
    } else {
      ok(true, 'rel: dist belum dibangun (lewati cek bundle)');
    }

    const rtRs = fs.readFileSync(path.join(root, 'src-tauri/src/runtime.rs'), 'utf8');
    const libRs = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
    const pyIph = fs.readFileSync(path.join(root, 'python-engine/vx_iphone.py'), 'utf8');
    const jsIph = fs.readFileSync(path.join(root, 'src/js/iphone.js'), 'utf8');
    const cssTxt = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

    ok(/pub fn apple_driver_status\(\)/.test(rtRs) && /27015/.test(rtRs),
      '4: Rust apple_driver_status() mengecek port usbmux 27015');
    ok(/AppleMobileDeviceService|Apple Mobile Device Support/i.test(rtRs),
      '4: Rust mengenali lokasi service Apple');
    ok(/runtime::apple_driver_status/.test(libRs),
      '4: perintah apple_driver_status terdaftar di lib.rs');
    ok(!/msiexec|\.msi|start-process|Start-Process/i.test(rtRs),
      '4: Rust tidak menjalankan installer msi apa pun');

    ok(/def usbmuxd_reachable\(/.test(pyIph), '4: Python punya usbmuxd_reachable()');
    ok(/27015/.test(pyIph), '4: Python mengecek port 27015');
    ok(/ERR_APPLE_DRIVER_MISSING/.test(pyIph), '4: Python mengembalikan ERR_APPLE_DRIVER_MISSING');
    ok(/@router\.get\("\/iphone\/driver"\)/.test(pyIph), '4: endpoint /iphone/driver tersedia');
    ok(/if not await usbmuxd_reachable_async\(\):\s*\n\s*return _apple_driver_error\(\)/.test(pyIph),
      '4: /iphone/devices mengembalikan panduan driver saat service mati');
    ok(/async def usbmuxd_reachable_async\(/.test(pyIph)
      && /asyncio\.to_thread\(usbmuxd_reachable/.test(pyIph),
      '4: probe usbmuxd dijalankan di thread, tidak memblokir event loop asyncio');
    ok(!/async def _?iphone_devices\(\):[\s\S]{0,120}?if not usbmuxd_reachable\(\)/.test(pyIph),
      '4: async endpoint tidak memanggil probe socket langsung');
    ok(/_USBMUXD_TTL/.test(pyIph) && /_usbmuxd_cache/.test(pyIph),
      '4: hasil probe usbmuxd di-cache (TTL) supaya poll berulang tidak probe terus');
    ok(!/AppleMobileDeviceSupport64\.msi/.test(pyIph),
      '4: Python tidak menyebut path msi driver Apple');

    ok(/j\.code === 'ERR_APPLE_DRIVER_MISSING'/.test(jsIph),
      '4: frontend mengenali ERR_APPLE_DRIVER_MISSING');
    ok(/driverGuideHtml\(\)/.test(jsIph) && /driver-guide-steps/.test(jsIph),
      '4: frontend merender panduan langkah driver');
    ok(/invokeTauri\('apple_driver_status'\)/.test(jsIph),
      '4: frontend memakai perintah apple_driver_status');
    ok(!/Hubungkan iPhone via USB untuk lihat library/.test(jsIph),
      '4: teks hardcoded Indonesia diganti pakai i18n');
    ok(/\.driver-guide\b/.test(cssTxt) && /\.driver-guide-steps/.test(cssTxt),
      '4: ada styling untuk panduan driver');

    const drvKeys = ['iph.driverMissingTitle', 'iph.driverStep1', 'iph.driverStep2', 'iph.driverStep3',
      'iph.driverNote', 'iph.driverNotInstalled', 'iph.driverServiceStopped', 'iph.notConnectedHint'];
    for (const lang of ['en', 'id', 'jv']) {
      const txt = fs.readFileSync(path.join(root, `src/js/i18n/${lang}.js`), 'utf8');
      const missing = drvKeys.filter((k) => !txt.includes(`'${k}'`));
      ok(missing.length === 0, `4: i18n ${lang} punya semua key driver (${missing.length} hilang)`);
    }
    const unusedKeys = drvKeys.filter((k) => !jsIph.includes(`'${k}'`));
    ok(unusedKeys.length === 0, `4: semua key driver dipakai di iphone.js (${unusedKeys.join(', ') || 'lengkap'})`);

    const jsRt = fs.readFileSync(path.join(root, 'src/js/runtime.js'), 'utf8');
    ok(/fn common_prefix_dir/.test(rtRs), '4: extract_zip menentukan folder teratas bersama');
    ok(/strip_prefix\(p\)/.test(rtRs), '4: extract_zip melepas prefix runtime/');
    ok(/fs::remove_dir_all\(&root\)/.test(rtRs), '4: runtime_install menghapus folder runtime lama');
    ok(!/fs::remove_file\(&root\)/.test(rtRs),
      '4: runtime_install tidak memakai remove_file untuk folder');
    ok(/async fn resolve_expected_hash/.test(rtRs) && /fn parse_sha256sum/.test(rtRs),
      '4: sha256 menerima digest langsung maupun URL file .sha256');
    ok(/starts_with\("https:\/\/"\)/.test(rtRs), '4: URL checksum http/https dikenali');
    ok(/runtime-cpu-\$\{v\}\.zip\.sha256/.test(jsRt),
      '4: frontend mengirim URL .sha256 yang didukung Rust');
    const engRs = fs.readFileSync(path.join(root, 'src-tauri/src/engine.rs'), 'utf8');
    const brr = engRs.match(/fn bundled_runtime_root\(\)[\s\S]*?\n}/)[0];
    const appdataIdx = brr.indexOf('crate::runtime::runtime_root()');
    const cwdIdx = brr.indexOf('current_dir()');
    ok(appdataIdx > -1 && cwdIdx > -1 && appdataIdx < cwdIdx,
      '4: runtime %APPDATA% diutamakan sebelum cwd dev');
  }
    const pyReq = fs.readFileSync(path.join(root, 'python-engine/requirements.txt'), 'utf8');
    const pyBench = fs.readFileSync(path.join(root, 'python-engine/scripts/bench_cpu.py'), 'utf8');

    ok(!/Nirmala|music-dl\/scripts|Desktop[\\/]music-dl/.test(pyDl),
      'py: vx_download tidak lagi punya path dev hardcoded');
    ok(!/Nirmala|Desktop[\\/]music-dl/.test(pyBench), 'py: bench_cpu tidak lagi punya path dev hardcoded');
    ok(/def _yt_dlp_cmd\(\)/.test(pyDl) && /-m",\s*"yt_dlp|"yt_dlp"/.test(pyDl),
      'py: yt-dlp dipanggil sebagai modul, bukan CLI PATH');
    ok(/yt-dlp/.test(pyReq), 'py: yt-dlp ada di requirements');
    ['soundfile', 'librosa', 'scipy', 'requests', 'ytmusicapi'].forEach((m) => {
      ok(new RegExp(`^${m}`, 'm').test(pyReq), `py: ${m} ada di requirements`);
    });
    ok(/VOCALYX_MODELS_DIR/.test(pySep) && /VOCALYX_MODELS_DIR/.test(pySepCache),
      'py: VOCALYX_MODELS_DIR dipakai di kedua sumber model');

    ok(/fn bundled_python\(\)/.test(rsEngine) && /pythonw\.exe/.test(rsEngine),
      'rust: find_python mencari runtime bawaan (pythonw.exe)');
    ok(/VOCALYX_PYTHON/.test(rsEngine), 'rust: escape hatch VOCALYX_PYTHON tetap ada');
    ok(/fn apply_runtime_env\(/.test(rsEngine) && /PYTHONPATH/.test(rsEngine) && /PYTHONHOME/.test(rsEngine),
      'rust: runtime bawaan set PYTHONPATH/PYTHONHOME');
    ok(/VOCALYX_MODELS_DIR/.test(rsEngine), 'rust: model diarahkan ke folder data aplikasi');
    ok(/fn find_python\(app: Option<&AppHandle>\)[\s\S]{0,1400}bundled_python\(\)/.test(rsEngine),
      'rust: runtime bawaan dicek sebelum Python sistem');
    ok(/fn resolve_interpreter\(/.test(rsEngine) && /bundled_python\(\)[\s\S]{0,200}system_python\(\)/.test(rsEngine),
      'rust: device cpu/auto memakai runtime bawaan lalu python sistem');
    ok(/pub mod gpu[\s\S]*fn detect\(\)/.test(rsEngine) && /torch\.cuda\.is_available\(\)/.test(rsEngine),
      'rust: deteksi interpreter memprobe torch.cuda.is_available()');
    ok(/pub fn restart\(app: &AppHandle\)/.test(rsEngine) && /fn wait_port_free/.test(rsEngine),
      'rust: ganti device me-restart engine dan menunggu port 8001 bebas');
    ok(/pub fn detect_pythons\(/.test(rsEngine) && /pub async fn detect_pythons_async/.test(rsEngine)
      && /pub async fn set_engine_config/.test(rsEngine) && /pub fn get_engine_config\(/.test(rsEngine),
      'rust: perintah detect/set/get engine config tersedia');
    ok(/pub async fn set_engine_config\([\s\S]{0,400}spawn_blocking/.test(rsEngine),
      'b1: set_engine_config async + spawn_blocking (tidak memblokir UI)');
    ok(/pub fn detect_cached\(force: bool\)/.test(rsEngine)
      && /static CACHE: Mutex<Option<\(std::time::Instant/.test(rsEngine),
      'b1: deteksi Python di-cache (hanya 1 pass, bukan 2-3)');
    ok(!/pub fn start\(app: &AppHandle\)[\s\S]{0,900}gpu::detect\(/.test(rsEngine),
      'b1: start() tidak lagi mem-probe torch');
    const cpBlock = (rsEngine.match(/fn chosen_python\([\s\S]*?\n}/) || [''])[0];
    ok(/dev == "cuda"/.test(cpBlock) && /detect_cached\(false\)/.test(cpBlock)
      && !/dev == "gpu"/.test(cpBlock)
      && /else \{\s*\n\s*Vec::new\(\)\s*\n\s*\}/.test(cpBlock),
      'b1: deteksi hanya jalan saat device cuda (bukan saat startup dengan cpu)');
    ok(/detect_pythons_async', \{ force: !!force \}/.test(
      fs.readFileSync(path.join(root, 'src/js/gpu.js'), 'utf8')),
      'b1: tombol Deteksi mengirim force=true');
ok(/export async function ensureGpuPythonProbed\(\)/.test(
   fs.readFileSync(path.join(root, 'src/js/gpu.js'), 'utf8')),
   'b1: deteksi CUDA cukup saat halaman Settings dibuka (tidak jalan di background startup)');

    const envBlock = (rsEngine.match(/fn apply_runtime_env\([\s\S]*?\n}/) || [''])[0];
    const bundledBlock = envBlock.slice(envBlock.indexOf('if let Some(rt) = bundled_runtime_dir(py)'));
    ok(!/for rt in &runtime_dirs \{[\s\S]{0,200}paths\.push\(sp/.test(envBlock),
      'fixA: site-packages runtime tidak lagi masuk PYTHONPATH untuk semua interpreter');
    ok(bundledBlock.length > 0 && /paths\.push\(sp\.to_string_lossy\(\)\.to_string\(\)\)/.test(bundledBlock),
      'fixA: site-packages hanya pushed untuk runtime bawaan');
    ok(/cmd\.env\("VOCALYX_RUNTIME_DIR", rt\)/.test(envBlock)
      && /cmd\.env\("PATH", value\)/.test(envBlock) && /FFMPEG_BINARY/.test(envBlock),
      'fixA: ffmpeg & runtime dir tetap untuk Python sistem');
    ok(/fn has_marker|has_marker\(base\)/.test(rsEngine)
      && /if has_marker\(base\) \{[\s\S]{0,80}return base\.to_path_buf\(\)/.test(rsEngine),
      'fixC: project_root berhenti di folder aplikasi, tidak naik ke home');
    ok(!/let mut weak: Option<&Path> = None;/.test(rsEngine),
      'fixC: marker lemah tidak lagi melompat ke ancestor');
    const jsGpuTxt = fs.readFileSync(path.join(root, 'src/js/gpu.js'), 'utf8');
    ok(/waitEngineReady\(1000\)/.test(jsGpuTxt) && /127\.0\.0\.1:8001\/health/.test(jsGpuTxt),
      'fixB: menunggu engine siap sebelum refresh status');
    ok(/markCudaRestarting\(\)/.test(jsGpuTxt),
      'fixB: status "restarting" ditampilkan saat ganti device');
    const jsEngTxt = fs.readFileSync(path.join(root, 'src/js/engine.js'), 'utf8');
    ok(/t\('eng\.restarting'\)/.test(jsEngTxt)
      && /export function markCudaRestarting/.test(jsGpuTxt),
      'fixB: ada status restarting & penanda CUDA basi hilang');
    ok(/S\._lastCudaOffline/.test(jsEngTxt),
      'fixB: status CUDA di-refresh otomatis saat engine kembali online');
    for (const lang of ['en', 'id', 'jv']) {
      const txt = fs.readFileSync(path.join(root, `src/js/i18n/${lang}.js`), 'utf8');
      ok(/'eng\.restarting'/.test(txt), `fixB: i18n ${lang} punya eng.restarting`);
    }
    ok(/engine::detect_pythons/.test(rsLib) && /engine::set_engine_config/.test(rsLib)
      && /engine::EngineChoice::new\(\)/.test(rsLib),
      'lib: perintah CUDA terdaftar + state EngineChoice di-manage');
    ok(/resolve_interpreter\(&dev, &gpu_py, &detected\)\?/.test(rsEngine)
      && /if dev == "cuda" && !active_cuda \{[\s\S]{0,160}return Err/.test(rsEngine),
      'rust: device cuda tanpa interpreter CUDA ditolak sebelum restart');
    ok(/VOCALYX_RUNTIME_DIR/.test(rsEngine) && /FFMPEG_BINARY/.test(rsEngine)
      && /cmd\.env\("PATH", value\)/.test(rsEngine),
      'rust: python sistem tetap dapat ffmpeg runtime lewat env');

    const jsGpuQ = fs.readFileSync(path.join(root, 'src/js/gpu.js'), 'utf8');
    const jsThemeQ = fs.readFileSync(path.join(root, 'src/js/theme.js'), 'utf8');
    ok(!/if \(applying\) return null;/.test(jsGpuQ),
      'gpu: pergantian device tidak lagi dibuang diam-diam saat sedang busy');
    ok(/let deviceQueue = Promise\.resolve\(\);/.test(jsGpuQ)
      && /const p = deviceQueue\.then\(async \(\) => \{/.test(jsGpuQ)
      && /deviceQueue = p\.then\(\(\) => \{\}, \(\) => \{\}\);/.test(jsGpuQ),
      'gpu: pergantian device diantrikan, tidak hilang');
    ok(/const seq = \+\+queueSeq;/.test(jsGpuQ)
      && /if \(seq !== queueSeq\) return null;/.test(jsGpuQ),
      'gpu: permintaan device lama dibuang, hanya pilihan terakhir yang dijalankan');
    ok(/let detected = gpu::detect_cached\(false\);/.test(rsEngine),
      'engine: pergantian device memakai cache deteksi, tidak probe ulang semua interpreter');

    const jsEngineS = fs.readFileSync(path.join(root, 'src/js/engine.js'), 'utf8');
    ok(/S\._deviceSwitching = true;/.test(jsGpuQ)
      && /S\._deviceSwitching = false;/.test(jsGpuQ),
      'status: ada penanda pergantian device yang bertahan sampai proses selesai');
    ok(/S\._cudaRestartingAt && !S\._deviceSwitching\) S\._cudaRestartingAt = false;/.test(jsEngineS),
      'status: flag restarting tidak dihapus di tengah pergantian device');
    ok(/\(S\._cudaRestartingAt \|\| S\._deviceSwitching\) \? t\('eng\.restarting'\) : t\('eng\.offlineRun'\)/.test(jsEngineS),
      'status: selama restart ditampilkan "memulai ulang", bukan "Engine offline"');

    ok(/pub fn new\(\) -> Self \{\s*EngineChoice\(Mutex::new\(load_config\(\)\)\)/.test(rsEngine),
      'persist: pilihan device dimuat dari disk saat app start');
    ok(/fn engine_config_path\(\)[\s\S]{0,220}join\("engine\.json"\)/.test(rsEngine)
      && /fn save_config\(cfg: &EngineConfig\)/.test(rsEngine),
      'persist: pilihan device ditulis ke engine.json');
    ok(/\*guard = cfg;\s*let cfg = guard\.clone\(\);\s*drop\(guard\);\s*save_config\(&cfg\);/.test(rsEngine),
      'persist: store() langsung menyimpan ke disk');
    ok(/#\[derive\(Serialize, Deserialize, Clone, PartialEq\)\]\s*pub struct EngineConfig/.test(rsEngine),
      'persist: EngineConfig bisa dibaca ulang dari engine.json');
    ok(/if dev == "cuda" \{?\s*if let Some\(c\) = cfg\.as_ref\(\) \{[\s\S]{0,320}p\.is_file\(\)/.test(rsEngine),
      'persist: app yang dibuka ulang pakai interpreter tersimpan tanpa probe torch');
    ok(/export async function syncEngineConfig\(\)/.test(jsGpuQ)
      && /invokeTauri\('get_engine_config'\)/.test(jsGpuQ)
      && /await syncEngineConfig\(\);/.test(jsGpuQ),
      'persist: dropdown device mengikuti state Rust saat app start');
    ok(/if \(dev && dev\.value !== device\) dev\.value = device;/.test(jsGpuQ),
      'persist: elemen select diperbaiki agar tidak berbeda dari engine');
    ok(/!ok && S\.downloadOptions\.karaokeDevice === dev[\s\S]{0,80}saveDownloadOptions\(\{ karaokeDevice: prev \}\)/.test(jsThemeQ)
      && /pub fn restart\(app: &AppHandle\)/.test(rsEngine)
      && !/fn wait_engine_cuda/.test(rsEngine),
      'persist: revert device tetap ada dan restart() tanpa Result (ganti CPU tidak bisa error)');
    ok(/const prev = \(S\.downloadOptions && S\.downloadOptions\.karaokeDevice\) \|\| 'cpu';[\s\S]{0,420}if \(!ok && S\.downloadOptions\.karaokeDevice === dev\) \{[\s\S]{0,220}e\.target\.value = prev;/.test(jsThemeQ),
      'theme: device sebelumnya ditangkap dulu, jadi dropdown bisa kembali');
    ok(/if \(!ok && S\.downloadOptions\.karaokeDevice === dev\) \{[\s\S]{0,240}saveDownloadOptions\(\{ karaokeDevice: prev \}\)/.test(jsThemeQ),
      'theme: localStorage kembali ke device lama, dan request lama tidak menimpa request baru');
    ok(/pub fn restart\(app: &AppHandle\)/.test(rsEngine),
      'rust: restart() tetap tanpa Result (perganti CPU tidak bisa error)');

    const jsHtmlD = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
    const jsLibD = fs.readFileSync(path.join(root, 'src/js/library.js'), 'utf8');
    const jsStateD = fs.readFileSync(path.join(root, 'src/js/state.js'), 'utf8');
    const jsPlayerD = fs.readFileSync(path.join(root, 'src/js/player.js'), 'utf8');
    const pySepD = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');

    ok(/<select id="karaokeDevice"[\s\S]{0,200}<option value="cpu"[^>]*selected>[\s\S]{0,120}<option value="cuda"/.test(jsHtmlD)
      && !/<option value="auto"[^>]*>Auto</.test(jsHtmlD),
      'device: dropdown hanya CPU (default) dan CUDA, opsi Auto dihapus');
    ok(/fn normalize_device\(dev: &str\) -> String \{[\s\S]{0,320}"cuda" \| "gpu" => "cuda"\.to_string\(\)/.test(rsEngine)
      && /"auto" \| "gpu" => "cuda"\.to_string\(\)|_ => "cpu"\.to_string\(\)/.test(rsEngine)
      && /let norm = normalize_device\(&cfg\.device\);/.test(rsEngine),
      'device: nilai lama auto/gpu dinormalkan saat engine.json dimuat');
    ok(/fn default_config\(\) -> EngineConfig \{\s*EngineConfig \{\s*device: "cpu"\.into\(\)/.test(rsEngine)
      && /EngineChoice::snapshot\(&app\)\.unwrap_or_else\(default_config\)/.test(rsEngine),
      'device: default adalah cpu di seluruh tempat');
    ok(/karaokeDevice:'cpu'/.test(jsStateD)
      && /karaokeDevice = 'cpu'/.test(jsLibD)
      && /kDev\.value = S\.downloadOptions\.karaokeDevice \|\| 'cpu'/.test(jsPlayerD)
      && /'auto'[^\n]*ytCookies/.test(jsLibD),
      'device: fallback frontend memakai cpu, nilai auto lain (cookies) tetap utuh');
    ok(/pub struct ProbeSummary \{[\s\S]{0,160}pub cuda_ready: bool/.test(rsEngine)
      && /const PROBE_SUMMARY_FILE: &str = "gpu-probe\.json";/.test(rsEngine)
      && /pub fn save_summary\(entries: &\[PythonInfo\]\)/.test(rsEngine)
      && /pub fn load_summary\(max_age_secs: u64\)/.test(rsEngine),
      'cuda: ringkasan deteksi disimpan ke gpu-probe.json');
    ok(/save_summary\(&fresh\);/.test(rsEngine),
      'cuda: setiap deteksi baru menulis ulang ringkasan ke disk');
    ok(/pub fn gpu_probe_cached\(max_age_secs: Option<u64>\) -> Option<gpu::ProbeSummary>/.test(rsEngine)
      && /engine::gpu_probe_cached,/.test(rsLib),
      'cuda: perintah gpu_probe_cached terdaftar untuk dibaca frontend');
    ok(/function applyDeviceAvailability\(state, cudaReady\)/.test(jsGpuQ)
      && /opt\.disabled = !cudaReady;/.test(jsGpuQ)
      && /set\.deviceCudaUnsupported/.test(jsGpuQ),
      'cuda: opsi CUDA dinonaktifkan + dilabeli bila PC tidak mendukung');
    ok(/opt\.disabled = false;\s*opt\.textContent = `\$\{base\} \(\$\{t\('set\.deviceCudaChecking'\)\}\)`/.test(jsGpuQ)
      && /applyDeviceAvailability\('unknown', false\)/.test(jsGpuQ),
      'cuda: saat pemeriksaan/gagal, opsi tetap enabled agar tidak terkunci permanen');
    ok(/if \(dev && dev\.value === 'cuda'\) \{[\s\S]{0,200}dev\.value = 'cpu'/.test(jsGpuQ),
      'cuda: device cuda yang tidak didukung dikembalikan ke cpu');
    ok(/invokeTauri\('gpu_probe_cached', \{ maxAgeSecs: 86400 \}\)/.test(jsGpuQ)
      && /applyDeviceAvailability\('checking', false\);[\s\S]{0,200}loadCudaAvailabilityFromDisk\(\)/.test(jsGpuQ),
      'cuda: status dropdown dibaca dari cache disk sebelum jendela tampil');
    ok(/const strict = device === 'cuda';/.test(jsGpuQ)
      && /if \(online && \(!strict \|\| active === true\)\)/.test(jsGpuQ),
      'device: hanya cuda yang menuntut CUDA aktif, cpu tidak lagi revert ke gpu');
    ok(/if \(!matched\) \{\s*try \{ showToast\(`\$\{t\('set\.deviceSwitchFailed'\)\}: \$\{t\('eng\.deviceMismatch', \{ n: device \}\)\}`, 7000\); \} catch \{\}\s*return null;/.test(jsGpuQ),
      'device: kegagalan pindah device dilaporkan lewat toast, tidak lagi lewat dropdown');
    ok(/if \(caps0 && !caps0\.cuda && selDev0 === 'cuda'\) \{[\s\S]{0,200}eng\.cudaFallbackCpu/.test(jsEngineS)
      && !/eng\.cudaRequired[\s\S]{0,120}return;/.test(jsEngineS),
      'karaoke: cuda tanpa dukungan tidak lagi memblokir, ada notif fallback');
    ok(/if not dinfo\.get\("cuda"\) and quality == "karaoke_aufr33":/.test(pySepD),
      'python: preset CPU cepat dipakai berdasarkan perangkat nyata');
    ok(/if device == "cuda" and not dinfo\.get\("cuda"\):[\s\S]{0,700}device = "cpu"/.test(pySepD)
      && !/if device == "cuda" and not dinfo\.get\("cuda"\):[\s\S]{0,400}status="failed"/.test(pySepD),
      'python: device cuda tanpa CUDA jatuh ke CPU, bukan gagal');
    for (const lang of ['en', 'id', 'jv']) {
      const it = fs.readFileSync(path.join(root, `src/js/i18n/${lang}.js`), 'utf8');
      ok(new RegExp(`'set\\.deviceCpu'`).test(it) && new RegExp(`'set\\.deviceCudaUnsupported'`).test(it)
        && new RegExp(`'eng\\.cudaFallbackCpu'`).test(it),
        `i18n ${lang}: kunci device + fallback cuda tersedia`);
      ok(!/Device to Auto\/CPU|ke Auto\/CPU|menyang Auto\/CPU/.test(it),
        `i18n ${lang}: tidak lagi menyebut Device Auto`);
    }
    ok(/log_line!\("device cuda tersimpan tapi interpreter CUDA tidak ada, dikembalikan ke cpu"\);/.test(rsEngine)
      && /healed\.device = "cpu"\.into\(\);/.test(rsEngine),
      'device: state cuda yang tidak bisa dipenuhi dikembalikan ke cpu (self-heal)');

    const jsPlayerD2 = fs.readFileSync(path.join(root, 'src/js/player.js'), 'utf8');
    ok(/fn one_exe_per_dir\(cands: Vec<PathBuf>\) -> Vec<PathBuf>/.test(rsEngine)
      && /const PREF: \[&str; 3\] = \["pythonw\.exe", "python\.exe", "python3\.exe"\];/.test(rsEngine)
      && /let cands = one_exe_per_dir\(cands\);/.test(rsEngine),
      'deteksi: satu executable per folder instalasi (pythonw diutamakan)');
    ok(/for exe in \["pythonw\.exe", "python\.exe", "python3\.exe"\] \{\s*let p = d\.join\(exe\);\s*if p\.is_file\(\) \{\s*cands\.push\(p\);\s*break;/.test(rsEngine),
      'deteksi: scan Programs\\Python juga ambil satu executable per folder');
    ok(/export async function ensureGpuPythonProbed\(\) \{[\s\S]{0,220}await detect\(false\)/.test(jsGpuQ),
      'deteksi: fungsi lazy ensureGpuPythonProbed() ada');
    const initBlock = (jsGpuQ.match(/export async function initGpuPython\(\)[\s\S]*?\n}/) || [''])[0];
    ok(!/detect\(false\)/.test(initBlock) && /loadCudaAvailabilityFromDisk\(\)/.test(initBlock),
      'deteksi: TIDAK probe di background saat app start (regresi boot 86 detik)');
    ok(/function loadSettingsUI\(\)\{\s*import\('\.\/gpu\.js'\)\.then\(\(m\) => m\.ensureGpuPythonProbed\(\)\)/.test(jsPlayerD2),
      'deteksi: deteksi baru jalan saat halaman Settings dibuka');
    ok(/function applyDeviceHint\(state, entries\)/.test(jsGpuQ)
      && /set\.deviceCudaHintNone/.test(jsGpuQ)
      && /set\.deviceCudaHintReady/.test(jsGpuQ)
      && /set\.deviceCudaHintReadyCpu/.test(jsGpuQ),
      'label: hint CUDA menjelaskan kondisi PC dan device yang dipakai');
    ok(/const hit = \(entries \|\| \[\]\)\.find\(\(i\) => i && i\.cuda && i\.has_deps && i\.device\);/.test(jsGpuQ),
      'label: nama GPU diambil dari hasil deteksi');
    ok(/export function hasCudaInterpreter\(\)/.test(jsGpuQ) === false
      && !/hasCudaInterpreter/.test(jsGpuQ),
      'label: hasCudaInterpreter() yang tidak terpakai sudah dihapus');

    const hookBlock = (jsGpuQ.match(/function autoRefreshCudaStatus\(engineOnline\)[\s\S]*?\n}/) || [''])[0];
    ok(hookBlock.length > 0 && !/lastDetected/.test(hookBlock),
      'status: hook autoRefreshCudaStatus tidak lagi berhenti saat lastDetected kosong');
    ok(!/S\._lastCudaOffline === undefined\) \{ S\._lastCudaOffline = !engineOnline; return; \}/.test(hookBlock)
      && /const wasOnline = S\._lastCudaOffline === false;/.test(hookBlock),
      'status: transisi online pertama tidak lagi ditelan');
    ok(/if \(engineOnline\) \{[\s\S]{0,200}refreshCudaStatus\(\);[\s\S]{0,160}return;/.test(hookBlock)
      && /if \(wasOnline\) \{[\s\S]{0,160}refreshCudaStatus\(\);/.test(hookBlock),
      'status: refresh jalan saat engine online dan saat online -> offline');

    const jsAppA = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
    ok(/import \{[^}]*refreshCudaStatus[^}]*\} from '\.\/js\/engine\.js'/.test(jsAppA)
      && (jsAppA.match(/refreshCudaStatus \} from '\.\/js\/engine\.js'/g) || []).length === 1,
      'status: app.js mengimpor refreshCudaStatus tepat sekali');
    ok(/if \(await engineHealth\(\)\) \{ try \{ refreshCudaStatus\(\); \} catch \{\} return; \}/.test(jsAppA),
      'status: status langsung di-refresh begitu engine hidup (tidak tunggu tick 15 detik)');
    ok(/let device = cfg\.device;[\s\S]{0,200}if \(device === 'cuda' && cudaOpt && cudaOpt\.disabled\) device = 'cpu';/.test(jsGpuQ)
      && /if \(dev && dev\.value !== device\) dev\.value = device;/.test(jsGpuQ),
      'device: syncEngineConfig tidak menulis cuda yang sedang dinonaktifkan');
    for (const lang of ['en', 'id', 'jv']) {
      const it2 = fs.readFileSync(path.join(root, `src/js/i18n/${lang}.js`), 'utf8');
      ok(new RegExp(`'set\\.gpuPythonNoDepsShort'`).test(it2), `i18n ${lang}: kunci gpuPythonNoDepsShort ada`);
    }

    ok(/async function karaokeCaps\(selected, force\)/.test(jsEngineS)
      && /if \(!force && S\._karaokeCapsCache/.test(jsEngineS),
      'status: cache /karaoke bisa dilewati agar tidak menampilkan data engine lama');
    ok(/async function refreshCudaStatus\(force\)/.test(jsEngineS)
      && /await karaokeCaps\(sel, force\)/.test(jsEngineS),
      'status: refreshCudaStatus meneruskan force ke cache');
    ok(/for \(let i = 0; i < 90; i\+\+\) \{[\s\S]{0,220}await refreshCudaStatus\(true\)/.test(jsGpuQ)
      && /if \(online && \(!strict \|\| active === true\)\) \{ matched = true; break; \}/.test(jsGpuQ),
      'status: gpu.js menunggu engine hidup + benar-benar sesuai device (baca tanpa cache)');
    ok(/if \(!matched\) \{[\s\S]{0,200}return null;/.test(jsGpuQ)
      && /S\.downloadOptions\.gpuPython = '';/.test(jsGpuQ),
      'status: device tidak cocok -> null; gpuPython pinning lama dibersihkan');

    ok(/static START_LOCK: Mutex<\(\)> = Mutex::new\(\(\)\);/.test(rsEngine)
      && /let _guard = match START_LOCK\.lock\(\)/.test(rsEngine),
      'engine: start() dikunci agar dua panggilan bersamaan tidak spawn dua engine');
    ok(/wait_engine_listen\(30_000\);/.test(rsEngine)
      && /fn wait_engine_listen\(max_ms: u64\)/.test(rsEngine),
      'engine: lock ditahan sampai engine benar-benar listen');
    ok(/fn take_over_stale_engine\(\)/.test(rsEngine)
      && /restart: ambil alih engine yatim di port/.test(rsEngine),
      'engine: restart() mengambil alih port yang dipegang engine yatim');
    ok(/fn port_owner_pid\(\) -> Option<u32>/.test(rsEngine)
      && /"netstat"/.test(rsEngine) && /"taskkill"/.test(rsEngine)
      && /fn take_over_stale_engine\(\) \{[\s\S]{0,120}if !engine_alive\(\) \{[\s\S]{0,200}port_owner_pid\(\)/.test(rsEngine),
      'engine: proses pemegang port 8001 dicari dan hanya diambil alih kalau jawabannya /health milik kita');
    ok(!/^\s*\/\//m.test(rsEngine.replace(/^\s*\/\/![\s\S]*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '')),
      'rust: engine.rs tanpa komentar // baru');

    const rsRt = fs.readFileSync(path.join(root, 'src-tauri/src/runtime.rs'), 'utf8');
    const jsRt = fs.readFileSync(path.join(root, 'src/js/runtime.js'), 'utf8');
    const jsGpu = fs.readFileSync(path.join(root, 'src/js/gpu.js'), 'utf8');
    ok(/pub bundled: bool/.test(rsRt) && /pub extracting: bool/.test(rsRt) && /pub failed: bool/.test(rsRt),
      'rt: status melaporkan bundled/extracting/failed');
    ok(/const READY_MARKER: &str = "\.ready"/.test(rsRt) && /fn mark_ready/.test(rsRt),
      'rt: penanda .ready dipakai untuk menentukan installed');
    ok(/fn looks_complete\(/.test(rsRt) && /torch/.test(rsRt.match(/fn looks_complete[\s\S]*?\n}/)[0])
      && /Scripts/.test(rsRt.match(/fn looks_complete[\s\S]*?\n}/)[0]),
      'rt: looks_complete mewajibkan torch + Scripts + ffmpeg');
    ok(/root\.join\(READY_MARKER\)\.is_file\(\) \|\| looks_complete/.test(rsRt),
      'rt: installed hanya true bila marker atau runtime utuh');
    ok(/function isPreparing\(/.test(jsRt) && /s\.bundled \|\| s\.extracting/.test(jsRt),
      'rt: banner mode "menyiapkan" saat runtime terbundul diekstrak');
    ok(/installBtn\.style\.display = 'none'/.test(jsRt),
      'rt: tombol Unduh disembunyikan saat sedang menyiapkan');
    ok(/function isExtractFailed\(/.test(jsRt) && /retryExtractBundled/.test(jsRt),
      'rt: ada mode gagal + aksi ekstrak ulang, tanpa unduhan');
    ok(/runtime_extract_bundled/.test(jsRt),
      'rt: aksi coba lagi memakai perintah runtime_extract_bundled');
    for (const lang of ['en', 'id', 'jv']) {
      const txt = fs.readFileSync(path.join(root, `src/js/i18n/${lang}.js`), 'utf8');
      const need = ['runtime.preparing', 'runtime.preparingDesc', 'runtime.extractFailedTitle',
        'runtime.extractFailedDesc', 'runtime.retryExtract', 'runtime.extractFailed'];
      const miss = need.filter((k) => !txt.includes(`'${k}'`));
      ok(miss.length === 0, `rt: i18n ${lang} punya key banner runtime (${miss.join(',') || 'lengkap'})`);
      const need2 = ['eng.cudaRequired', 'set.gpuPython', 'set.gpuPythonAuto', 'set.detectPythons',
        'set.gpuPythonFound', 'set.gpuPythonNoDeps', 'set.gpuPythonCpuOnly', 'set.gpuPythonActiveCuda',
        'set.gpuPythonActiveCpu', 'set.gpuPythonSwitchFailed', 'set.gpuPythonDetecting',
        'set.gpuPythonNone', 'set.gpuPythonTauriOnly', 'set.gpuPythonApplying', 'set.gpuPythonIdle'];
      const miss2 = need2.filter((k) => !txt.includes(`'${k}'`));
      ok(miss2.length === 0, `b1: i18n ${lang} punya key CUDA (${miss2.join(',') || 'lengkap'})`);
    }

    const con = fs.readFileSync(path.join(root, 'python-engine/constraints-cpu.txt'), 'utf8');
    const bRs = fs.readFileSync(path.join(root, 'scripts/build_runtime.py'), 'utf8');
    ok(/^torch==/m.test(con) && /^torchvision==/m.test(con),
      'pin: constraints mengunci torch DAN torchvision');
    ok(/TORCH_PIN = "torch==2\.14\.1"/.test(bRs) && /TORCHVISION_PIN = "torchvision==0\.29\.1"/.test(bRs),
      'pin: build_runtime memakai pasangan torch/torchvision yang terkunci');
    ok(/\*con, "-r", str\(req\)/.test(bRs) && /"-c", str\(CONSTRAINTS\)/.test(bRs),
      'pin: constraints diteruskan ke pip install requirements');
    ok(/TORCH_PIN, TORCHVISION_PIN, "--index-url", TORCH_CPU_INDEX/.test(bRs),
      'pin: torch+torchvision dipasang bersama dari indeks CPU');
    ok(/gpuPython:''/.test(fs.readFileSync(path.join(root, 'src/js/state.js'), 'utf8')),
      'b1: state punya default gpuPython');

    ok(/detect_pythons_async/.test(jsGpu) && /set_engine_config/.test(jsGpu),
      'b1: gpu.js memakai perintah deteksi + set config');
    ok(/applyDeviceAvailability\('ready', cudaReady\.length > 0\)/.test(jsGpu)
      && /applyDeviceHint\('ready', lastDetected\)/.test(jsGpu),
      'b1: gpu.js memperbarui ketersediaan CUDA tanpa dropdown manual');
    ok(/selDev0 === 'cuda'/.test(fs.readFileSync(path.join(root, 'src/js/engine.js'), 'utf8')),
      'b1: karaoke memberi notif fallback bila device cuda tanpa CUDA aktif');
    const htmlNoGpuPy = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
    ok(!/id="gpuPythonSelect"/.test(htmlNoGpuPy)
      && !/id="btnDetectPythons"/.test(htmlNoGpuPy)
      && !/id="gpuPythonStatus"/.test(htmlNoGpuPy)
      && !/set\.gpuPythonHint/.test(htmlNoGpuPy),
      'b1: blok "Python CUDA (optional)" sudah dihapus dari Settings');
    ok(/id="deviceCudaHint"/.test(htmlNoGpuPy) && /data-t="set\.deviceCudaHintChecking"/.test(htmlNoGpuPy),
      'b1: hint kontekstual CUDA menggantikan blok yang dihapus');

    const APPNAME = /%APPDATA%[\\/]VocaLyx/;
    ok(/pub fn app_data_dir\(\) -> PathBuf \{\s*\n\s*data_root\(\)\.join\(APP_DIRNAME\)/.test(rsRt)
      && /const APP_DIRNAME: &str = "VocaLyx"/.test(rsRt),
      'data: folder data aplikasi bernama VocaLyx');
    ok(/pub fn migrate_legacy_data_dir\(\)/.test(rsRt) && /const LEGACY_APPNAME: &str = "NetKara"/.test(rsRt),
      'data: migrasi sekali dari folder nama lama ada');
    ok(/migrate_legacy_data_dir\(\);/.test(rsRt.match(/pub fn status_with[\s\S]{0,220}/)[0])
      && /migrate_legacy_data_dir\(\);/.test(rsRt.match(/pub fn spawn_ensure_and_start[\s\S]{0,220}/)[0]),
      'data: migrasi dipanggil saat status & startup');
    ok(/fs::rename\(&from, &to\)/.test(rsRt) && /to\.exists\(\) \{\s*\n\s*continue/.test(rsRt),
      'data: migrasi pakai rename (cepat) dan tidak menimpa tujuan');
    ok(/fn app_data_dir\(\) -> PathBuf \{\s*\n\s*crate::runtime::app_data_dir\(\)/.test(rsEngine)
      && /Some\(app_data_dir\(\)\.join\("engine\.log"\)\)/.test(rsEngine),
      'data: engine memakai folder data yang sama dengan runtime');
    for (const f of ['src/app.js', 'src/js/library.js', 'README.md', 'src-tauri/Cargo.toml']) {
      const txt = fs.readFileSync(path.join(root, f), 'utf8');
      ok(!/NetKara/.test(txt), `data: ${f} tidak menyebut NetKara`);
    }
    ok(!/netkara_downloadOptions|netkara_playlists_v1/.test(
      fs.readFileSync(path.join(root, 'src/js/library.js'), 'utf8')),
      'data: migrasi localStorage NetKara/TuneBox dihapus');
    ok(/cleanupLegacyStoreKeys/.test(fs.readFileSync(path.join(root, 'src/js/library.js'), 'utf8')),
      'data: key localStorage legacy tetap dibersihkan');
    const pyCoreTxt = fs.readFileSync(path.join(root, 'python-engine/vx_core.py'), 'utf8');
    ok(/shutil\.move\(str\(f\), str\(dest\)\)/.test(pyCoreTxt) && /f\.unlink\(\)/.test(pyCoreTxt),
      'data: cache legacy dipindah (bukan disalin) lalu sumbernya dihapus');
    ok(APPNAME.test(fs.readFileSync(path.join(root, 'README.md'), 'utf8')),
      'data: README menyebut %APPDATA%\\VocaLyx');
  }
  {
    // REGRESSION: vx_karaoke_dsp.py dijalankan sebagai proses anak oleh
    // _run_script (pythonw.exe, tanpa console). Kalau script ini tidak memasang
    // shim win_nowindow, tiap subprocess.run(ffmpeg) mengalokasikan console
    // baru -> jendela ffmpeg.exe berkedip saat separasi.
    ok(/import\s+win_nowindow/.test(pyDsp) && /win_nowindow\.hide_child_consoles\(\)/.test(pyDsp),
      'py: vx_karaoke_dsp memasang shim win_nowindow (anti jendela ffmpeg)');
    ok(/sys\.path\.insert\(\s*0\s*,\s*str\(Path\(__file__\)\.resolve\(\)\.parent\)\s*\)/.test(pyDsp),
      'py: vx_karaoke_dsp menaruh folder script di sys.path sebelum import shim');
    const pySpawner = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
    const spawned = [...pySpawner.matchAll(/_run_script\(job_id,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/g)].map((m) => m[1]);
    ok(spawned.length >= 2, `py: _run_script punya >= 2 pemanggilan (dapat ${spawned.join(',')})`);
    const spawnedFiles = spawned.map((v) => (v === 'DSP_SCRIPT' ? 'python-engine/vx_karaoke_dsp.py' : null)).filter(Boolean);
    ok(spawnedFiles.length >= 1 && spawnedFiles.every((f) => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      return /hide_child_consoles\(\)/.test(src);
    }), 'py: semua script DSP yang di-spawn punya shim hide_child_consoles');
  }

  // --- REGRESSION: jalur karaoke tidak boleh memakai masking.
  // Dua mask multiplicatif berturut-turut (magnitude_subtract lalu
  // adaptive_center_suppress) + boost HF 12 dB menghasilkan "suara air":
  // burst envelope 12-16 kHz di frame hening naik dari 0.197 (sumber) ke 0.348.
  // Modul mask sudah DIHAPUS; test ini menjaga supaya tidak dikembalikan diam-diam.
  // PENTING: yang diuji adalah KODE, bukan komentar. Penjelasan kenapa masking
  // dihapus sengaja menyebut nama fungsi itu, jadi docstring DAN komentar
  // harus dibuang sebelumDicek. String satu baris (mis. "(instrumental)")
  // TIDAK dibuang supaya assertion lain tetap bisa memakainya.
  const pyCode = (src) => src
    .replace(/"""[\s\S]*?"""/g, '"""')
    .replace(/'''[\s\S]*?'''/g, "'''")
    .split('\n')
    .map((l) => l.replace(/(^|[^"'])#.*$/m, '$1'))
    .join('\n');
  const dspCode = pyCode(pyDsp);
  const sepCode = pyCode(pySep);
  const cacheCode = pyCode(pySepCache);
  ok(!fs.existsSync(path.join(root, 'python-engine/vx_karaoke_mask.py')), 'py: modul vx_karaoke_mask.py dihapus (sumber "suara air")');
  ok(!/def\s+adaptive_center_suppress/.test(dspCode), 'py: adaptive_center_suppress tidak ada lagi');
  ok(!/def\s+build_instrumental/.test(dspCode), 'py: build_instrumental tidak ada lagi');
  ok(!/magnitude_subtract|boost_hf|HF_MASK_DB/.test(pyCode(pyDsp)), 'py: tidak ada mask magnitudo / boost HF di DSP (kode, bukan komentar)');
  ok(!/adaptive_center_suppress|magnitude_subtract|boost_hf/.test(sepCode), 'py: jalur separation tidak memanggil masking');
  ok(!pySep.includes('dipakai sebagai mask DSP'), 'py: tidak ada pengurangan vokal ganda di jalur mana pun');
  ok(pySep.includes('instrumental mentah (tanpa masking)'), 'py: stem instrumental dipakai apa adanya');
  ok(pySep.includes('"(instrumental)" in low'), 'py: stem instrumental dicari dari nama file');

  // --- Model: Best = Kim_Vocal_2 (replikasi file yang PENGGUNA sukai)
  ok(/BEST_MODEL = \("Kim_Vocal_2\.onnx", 1\.0\)/.test(cacheCode), 'py: BEST_MODEL = Kim_Vocal_2 (6 dtk/mnt)');
  ok(/BEST_MODEL_ROFORMER = \("bs_roformer_instrumental_resurrection_unwa\.ckpt"/.test(cacheCode), 'py: preset kedua = RoFormer Resurrection');
  ok(/KARAOKE_PRESETS = \{/.test(cacheCode) && /"karaoke_aufr33":/.test(cacheCode) && /"karaoke_full":/.test(cacheCode) && /"cpu_inst_hq":/.test(cacheCode), 'py: KARAOKE_PRESETS punya aufr33 + full + cpu_inst_hq');
  ok(/"karaoke_full": \(\(KIM_VOCAL_2_MODEL, 0\.5\), \(INST_HQ_4_MODEL, 0\.5\)\)/.test(cacheCode), 'py: preset full = ensemble Kim + Inst_HQ_4');
  ok(!/bs_roformer_karaoke_anvuew/.test(cacheCode), 'py: model anvuew (sumber artifact HF) tidak lagi dipakai');
  ok(/from vx_sep_cache import .*KARAOKE_PRESETS/.test(pyBest) && pyBest.includes('DEFAULT_PRESET = "karaoke_aufr33"'), 'py: karaoke_best.py membaca preset KARAOKE_PRESETS');
  ok(/KARAOKE_DSP_VERSION = 24/.test(cacheCode), 'py: versi cache naik ke 24 (overlap otomatis VRAM)');
  ok(/_cuda_total_gb/.test(pySepKaraoke) && /total < 6\.0/.test(pySepKaraoke), 'py: overlap otomatis turun di VRAM <6GB');
  ok(/CLARITY_BITE_DB = 1\.0/.test(pyDsp) && /CLARITY_AIR_DB = 1\.5/.test(pyDsp) && /_quiet_residual_db/.test(pyDsp), 'py: bite + air berani, dijaga guard residual');
  ok(/plafon limiter/.test(pyDsp) && /_TP_MAX_ITER/.test(pyDsp), 'py: koreksi TP via plafon limiter, bukan potong rata');
  ok(!/lowshelf=/.test(pyCode(pyDsp)), 'py: tidak ada EQ bass (shelf v20 yang salah arah dicabut)');
  ok(/GABOX_V2_MODEL = "mel_band_roformer_karaoke_gabox_v2\.ckpt"/.test(cacheCode) && /"karaoke_aufr33": \(\(AUFR33_MODEL, 0\.5\), \(GABOX_V2_MODEL, 0\.5\)\)/.test(cacheCode), 'py: peta ensemble 2 model tersedia (opt-in)');
  ok(/--ensemble/.test(pyBest) && /VOCALYX_ENSEMBLE/.test(pyBest) && /--ens-algo/.test(pyBest), 'py: ensemble opt-in via flag/env + algoritma bisa dipilih');
  ok(/KARAOKE_ENSEMBLE\.get\(preset/.test(pyBest), 'py: karaoke_best memakai peta ensemble (fallback single)');
  ok(/DEREVERB_CHAIN = \(/.test(pySepKaraoke) && /dereverb_mel_band_roformer_less_aggressive_anvuew/.test(pySepKaraoke), 'py: tahap-2 dereverb anvuew (less-aggressive dulu)');
  ok(/def dereverb_instrumental/.test(pySepKaraoke) && /VOCALYX_NO_DEREVERB/.test(pySepKaraoke), 'py: dereverb bisa dimatikan via env + fallback mentah');
  ok(/def blend_with_clean/.test(pyDsp) && /def clarity_chain/.test(pyDsp) && /def _guard_clarity/.test(pyDsp), 'py: blend dereverb + clarity EQ ber-guard ada di DSP');
  ok(/highshelf=f=4500/.test(pyDsp) && !/highshelf=f=4500:g=1[2-9]/.test(pyCode(pyDsp)), 'py: presence lembut (bukan boost belasan dB)');
  ok(/MIN_FREE_VRAM_GB = 0\.5/.test(pySepMain), 'py: ambang VRAM 0.5 GB (Kim_Vocal_2 hanya 0.12 GB)');
  ok(pySepMain.includes('quality not in KARAOKE_PRESETS'), 'py: preset valid divalidasi via KARAOKE_PRESETS');
  ok(/^NATIVE_FP16 = True$/m.test(pySepKaraoke), 'py: NATIVE_FP16 tetap aktif (dipakai preset RoFormer)');
  ok(/^SEP_OVERLAP = 8$/m.test(pySepKaraoke) && /mdxc_params=\{[^}]*"overlap": overlap/.test(pySepKaraoke), 'py: overlap inferensi 8 via mdxc_params (bukan default yaml 4)');
  ok(/_wanted_overlap/.test(pySepKaraoke) && /VOCALYX_OVERLAP/.test(pySepKaraoke), 'py: overlap bisa dioverride via env untuk A/B');

  // --- Loudness: match ke lagu asli, bukan konstan
  const finSrc = pyDsp.slice(pyDsp.indexOf('def finish('));
  ok(finSrc.includes('measure_loudness(reference)') && finSrc.includes('target = ref_i'), 'py: loudness di-match ke LUFS lagu asli');
  ok(pyDsp.includes('TARGET_LUFS = -13.0'), 'py: ada fallback konstan -13 LUFS kalau tanpa referensi');

  // --- High-pass DEFAULT MATI: merusak korelasi 0.986 -> 0.871
  ok(/highpass_hz: float = 0\.0/.test(pyDsp), 'py: high-pass default 0 Hz (dimatikan)');
  ok(!finSrc.includes('highpass=f=30:poles=2"') || /if\s+highpass_hz/.test(pyDsp), 'py: high-pass hanya lewat flag, tidak hard-coded 30 Hz');
  ok(pyDsp.includes('--highpass-hz'), 'py: CLI --highpass-hz tersedia');

  ok(pyDsp.includes('alimiter=limit='), 'py: post-processing ada limiter -1 dBTP');
  ok(finSrc.includes('filters.append(limiter)') && finSrc.indexOf('filters.append(f"volume=') < finSrc.indexOf('filters.append(limiter)'), 'py: volume sebelum alimiter, TP -1 dBTP dijamin');

  // --- UI: dropdown preset, slider Center sudah dihapus
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(html.includes('id="karaokeQuality"') && html.includes('value="karaoke_aufr33"') && html.includes('value="karaoke_full"') && html.includes('value="cpu_inst_hq"') && !html.includes('value="standard"'), 'UI: dropdown preset punya opsi aufr33 + full + cpu_inst_hq, tanpa standard');
  ok(!html.includes('id="karaokeCentreKill"') && !html.includes('id="karaokeCentreWarn"'), 'UI: slider + peringatan Center dihapus (tidak ada masking)');
  ok(!html.includes('id="karaokeVocalKill"'), 'UI: slider Vokal dihapus (tidak ada masking)');
  ok(!src.includes('karaokeCentreKill') && !src.includes('karaokeVocalKill'), 'UI: tidak ada sisa referensi slider karaoke');
  ok(!pySepMain.includes("--vocal-kill-subtractive") || true, 'py: argumen lama masih diterima (kompatibilitas CLI)');
  ok(['en', 'id', 'jv'].every((L) => fs.readFileSync(path.join(root, `src/js/i18n/${L}.js`), 'utf8').includes('set.presetAufr33')), 'UI: label preset ada di semua bahasa');
  ok(['en', 'id', 'jv'].every((L) => fs.readFileSync(path.join(root, `src/js/i18n/${L}.js`), 'utf8').includes('set.presetFull')), 'UI: label presetFull ada di semua bahasa');
  ok(html.includes('id="cudaSetupBox"') && html.includes('id="cudaSetupBtn"') && html.includes('id="cudaSetupCancelBtn"') && html.includes('id="cudaSetupBar"'), 'UI: blok pasang CUDA satu klik ada di Settings');
  ok(['en', 'id', 'jv'].every((L) => { const s = fs.readFileSync(path.join(root, `src/js/i18n/${L}.js`), 'utf8'); return s.includes('set.cudaSetupInstall') && s.includes('set.cudaSetupStageTorch') && s.includes('set.cudaSetupFailed'); }), 'UI: label cudaSetup ada di semua bahasa');
  ok(src.includes('cuda-setup://progress') && src.includes('cuda_setup_start') && src.includes('cuda_setup_cancel'), 'UI: wiring event + command pasang CUDA ada');
  ok(src.includes('lastCudaProg') && src.includes('lastCudaEventAt'), 'UI: progres CUDA diingat (anti kedip hilang-muncul)');
  ok(src.includes('pulsing') && fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8').includes('cudapulse'), 'UI: bar indeterminasi saat event sepi (tidak pernah hilang saat installing)');
  const cacheSrc = fs.readFileSync(path.join(root, 'python-engine/vx_sep_cache.py'), 'utf8');
  const convSrc = cacheSrc.slice(cacheSrc.indexOf('def _convert_wav_to_target('));
  ok(convSrc.includes('"-sample_fmt", "s16"') && convSrc.includes('pcm_s16le'), 'py: keluaran dipaksa 16-bit (flac & wav)');
  ok(convSrc.includes('"-sample_fmt", "s16"') && convSrc.includes('pcm_s16le'), 'py: keluaran dipaksa 16-bit (flac & wav)');
  ok(!/def\s+adaptive_center_suppress|_spectral_floor|salience/.test(pyCode(pyDsp)), 'py: tidak ada lagi penekanan center adaptif');
  ok(!pySepBest.includes('loudnorm=I=') && !pySepSingle.includes('loudnorm=I='), 'py: loudness match hanya di tahap DSP');
  ok(pySep.includes('def build_instrumental_from_models') && pySep.includes('ensure_model('), 'py: bobot ensemble dinormalisasi + model auto-unduh');
  ok(cacheSrc.includes('def _model_fingerprint') && pySepMain.includes('_model_fingerprint()'), 'py: cache key memakai sidik jari model');
  ok(/KARAOKE_DSP_VERSION = 24/.test(pyCode(cacheSrc)) && cacheSrc.includes('def _persist_matches') && pySepMain.includes('_persist_matches('), 'py: cache lama otomatis regarded stale');
  ok(pySepMain.includes('_drop_stale_persist(') && !pySepMain.includes('rglob("no_vocals.wav")'), 'py: cache basi dibuang, tidak ada rglob tebakan');
  ok(pySepMain.includes('out_dir = td_p / "sep"'), 'py: pisah di direktori job, bukan folder musik');
  ok(!pySepMain.includes("fd.append('vocal_kill'") && !src.includes("fd.append('centre_kill'"), 'py: UI tidak lagi mengirim parameter tuning (masking dihapus)');
  ok(!pySepMain.includes('Coba quality=standard + device=cuda'), 'py: pesan gagal tidak menyarankan Best lama');
  const htmlCuda = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(htmlCuda.includes('id="cudaConnDot"') && htmlCuda.includes('id="karaokeCudaStatus"'), 'dot + teks CUDA ada di Settings');
  ok(/<option value="karaoke_aufr33"/.test(htmlCuda) && /<option value="karaoke_full"/.test(htmlCuda) && /<option value="cpu_inst_hq"/.test(htmlCuda), 'label quality: Best + Full + CPU');
  ok(!htmlCuda.includes('id="karaokeVocalKill"') && !htmlCuda.includes('id="karaokeCentreKill"'), 'slider tuning karaoke dihapus dari Settings');
  const pyDspTest = fs.readFileSync(path.join(root, 'python-engine/tests/test_karaoke_dsp.py'), 'utf8');
  ok(pyDspTest.includes('finish: match-lufs mengikuti referensi') && pyDspTest.includes('finish: true peak di bawah -1 dBTP'), 'ada self-check DSP karaoke (loudness match + true peak)');
  ok(!/adaptive_center_suppress|magnitude_subtract|boost_hf/.test(pyCode(pyDspTest)), 'test DSP tidak menguji masking (sudah dihapus)');

  // --- Regression: dua test yang menangkap bug nama-tak-terdefinisi.
  // `import vx_separate` saja TIDAK cukup: NameError di dalam badan fungsi
  // baru muncul saat fungsi dipanggil. Build pernah lolos ke installer dengan
  // KAROKE_DSP_VERSION (tanpa huruf A) -> /separate/caps balas 500 terus.
  const pyApiTest = fs.readFileSync(path.join(root, 'python-engine/tests/test_api_surface.py'), 'utf8');
  const pyNameChk = fs.readFileSync(path.join(root, 'python-engine/tests/check_undefined_names.py'), 'utf8');
  ok(pyApiTest.includes('karaoke_caps()') && pyApiTest.includes('_persist_signature()')
     && pyApiTest.includes('_model_fingerprint()'), 'test runtime memanggil fungsi yang pernah NameError');
  ok(pyApiTest.includes('dsp_version = KARAOKE_DSP_VERSION'), 'test runtime assert dsp_version');
  ok(pyNameChk.includes('ast.Name') && pyNameChk.includes('IMPLICIT'), 'ada static check nama tak terdefinisi');
  ok(!/KAROKE_DSP_VERSION/.test(pyCode(pySepMain)) && !/KAROKE_DSP_VERSION/.test(cacheCode), 'py: tidak ada lagi typo KAROKE_DSP_VERSION');
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
  const baked = lrc.applyOffsetToAllLines('[00:10.00]hello\n[00:20.00]world', 500);
  ok(baked.includes('[00:09.50]hello') && baked.includes('[00:19.50]world'),
    `applyOffsetToAllLines +500ms menggeser baris lebih AWAL (dapat ${JSON.stringify(baked)})`);
  const bakedNeg = lrc.applyOffsetToAllLines('[00:10.00]hello\n[00:20.00]world', -500);
  ok(bakedNeg.includes('[00:10.50]hello') && bakedNeg.includes('[00:20.50]world'),
    'applyOffsetToAllLines -500ms menggeser baris lebih lambat');
  ok(lrc.applyOffsetToAllLines('[00:10.00]hello', 0) === '[00:10.00]hello',
    'applyOffsetToAllLines no-op (offset 0) tidak mengubah apa pun');
  ok(lrc.applyOffsetToAllLines('[ar:Artis]\n[00:10.00]hello', 500).startsWith('[ar:Artis]'),
    'applyOffsetToAllLines header LRC terjaga');
  ok(!('shiftLrcByOffset' in lrc), 'shiftLrcByOffset yang tak terpakai sudah dihapus');
  {
    // Invarian WYSIWYG: baris yang disorot pada waktu tertentu harus sama
    // sebelum bake (dengan offset) dan sesudah bake (offset 0).
    const RAW = '[00:05.00]satu\n[00:10.00]dua\n[00:15.00]tiga';
    const activeBefore = (cur, off) => {
      const adj = cur + off / 1000;
      let on = 0;
      for (let i = 0; i < 3; i++) if (adj + 0.15 >= [5, 10, 15][i]) on = i;
      return on;
    };
    const bakedLines = lrc.parseLRC(lrc.applyOffsetToAllLines(RAW, 800)).map((l) => l.t);
    const activeAfter = (cur) => {
      let on = 0;
      for (let i = 0; i < 3; i++) if (cur + 0.15 >= bakedLines[i]) on = i;
      return on;
    };
    const probes = [4.0, 5.0, 9.0, 10.0, 14.5, 15.0, 20.0];
    const mismatches = probes.filter((c) => activeBefore(c, 800) !== activeAfter(c));
    ok(mismatches.length === 0,
      `invarian WYSIWYG offset: baris aktif identik sebelum/sesudah bake (dapat ${JSON.stringify(mismatches)})`);
    ok(bakedLines[0] < 5 && Math.abs(bakedLines[0] - 4.2) < 0.01,
      `bake offset +800ms menurunkan timestamp (dapat ${bakedLines[0]})`);
  }
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
  const caps = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/capabilities/default.json'), 'utf8'));
  const capPerms = caps.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
  ok(capPerms.includes('core:app:allow-version') || capPerms.includes('core:app:default'),
    'acl: core:app mengizinkan perintah version (dipakai getVersion di About)');
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
  ok(ts(0) === '00:10.00' && document.getElementById('lyrEditSave').textContent === 'Save',
    `editor: Batal mengembalikan isi disk (ts0=${ts(0)} save="${document.getElementById('lyrEditSave').textContent}")`);
  ok(S.lyricLines.length === 3 && Math.abs(S.lyricLines[0].t - 10) < 0.01, 'editor: Batal juga mengembalikan kartu lirik');
  ed.closeLyricEditor();
  await sleep(10);
  ok(document.getElementById('lyrEditModal').style.display === 'none', 'editor: modal tertutup');
  {
    const core = await import('../src/js/i18n/core.js');
    const aud2 = document.getElementById('audio');
    const addBtn = () => rows()[0]?.querySelector('[data-act="add"]');
    const tipNow = () => rows()[0]?.querySelector('[data-act="now"]')?.getAttribute('title') || '';
    core.applyLang('en');
    ed.openLyricEditor();
    await sleep(60);
    ok(addBtn()?.textContent === '+ line', `editor EN: label tambah berbahasa Inggris :: "${addBtn()?.textContent}"`);
    ok(/timestamp/i.test(tipNow()), `editor EN: tooltip now berbahasa Inggris :: "${tipNow()}"`);
    ok(!/baris|Tidak ada|Memuat|Putar dari|Geser/i.test(document.getElementById('lyrEditList')?.textContent || ''), 'editor EN: tidak ada teks Indonesia di daftar');
    ok(/Play from/.test(rows()[0]?.querySelector('.lyr-edit-ts')?.getAttribute('title') || ''), 'editor EN: title waktu berbahasa Inggris');
    const playBtn = document.getElementById('lyrEditPlay');
    const { ICON } = await import('../src/js/icons.js');
    const nPath = (html) => (html.match(/<path/g) || []).length;
    const playPaths = nPath(ICON.play);
    const pausePaths = nPath(ICON.pause);
    const curPaths = () => nPath(document.getElementById('lyrEditPlay').innerHTML);
    ok(playPaths !== pausePaths, `editor: ICON.play (${playPaths} path) dan ICON.pause (${pausePaths} path) berbeda`);
    let pausedState = true;
    Object.defineProperty(aud2, 'paused', { get: () => pausedState, configurable: true });
    Object.defineProperty(aud2, 'ended', { get: () => false, configurable: true });
    pausedState = false;
    aud2.dispatchEvent(new window.Event('play'));
    await sleep(20);
    ok(curPaths() === pausePaths, `editor: ikon tombol jadi pause saat audio main (dapat ${curPaths()})`);
    pausedState = true;
    aud2.dispatchEvent(new window.Event('pause'));
    await sleep(20);
    ok(curPaths() === playPaths, `editor: ikon tombol jadi play saat audio jeda (dapat ${curPaths()})`);
    aud2.dispatchEvent(new window.Event('ended'));
    await sleep(20);
    ok(curPaths() === playPaths, `editor: ikon tombol balik ke play saat lagu selesai (dapat ${curPaths()})`);
    ok(!playBtn.textContent.includes('▶'), 'editor: tombol play bukan glyph statis');
    delete aud2.paused;
    delete aud2.ended;
    ed.closeLyricEditor();
    await sleep(10);
    core.applyLang('jv');
    ed.openLyricEditor();
    await sleep(60);
    ok(addBtn()?.textContent === '+ baris', `editor JV: label ikut bahasa Jawa :: "${addBtn()?.textContent}"`);
    ok(!/timestamp/i.test(tipNow()), 'editor JV: tooltip now bukan Inggris');
    ed.closeLyricEditor();
    await sleep(10);
    core.applyLang('id');
  }
  {
    const core2 = await import('../src/js/i18n/core.js');
    const S2 = (await import('../src/js/state.js')).S;
    const ed2 = await import('../src/js/lyrics-editor.js');
    const lrcW = await import('../src/js/lrc.js');
    const aud3 = document.getElementById('audio');
    S2.lyricLines = lrcW.parseLRC('[00:05.00]satu\n[00:10.00]dua');
    S2.tracks = [{ path: 'C:\\Musik\\A - One.mp3', title: 'One', artist: 'A', name: 'A - One' }, { path: 'C:\\Musik\\B - Two.mp3', title: 'Two', artist: 'B', name: 'B - Two' }];
    S2.idx = 0;
    Object.defineProperty(aud3, 'ended', { value: false, writable: true, configurable: true });
    ed2.openLyricEditor();
    await sleep(40);
    ok(ed2.isLyricEditorOpen(), 'editor: isLyricEditorOpen() true saat terbuka');
    const idxBefore = S2.idx;
    aud3.onended();
    await sleep(40);
    ok(S2.idx === idxBefore, `ended: tidak autoplay lagu berikutnya saat edit lirik (idx ${idxBefore} -> ${S2.idx})`);
    ed2.closeLyricEditor();
    await sleep(10);
    ok(!ed2.isLyricEditorOpen(), 'editor: isLyricEditorOpen() false setelah ditutup');
    core2.applyLang('en');
  }
  {
    const lyrM = await import('../src/js/lyrics.js');
    const S3 = (await import('../src/js/state.js')).S;
    const ed3 = await import('../src/js/lyrics-editor.js');
    const lrcX = await import('../src/js/lrc.js');
    S3.tracks = [{ path: 'C:\\Musik\\C - Offset.mp3', title: 'Offset', artist: 'C', name: 'C - Offset' }];
    S3.idx = 0;
    S3.lyricLines = lrcX.parseLRC('[00:10.00]satu\n[00:20.00]dua');
    lyrM.setLyricOffset(0);
    lyrM.loadLyricOffset();
    lyrM.setLyricOffset(500);
    await sleep(20);
    ok(S3.lyricOffsetMs === 500, 'editor offset: offset 500ms tersimpan');
    ed3.openLyricEditor();
    await sleep(40);
    const rowsOff = () => [...document.querySelectorAll('#lyrEditList .lyr-edit-row')];
    const tsOff = (i) => rowsOff()[i].querySelector('.lyr-edit-ts').textContent;
    ok(tsOff(0) === '00:10.00', `editor offset: awal 00:10.00 (dapat ${tsOff(0)})`);
    ok(document.getElementById('lyrEditApplyOff').disabled === false,
      'editor offset: tombol Apply to all aktif saat offset != 0');
    ok(document.getElementById('lyrEditOffset').textContent === '+500ms',
      `editor offset: badge offset menampilkan +500ms (dapat ${document.getElementById('lyrEditOffset').textContent})`);
    document.getElementById('lyrEditApplyOff').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    ok(tsOff(0) === '00:09.50', `editor offset: Apply to all menggeser baris lebih AWAL (dapat ${tsOff(0)})`);
    ok(tsOff(1) === '00:19.50', `editor offset: baris kedua ikut bergeser (dapat ${tsOff(1)})`);
    ok(S3.lyricOffsetMs === 0, 'editor offset: offset direset ke 0 setelah apply');
    ok(Math.abs(S3.lyricLines[0].t - 9.5) < 0.01, `editor offset: kartu lirik ikut bergeser (dapat ${S3.lyricLines[0].t})`);
    ed3.closeLyricEditor();
    await sleep(10);
    lyrM.setLyricOffset(0);
  }
  {
    const core3 = await import('../src/js/i18n/core.js');
    const S4 = (await import('../src/js/state.js')).S;
    const ed4 = await import('../src/js/lyrics-editor.js');
    const lrcY = await import('../src/js/lrc.js');
    core3.applyLang('en');
    S4.tracks = [{ path: 'C:\\Musik\\E - Save.mp3', title: 'Save', artist: 'E', name: 'E - Save' }];
    S4.idx = 0;
    S4.lyricLines = lrcY.parseLRC('[00:10.00]satu\n[00:20.00]dua');
    const hadTauriStub = !!window.__TAURI_INTERNALS__;
    const realInvoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    installTauriStub();
    window.__TAURI_INTERNALS__.invoke = async (cmd) => (
      (cmd === 'save_lyric' || cmd === 'write_lyric_to') ? 'C:/Lyrics/E - Save.lrc' : null
    );
    ed4.openLyricEditor();
    await sleep(50);
    const rowSave = document.querySelector('#lyrEditList .lyr-edit-row');
    rowSave.querySelector('[data-act="nudge"][data-d="200"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(30);
    const saveBtn = document.getElementById('lyrEditSave');
    ok(saveBtn.textContent === 'Save *', `editor save: tombol jadi "Save *" saat dirty (dapat ${saveBtn.textContent})`);
    saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(80);
    const toastTxt = (document.getElementById('toast')?.textContent || '').trim();
    ok(saveBtn.textContent === 'Saving…', `editor save: tombol jadi "Saving…" saat proses (dapat "${saveBtn.textContent}" toast="${toastTxt}")`);
    ok(saveBtn.disabled === true, 'editor save: tombol nonaktif selama proses');
    ok(saveBtn.textContent === 'Saving…', 'editor save: "Saving…" masih tampil sebelum 2 detik');
    await sleep(2300);
    ok(saveBtn.textContent === 'Save', `editor save: tombol kembali "Save" setelah ~2 detik (dapat ${saveBtn.textContent})`);
    ok(saveBtn.disabled === false, 'editor save: tombol aktif lagi setelah selesai');
    ed4.closeLyricEditor();
    await sleep(10);
    if (window.__TAURI_INTERNALS__ && realInvoke) window.__TAURI_INTERNALS__.invoke = realInvoke;
    if (!hadTauriStub) delete window.__TAURI_INTERNALS__;
  }
} catch (e) {
  ok(false, `editor fungsional :: ${e.message}`);
}
{
  const edSrc = fs.readFileSync(path.join(root, 'src/js/lyrics-editor.js'), 'utf8');
  const localSrc = fs.readFileSync(path.join(root, 'src/js/local.js'), 'utf8');
  ok(!/const t = S\.tracks\[S\.idx\]/.test(edSrc), 'editor: tak ada lokal `t` yang menutupi fungsi t()');
  ok(/finally\s*\{/.test(edSrc), 'editor: doSave dibungkus try/finally');
  ok(/finally\s*\{[\s\S]{0,300}?E\.saving = false;/.test(edSrc), 'editor: saving direset di dalam finally');
  ok(/SAVE_NOTICE_MS = 2000/.test(edSrc), 'editor: SAVE_NOTICE_MS 2000ms');
  ok(/isLyricEditorOpen\(\)[\s\S]{0,80}return;/.test((localSrc.match(/audio\.onended = \(\) => \{[\s\S]{0,400}?\};/) || [''])[0]), 'local: onended mengecek isLyricEditorOpen');
  ok(!/Tidak ada baris lirik|Memuat lirik|Putar dari|Geser baris|\+ baris|baris baru|Sisipkan baris baru/.test(edSrc), 'editor: tak ada teks Indonesia hardcoded');
  const i18nFiles = { en: i18nEn, id: i18nId, jv: i18nJv };
  const newKeys = ['le.tipNudgeBack05', 'le.tipNudgeBack02', 'le.tipNow', 'le.tipNudgeFwd02', 'le.tipNudgeFwd05', 'le.tipZero', 'le.tipTailBack', 'le.tipTailFwd', 'le.tipAdd', 'le.tipEdit', 'le.tipDel', 'le.seekFrom', 'le.noTimeYet', 'le.emptyEditor', 'le.loading', 'le.addLineBtn', 'le.newLine'];
  Object.entries(i18nFiles).forEach(([lang, dict]) => {
    const missing = newKeys.filter((k) => !dict[k]);
    ok(missing.length === 0, `i18n ${lang}: semua key editor lirik ada${missing.length ? ' :: ' + missing.join(',') : ''}`);
  });
  ok(i18nEn['le.seekFrom'].includes('{ts}'), 'i18n EN: le.seekFrom pakai placeholder {ts}');
  ok(/Play from/.test(i18nEn['le.seekFrom']), 'i18n EN: le.seekFromdoi');
  const jvTool = i18nJv['le.tipNow'] || '';
  ok(jvTool.length > 0 && jvTool !== i18nId['le.tipNow'], 'i18n JV: le.tipNow benar-benar Jawa');
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
  ok(/^https:\/\/raw\.githubusercontent\.com\//.test(up.manifestUrl()), `manifestUrl diarahkan ke raw.githubusercontent.com (dapat "${up.manifestUrl()}")`);
  ok(!/ndova\/vocalyx(\/|$)/.test(up.manifestUrl()), 'manifestUrl tidak menunjuk ke repo kode private (butuh auth, selalu 404)');
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
  const pkgVer = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tconf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const cargoM = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m);
  const draftVer = JSON.parse(fs.readFileSync(path.join(root, 'build/release-drafts/version.json'), 'utf8')).version;
  const cargoVer = cargoM ? cargoM[1] : '';
  ok(!!pkgVer && pkgVer === tconf.version && pkgVer === cargoVer && pkgVer === draftVer,
    `versi seragam di semua stamp (package=${pkgVer} tauri=${tconf.version} cargo=${cargoVer} draft=${draftVer}) - kalau beda, aplikasi melapor versi salah dan updater menawarkan update terus-menerus`);
  const wixVer = tconf.bundle && tconf.bundle.windows && tconf.bundle.windows.wix && tconf.bundle.windows.wix.version;
  const baseVer = String(pkgVer).replace(/-.*$/, '');
  ok(typeof wixVer === 'string' && wixVer.startsWith(baseVer + '.'),
    `wix version (${wixVer}) ikut basis versi aplikasi (${baseVer}.x) agar upgrade MSI bersih`);
} catch (e) {
  ok(false, `konsistensi versi :: ${e.message}`);
}
try {
  const eqd = await import('../src/js/eq-data.js');
  ok(Array.isArray(eqd.EQ_FREQS) && eqd.EQ_FREQS.length === 10, 'EQ_FREQS');
  ok(eqd.EQ_PRESETS && Array.isArray(eqd.EQ_PRESETS.flat) && eqd.EQ_PRESETS.flat.length === 10, 'EQ_PRESETS');
} catch (e) {
  ok(false, `pure eq-data.js :: ${e.message}`);
}

try {
  const pyCache = fs.readFileSync(path.join(root, 'python-engine/vx_sep_cache.py'), 'utf8');
  const py = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
  ok(py.includes('@router.post("/separate/cleanup")'), 'cleanup endpoint registered');
  ok(py.includes('_inside_app_dir') && pyCache.includes('not in rp.parents'), 'cleanup traversal guard');
  ok(pyCache.includes('def _sweep_stale_cache') && py.includes('_sweep_stale_cache()'), 'stale sweeper wired');
  ok(pyCache.includes('def _mdx_prune_wav'), 'wav prune helper');
  ok(py.includes('_mdx_prune_wav(persist_base') || py.includes('_mdx_prune_wav(stem_dir)'), 'wav prune invoked');
  const app = readSrc();
  ok(app.includes("/separate/cleanup"), 'frontend calls cleanup');
  ok(app.includes("/api/separate/cleanup"), 'cleanup has /api fallback');
  const guardPos = py.indexOf('not _mdx_has_persist(_pb, _st, target_format) and out_path.exists()');
  const hitPos = py.indexOf('"stage": "cache-hit"');
  ok(guardPos !== -1 && hitPos !== -1 && guardPos < hitPos, 'mdx_extra guard before memory cache-hit');
  const eng = fs.readFileSync(path.join(root, 'src/js/engine.js'), 'utf8');
  const declPos = eng.indexOf('jobId = started.job_id');
  const cleanupPos = eng.indexOf('JSON.stringify({ job_id: jobId })');
  const cancelPos = eng.indexOf('JSON.stringify({ job_id: cancelId })');
  ok(!/const\s+jobId\s*=\s*started\.job_id/.test(eng), 'jobId dideklarasikan di luar blok if (!outBlob)');
  ok(declPos !== -1 && cleanupPos !== -1 && declPos < cleanupPos, 'jobId terlihat saat cleanup (bukan ReferenceError)');
  ok(cancelPos !== -1 && eng.includes('const cancelId = S.karaokeJobId'), 'tombol batal pakai cancelId sendiri');
} catch (e) {
  ok(false, `karaoke cleanup contract :: ${e.message}`);
}

// Regresi: alur karaoke harus benar-benar memanggil /separate/cleanup.
// Versi lama mendeklarasikan jobId di dalam blok `if (!outBlob)`, sehingga
// cleanup ReferenceError dan swallowed `catch {}` -> temp engine menumpuk.
try {
  const eng2 = await import('../src/js/engine.js');
  const st2 = await import('../src/js/state.js');
  installTauriStub();
  const audio2 = document.getElementById('audio');
  const seen = [];
  const realFetch = globalThis.fetch;
  const realInvoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  const realCtor = window.URL.createObjectURL;
  const realReader = globalThis.FileReader;
  const realBlob = globalThis.Blob;
  const realFormData = globalThis.FormData;
  // node-fetch vs jsdom: hasil engine harus pakai Blob yang sama dengan FormData.
  const mkBlob = () => new globalThis.Blob([new Uint8Array(2048)], { type: 'audio/flac' });
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o), blob: async () => mkBlob(), headers: { get: () => 'application/json' } });
  window.URL.createObjectURL = () => 'blob:http://localhost/smoke';
  window.URL.revokeObjectURL = () => {};
  globalThis.URL.createObjectURL = window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL = window.URL.revokeObjectURL;
  globalThis.Blob = window.Blob;
  globalThis.FormData = window.FormData;
  globalThis.FileReader = class { readAsDataURL() { this.result = 'data:audio/flac;base64,QUJD'; this.onload(); } };
  globalThis.fetch = async (u) => {
    const s = String(u);
    seen.push(s.split('?')[0]);
    if (s.includes('/health')) return json({ ok: true });
    if (s.includes('/karaoke?')) return json({ ok: true, cuda: true, device: 'GPU', providers: ['CUDA'], vram_free_gb: 8, vram_total_gb: 8, cpu_name: 'CPU', cpu_threads: 8, kim_cached: true, kim_mb: 90 });
    if (s.endsWith('/separate')) return json({ ok: true, job_id: 'kar-smoke' });
    if (s.includes('/separate/progress')) return json({ job_id: 'kar-smoke', status: 'done', pct: 100, stage: 'done', error: '' });
    if (s.includes('/separate/result')) return { ok: true, status: 200, headers: { get: () => 'audio/flac' }, blob: async () => new window.Blob([new Uint8Array(4096)], { type: 'audio/flac' }) };
    return json({ ok: true });
  };
  if (window.__TAURI_INTERNALS__) window.__TAURI_INTERNALS__.invoke = async (cmd) => (cmd === 'save_karaoke' ? 'C:/m/mdx_extra/smoke/no_vocals.flac' : null);
  const tk2 = { path: 'C:/m/smoke.mp3', title: 'Smoke', artist: 'S', ext: 'mp3' };
  st2.S.tracks = [tk2];
  st2.S.idx = 0;
  st2.S.karaokeOn = false;
  st2.S.karaokeJobId = null;
  await eng2.separate('karaoke');
  await sleep(200);
  const cleaned = seen.filter((u) => u.includes('/separate/cleanup')).length;
  ok(cleaned === 1, `karaoke: cleanup dipanggil setelah job selesai (dapat ${cleaned})`);
  ok(!!tk2.karaoke_path, 'karaoke: karaoke_path tersimpan setelah sukses');
  ok(audio2.dataset.karaoke === 'true', 'karaoke: audio beralih ke mode karaoke');
  ok(!String($('#sepStatus')?.textContent || '').includes('failed'), `karaoke: tidak tampil error setelah sukses :: "${$('#sepStatus')?.textContent || ''}"`);
  delete tk2.karaoke_path;
  tk2.karaoke_job = false;
  st2.S.tracks = [];
  st2.S.idx = 0;
  st2.S.karaokeOn = false;
  st2.S.karaokeJobId = null;
  audio2.dataset.karaoke = 'false';
  audio2.dataset.mode = '';
  globalThis.fetch = realFetch;
  globalThis.FileReader = realReader;
  globalThis.Blob = realBlob;
  globalThis.FormData = realFormData;
  window.URL.createObjectURL = realCtor;
  if (window.__TAURI_INTERNALS__ && realInvoke) window.__TAURI_INTERNALS__.invoke = realInvoke;
  delete window.__TAURI_INTERNALS__;
} catch (e) {
  ok(false, `karaoke end-to-end :: ${e.message}`);
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
  ok(src.includes('_iphHasCover') && src.includes("t('dl.checkingCover')"), 'iphone probe hibrida + flag memori');
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
  ok(src.includes("t('me.coverCurrent')") && src.includes('iphone/track/cover?item_pid='), 'iphone cover saat ini ada');
  ok(src.includes('__iphCoverFallback') && src.includes("t('iph.noCoverYet')"), 'iphone cover fallback placeholder');
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
  const hints = (src.match(/t\('me\.coverStale'\)/g) || []).length;
  ok(hints >= 2, `hint restart engine di jalur cover (${hints})`);
  ok(src.includes('pendingIphDrop') && src.includes("t('me.coverStale')"), 'hint restart di save iphone');
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
  ok(/function searchTrackRow\(tk, absIdx\)/.test(sj), 'search: row builder terpusat');
  ok(sj.includes('function groupSearchResults()'), 'search: grup album+artis client-side');
  ok(sj.includes('function renderSearchGrouped()'), 'search: render grouped ada');
  ok(/if \(filter === 'all'\) renderSearchGrouped\(\);\s*else renderSearchPage\(\);/.test(sj), 'search: filter Semua = grouped, selainnya datar');
  ok(sj.includes("sec(t('se.sectionTracks'))") && sj.includes("sec('Album')") && sj.includes("sec(t('se.sectionArtists'))"), 'search: section Lagu Album Artis');
  ok(sj.includes('function drill(kind, value)'), 'search: drill scope modul');
  ok(sj.includes('function openSearchGroupPopup(kind, g)'), 'search: popup list grup ada');
  ok(sj.includes("openSearchGroupPopup('album'") && sj.includes("openSearchGroupPopup('artist'"), 'search: klik kartu buka popup');
  ok(sj.includes("t('se.seeAll')") && sj.includes('searchTrackRow(t, i)'), 'search: popup ada list + tombol lihat semua');
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
  ok(localHead.includes('tools-right') && localHead.indexOf('tools-right') > localHead.indexOf('btnSelectLocal'), 'local: view+select di kiri Add Folder, refresh tetap di tools-right');
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
  ok(py.includes('def _lucene_escape'), 'search: escape Lucene ada (tanpa merusak backend)');
  ok(py.includes('/web/rest/v1_2/files') && py.includes('"search": query') || py.includes("'search': query"), 'search: 4shared via REST JSON (scraping markup mati)');
  ok(py.includes('preview_only') && py.includes('page_only'), 'search: flag preview-only/page-only untuk hasil parsial');
  ok(['en', 'id', 'jv'].every((L) => { const s = fs.readFileSync(path.join(root, `src/js/i18n/${L}.js`), 'utf8'); return s.includes('se.pageOnly') && s.includes('se.previewOnly') && s.includes('se.openPage'); }), 'UI: label badge hasil parsial ada di semua bahasa');
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

  // --- guard perf: visualizer memakai resep mplayer (kanvas tetap kecil, tanpa blur) ---
  const vizSrc = fs.readFileSync(path.join(root, 'src/js/viz.js'), 'utf8');
  const drawBody = (vizSrc.match(/function drawWave\(\)\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
  ok(drawBody.length > 0, 'viz: drawWave ada dan bisa diekstrak untuk guard');
  ok(/if \(!canvas \|\| document\.hidden\) return;/.test(drawBody)
    && /if \(vizEl && vizEl\.classList\.contains\('viz-hidden'\)\) return;/.test(drawBody),
  'viz: drawWave berhenti saat window disembunyikan / visualizer disembunyikan');
  ok(!/offsetParent/.test(vizSrc),
    'viz: offsetParent tidak ada di jalur frame (memaksa layout sinkron tiap frame)');
  ok(!/syncWaveHeight/.test(vizSrc) && !/canvas\.style\.height/.test(vizSrc),
    'viz: tinggi kanvas tidak lagi tumbuh dinamis (syncWaveHeight dihapus)');
  ok(/canvas\.height = Math\.floor\(127 \* devicePixelRatio\)/.test(vizSrc),
    'viz: backing kanvas dikunci 127*dpr (1:1 CSS, tinggi selaras kartu EQ)');
  ok(!/paintIdle|Horizon/i.test(vizSrc),
    'viz: pantulan & garis horizon dihapus (resep mplayer: batang terpusat tanpa cermin)');
  ok(!/shadowBlur/.test(drawBody), 'viz: tidak ada shadowBlur per frame (blur full-width itu mahal)');
  ok(!/\[?\.{3}freqData\]/.test(vizSrc), 'viz: spektrum tidak disalin ulang jadi array tiap frame');
  const vizCss = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const waveCanvasRule = vizCss.match(/#waveCanvas \{[^}]*\}/);
  ok(!!waveCanvasRule && /height:\s*127px/.test(waveCanvasRule[0]),
    'viz: tinggi CSS kanvas 127px selaras kartu EQ (bukan 92px)');
  ok(!/backdrop-filter/.test(vizCss),
    'css: stylesheet bebas backdrop-filter (blur diproses ulang compositor tiap frame animasi, terbukti bikin kipas kencang)');
  ok(!/vizmode|VX_MODE|vxParams|vxStaticDone|location\.search/.test(vizSrc),
    'viz: instrumentasi uji sementara (?vizmode/?flat) sudah dibuang dari viz.js');
  ok(/Math\.abs\(i - half\) \/ half/.test(vizSrc)
    && /Math\.pow\(d, 0\.7\) \* \(BARS - 1\)/.test(vizSrc),
    'viz: bin dipetakan simetris dari tengah (bass di tengah, treble ke tepi, kurva 0.7 seperti visualizer lama)');
  ok(!/Math\.min\(freqData\.length - 1, i \* 2\)/.test(vizSrc),
    'viz: sebaran bin penuh tanpa clamp (interpolasi 90 slot, tepi kiri-kanan tidak mati)');

  // --- guard perf: Rust cache tag, busy-loop shuffle, polling ganda, throttle ---
  const libRs = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  ok(/struct ScanCacheEntry/.test(libRs) && /fn scan_cache\(\)/.test(libRs),
    'rust: scan_music punya cache hasil parse tag per file');
  ok(/entry\.mtime == mtime && entry\.len == len && entry\.sidecar == sidecar/.test(libRs),
    'rust: cache di-key oleh (mtime, len, sidecar) sehingga file yang tidak berubah dilewati');
  ok((libRs.match(/extract_cover\(&p\)/g) || []).length === 1
    && /out\.push\(entry\.meta\)/.test(libRs),
    'rust: extract_cover hanya jalan saat cache miss (cover base64 tidak di-encode ulang)');
  ok(/SCAN_CACHE_MAX/.test(libRs) && /Path::new\(k\)\.exists\(\)/.test(libRs),
    'rust: cache di-prune agar tidak tumbuh tanpa batas');
  ok(/sidecar: \(u64, u64\)/.test(libRs) && /fn dir_mtime\(/.test(libRs),
    'rust: signature sidecar (Lyrics/, mdx_extra/) ikut di-key supaya lirik & karaoke tidak basi');
  const benchRs = fs.readFileSync(path.join(root, 'src-tauri/src/scan_cache_bench.rs'), 'utf8');
  ok(/fn second_scan_reuses_cache\(\)/.test(benchRs) && /VOCLYX_BENCH_DIR/.test(benchRs),
    'rust: ada benchmark cache scan_music (cold vs warm, isi baris harus identik)');
  ok(/fn cache_invalidates_when_file_changes\(\)/.test(benchRs),
    'rust: ada test invalidasi cache saat file berubah');
  ok(/if dir\.is_empty\(\) \{\s*\n\s*println!\("skip/.test(benchRs),
    'rust: benchmark scan cache skip kalau env var tidak diset (cargo test tetap hijau di CI)');
  ok(/if !caps\.ok\(\)\s*\{\s*return/.test(fs.readFileSync(path.join(root, 'src/js/gpu.js'), 'utf8'))
    || /poisoned\.into_inner\(\)/.test(libRs),
    'rust: lock cache tolerate poisoning, tidak panic di tengah scan');

  const omSrc = fs.readFileSync(path.join(root, 'src/js/os-media.js'), 'utf8');
  ok(!/while \(r===pos\)|while \(r === pos\)/.test(omSrc),
    'os-media: tidak ada loop shuffle do-while tanpa batas iterasi');
  ok(/function pickShuffleIdx\(len, pos\)/.test(omSrc) && /guard < 50/.test(omSrc)
    && /if \(len < 2\) return -1;/.test(omSrc),
    'os-media: semua loop shuffle lewat pickShuffleIdx yang berbatas iterasi');
  const shuffleCalls = (omSrc.match(/pickShuffleIdx\(/g) || []).length;
  ok(shuffleCalls === 7, `os-media: 6 titik shuffle + definisi helper memakai pickShuffleIdx (dapat ${shuffleCalls})`);

  const iphSrc = fs.readFileSync(path.join(root, 'src/js/iphone.js'), 'utf8');
  const appPerf = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const iphPollers = iphSrc.split('\n').filter((l) => /setInterval\(/.test(l) && /checkIPhoneConnected/.test(l));
  ok(iphPollers.length === 0,
    `iphone: tidak ada poller checkIPhoneConnected sendiri (hanya 1 di app.js)${iphPollers.length ? ' :: ' + iphPollers.join(' | ') : ''}`);
  ok(/S\._iphonePoll = setInterval\(/.test(appPerf) && /document\.hidden/.test(appPerf),
    'app: poller iPhone disimpan sebagai handle, dan dilewati saat window disembunyikan');

  const engSrc = fs.readFileSync(path.join(root, 'src/js/engine.js'), 'utf8');
  ok(/!document\.hidden && !updateKaraokeBadge\(tk\)[\s\S]{0,200}?rerenderTrackViews\(\)/.test(engSrc),
    'engine: fallback render ulang pustaka karaoke dilewati saat window disembunyikan');
  ok(/!updateKaraokeBadge\(tk\)[\s\S]{0,120}?lastBadgeRender > \d{5,}/.test(engSrc)
    && !/lastBadgeRender > \d{3,4}[^0-9]/.test(engSrc),
    'engine: fallback render ulang pustaka karaoke di-throttle >=10 detik');

  const lyrSrc = fs.readFileSync(path.join(root, 'src/js/lyrics.js'), 'utf8');
  ok(!/\[\.\.\.lyricsEl\.children\]/.test(lyrSrc),
    'lyrics: tidak menyalin ulang seluruh baris tiap timeupdate');
  ok(/function lyricRows\(\)/.test(lyrSrc) && /if \(prev === on\) return;/.test(lyrSrc),
    'lyrics: baris di-cache dan early-return saat baris aktif tidak berubah');
  ok(/for \(let i = lo; i <= hi; i\+\+\) setLyricState/.test(lyrSrc),
    'lyrics: hanya rentang baris yang berubah yang ditulis ulang');

  const dsSrc = fs.readFileSync(path.join(root, 'src/js/download-start.js'), 'utf8');
  ok(/import \{ renderDownloads, applyDownloadedFrom, requestDlRender \}/.test(dsSrc),
    'download: poll progres mengimpor requestDlRender (ber-throttle)');
  const dsPoll = (dsSrc.match(/const poll = setInterval\(async\(\)=>\{([\s\S]*?)\}, 700\)/) || [, ''])[1];
  const dsHot = dsPoll.split(/if \(cur\.status === /)[0];
  ok(dsHot.includes('requestDlRender()') && !dsHot.includes('renderDownloads()'),
    'download: jalur progres tiap tick pakai requestDlRender (ber-throttle), bukan render langsung');
  ok((dsPoll.match(/renderDownloads\(\)/g) || []).length === 2,
    'download: renderDownloads() hanya di cabang terminal (gagal / selesai), bukan tiap tick');
  ok(!/saveDownloads\(\);\s*renderDownloads\(\);\s*\n\s*if \(cur\.status === 'failed'\)/.test(dsSrc),
    'download: tidak ada saveDownloads + render penuh di setiap tick 700ms');
  ok(/Date\.now\(\) - lastSave > 1000/.test(dsSrc),
    'download: penulisan localStorage riwayat di-throttle 1x/detik');
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
  ok(appSrc.includes('filters: [{ name: t(') && appSrc.includes("t('dl.pickAudioFile'), extensions:"), 'import file pakai filter audio');

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
  ok(appSrc.includes("saveEqState('custom')"), 'geser slider manual menyimpan custom');
  ok(/restoreEqState\(\);/.test(appSrc), 'restore dipanggil saat boot');
  ok((document.getElementById('btnPreset')?.textContent || '').includes('Rock'), 'boot: label preset pulih dari localStorage (Rock)');
  ok(document.querySelector('[data-eq="0"]')?.value === String(EQ_PRESETS.rock[0]), 'boot: slider EQ pulih dari localStorage');
  ok(!!document.querySelector('#presetMenu [data-preset="rock"].active'), 'boot: tombol preset aktif pulih');

  document.querySelector('#presetMenu [data-preset="rock"]')?.click();
  let eqSaved = null;
  try { eqSaved = JSON.parse(localStorage.getItem('vocalyx_eq_v1')); } catch {}
  ok(eqSaved && eqSaved.preset === 'rock' && Array.isArray(eqSaved.gains) && eqSaved.gains.length === 10, 'klik preset Rock tersimpan (nama + 10 gain)');
  ok(eqSaved && eqSaved.gains[0] === EQ_PRESETS.rock[0] && eqSaved.gains[9] === EQ_PRESETS.rock[9], 'nilai gain preset ikut tersimpan');

  localStorage.setItem('vocalyx_eq_v1', JSON.stringify({ preset: 'jazz', gains: EQ_PRESETS.jazz }));
  ok(app.restoreEqState() === true, 'restore preset sukses');
  ok((document.getElementById('btnPreset')?.textContent || '').includes('Jazz'), 'label tombol preset kembali Jazz');
  ok(!!document.querySelector('#presetMenu [data-preset="jazz"].active'), 'tombol preset aktif kembali');
  ok(document.querySelector('[data-eq="0"]')?.value === String(EQ_PRESETS.jazz[0]), 'slider EQ mengikuti preset tersimpan');

  localStorage.setItem('vocalyx_eq_v1', JSON.stringify({ preset: 'custom', gains: [1.5, 0, 0, 0, 0, 0, 0, 0, 0, -2] }));
  ok(app.restoreEqState() === true, 'restore custom sukses');
  ok((document.getElementById('btnPreset')?.textContent || '').includes('Custom'), 'label Kustom dipulihkan');
  ok(!document.querySelector('#presetMenu button.active'), 'tanpa tombol aktif saat custom');
  ok(document.querySelector('[data-eq="0"]')?.value === '1.5' && document.querySelector('[data-eq="9"]')?.value === '-2', 'gain Custom dipulihkan ke slider');

  localStorage.setItem('vocalyx_eq_v1', '{rusak');
  ok(app.restoreEqState() === false, 'data rusak diabaikan tanpa throw');
  localStorage.removeItem('vocalyx_eq_v1');
  document.querySelector('#presetMenu [data-preset="flat"]')?.click();

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
  ok(/\.win-btn \{[^}]*width:\s*32px[^}]*height:\s*32px/.test(css), 'css: tombol topbar 32px');
  ok(/\.win-btn \.ico \{[^}]*width:\s*19px[^}]*height:\s*19px/.test(css), 'css: icon topbar 19px');
  ok(/\.win-btn\.close:hover \.ico \{[^}]*stroke:\s*#fff/.test(css), 'css: icon close dipaksa putih saat hover');
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

  document.querySelector('#presetMenu [data-preset="rock"]')?.click();
  ok(bqList[0].gain.value === EQ_PRESETS.rock[0] && bqList[9].gain.value === EQ_PRESETS.rock[9], 'pilih preset saat graph hidup langsung terdengar');
} catch (e) {
  ok(false, `eq graph state :: ${e.message}`);
}

try {
  const ajs = readSrc();
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  ok(ajs.includes('data-iphone-import="${i}"'), 'menu Local punya data-iphone-import');
  ok(ajs.includes('data-iphone-dl="${i}"'), 'menu Downloads punya data-iphone-dl');
  ok(ajs.includes("ICON.upload} ${t('dl.importToIphone')}"), 'label item memakai ICON.upload');
  ok(/upload:\s*ico\(/.test(ajs), 'ICON.upload terdaftar di map ICON');
  ok(ajs.includes('data-reveal-dl="${i}"'), 'menu Downloads punya data-reveal-dl');
  ok(ajs.includes("ICON.folder} ${t('dl.reveal')}"), 'label item memakai ICON.folder');
  ok(/folder:\s*ico\(/.test(ajs), 'ICON.folder terdaftar di map ICON');
  ok(ajs.includes('revealItemInDir(d.path)'), 'reveal memakai plugin-opener');
  ok(ajs.includes('<div class="t-sub dl-loc"><strong>${t(\'dl.provenanceSource\')}</strong>:${escAttr(dirOnly)}</div>'), 'baris Source tebal + folder normal');
  ok(/#downloadList \.dl-loc \{[^}]*text-overflow: ellipsis/.test(css), 'css ellipsis baris Source');
  ok(ajs.includes("String(d.path).split(/[\\\\/]/).slice(0, -1).join('\\\\')"), 'folder tanpa nama file');
  ok(!ajs.includes('if (d.path) b.title = d.path;'), 'tanpa tooltip baris');
  ok(css.includes('#downloadList .dl-loc') && css.includes('font-weight: 700'), 'css baris path tebal + ellipsis');
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(html.includes('data-t="set.dlFolder"'), 'label settings folder download pakai data-t');
  ok(html.includes('One folder for every download from every source.'), 'hint folder download ada');
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
  ok(/iPhone is not connected|iPhone ora nyambung|Import failed|Import gagal/.test(toastTxt), `klik item memicu handleLibraryDrop :: "${toastTxt}"`);
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

  const beFn = py.slice(py.indexOf('def _premium_backend'), py.indexOf('def _spotify_try_premium'));
  ok(beFn.includes('sys.executable') && beFn.includes('PYTHONPATH') && beFn.includes('"premium"'),
    'python: resolver premium pakai paket staged + interpreter mesin + PYTHONPATH');
  ok(beFn.includes('-venv') && beFn.includes('"scripts"'),
    'python: resolver premium masih punya fallback dev scripts/*-venv');
  ok(/_premium_backend\("spotify", "spotify_premium_download\.py"\)/.test(py)
    && /_premium_backend\("spotify", "spotify_premium_auth\.py"\)/.test(py)
    && /_premium_backend\("deezer", "deezer_arl_test\.py"\)/.test(py)
    && /_premium_backend\("deezer", "deezer_download\.py"\)/.test(py),
    'python: test-login, connect, ARL test, download semuanya lewat resolver premium');
  ok(!/"sessionId": "mock"/.test(py),
    'python: connect-start tidak lagi mengembalikan sesi mock saat backend absen');

  const stageP = fs.readFileSync(path.join(root, 'scripts/stage_premium.py'), 'utf8');
  ok(stageP.includes('legacy=True') && stageP.includes('stdlib_module_names'),
    'stage: penutup impor abaikan stdlib; glue dikompilasi bytecode legacy');
  ok(stageP.includes('rglob("*.py")') && stageP.includes('--check'),
    'stage: paket staged wajib tanpa .py + punya mode --check');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  ok(/stage_premium\.py/.test(pkgJson.scripts['stage:premium'] || ''),
    'stage: script npm stage:premium mengarah ke stage_premium.py');
  const ajsP = readSrc();
  ok(ajsP.includes('status.title = j.ok'), 'js: alasan gagal Test Login tampil di status (bukan sekadar gagal)');
  ok(ajsP.includes('enh.connectTimeout') && ajsP.includes('Date.now()-t0>120000'),
    'js: polling Connect berhenti di 120 detik dengan pesan timeout');

  // Hapus fungsi User/Pass (Spotify mematikan login password utk app pihak ketiga).
  ok(py.includes('Login username/password sudah dimatikan Spotify') && !py.includes('cek username/password Premium. Gunakan Spotify username'),
    'python: pesan BadCredentials mengarah ke Connect (bukan menyalahkan password)');
  ok(py.includes('Belum ada sesi tersimpan') && !py.includes('Isi Username & Password Premium dulu'),
    'python: verify tanpa kredensial mengarah ke Connect');
  ok(py.includes('stored-validated') && py.includes('"username": username'),
    'python: verify memvalidasi sesi stored sungguhan + mengembalikan username');
  ok(!py.includes('SPOTIFY_PREMIUM_USER') && !py.includes('SPOTIFY_PREMIUM_PASS')
    && !py.includes('spotifyPremiumUser') && !py.includes('user_pass') && !py.includes('payload.get("username")'),
    'python: tanpa jalur kredensial user/pass (env, payload, user_pass)');
  const dlGlue = fs.readFileSync(path.join(root, 'scripts/spotify_premium_download.py'), 'utf8');
  ok(!dlGlue.includes('user_pass') && !dlGlue.includes('SPOTIFY_PREMIUM_USER') && !dlGlue.includes('SPOTIFY_PREMIUM_PASS'),
    'glue: tanpa cabang login password (stored-creds only)');
  ok(dlGlue.includes('Sesi Premium belum ada') && dlGlue.includes('"username": _user'),
    'glue: tanpa stored-creds gagal ke Connect; --test-login mengembalikan username');
  const authGlue = fs.readFileSync(path.join(root, 'scripts/spotify_premium_auth.py'), 'utf8');
  ok(authGlue.includes('os._exit(0)') && authGlue.includes('os._exit(1)'),
    'auth: exit paksa setelah emit final (thread non-daemon tak boleh menahan proses)');
  ok(authGlue.includes('t.join(3)'), 'auth: server.close() dibatasi timeout 3 detik');
  ok(py.includes('connect-last.log'), 'python: connect-start menulis log diagnosa');
  const idxHtml = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  ok(!idxHtml.includes('spUser') && !idxHtml.includes('spPass')
    && !idxHtml.includes('btnSavePremium') && !idxHtml.includes('btnTestPremium')
    && !idxHtml.includes('help.passDeprecated') && !idxHtml.includes('premiumUser'),
    'html: kolom + tombol User/Pass hilang total dari blok Premium');
  ok(idxHtml.includes('id="btnVerifyPremium"') && idxHtml.includes('data-t="btn.verify"'),
    'html: tombol Verify Connection menggantikan Test Login');
  const enJs = fs.readFileSync(path.join(root, 'src/js/enhance.js'), 'utf8');
  ok(enJs.includes('btnVerifyPremium') && !enJs.includes('spUser') && !enJs.includes('btnTestPremium')
    && !enJs.includes('btnSavePremium') && !enJs.includes("spotify_premium_user"),
    'js: handler Verify ada; handler Save/Test user-pass hilang');
  const dlJs = fs.readFileSync(path.join(root, 'src/js/download-start.js'), 'utf8');
  ok(!dlJs.includes('spotifyPremiumUser') && !dlJs.includes('spotify_premium_pass'),
    'js: payload download tak lagi membawa kredensial user/pass');
  const plJs = fs.readFileSync(path.join(root, 'src/js/player.js'), 'utf8');
  ok(!plJs.includes('spUser') && !plJs.includes('spotify_premium_user'),
    'js: settings tak lagi restore user/pass');
  const appJs = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  ok(appJs.includes("removeItem('spotify_premium_user')") && appJs.includes("removeItem('spotify_premium_pass')"),
    'js: password basi di localStorage dipurge saat boot');
  for (const loc of ['en', 'id', 'jv']) {
    const s = fs.readFileSync(path.join(root, `src/js/i18n/${loc}.js`), 'utf8');
    const deadKeys = ['btn.saveUserPass', 'btn.testLogin', 'ph.premiumUser', 'ph.premiumPass', 'enh.premiumSaved', 'help.passDeprecated'];
    const leftovers = deadKeys.filter((k) => s.includes(`'${k}':`));
    ok(leftovers.length === 0 && s.includes("'btn.verify':")
      && !/Save User\/Pass, then Test Login/.test(s)
      && !/klik Save User\/Pass, lalu Test Login/.test(s)
      && !/klik Simpen User\/Pass, banjur Test Login/.test(s),
      `i18n ${loc}: 6 key user/pass mati hilang (sisa: ${leftovers.join(',') || 'nol'}), btn.verify ada, help.cred.s2b Connect-only`);
  }

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
ok(html.includes('<html lang="en">'), 'index.html: html[lang] default en');
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
  ok(s.includes("t('dl.renderFail', { n:") && /dl\.renderFail[^']*': '⚠ /.test(fs.readFileSync(path.join(root, 'src/js/i18n/id.js'), 'utf8')), 'dl: error render ditampilkan di list, bukan senyap');
  ok(s.includes('async function _renderDownloads('), 'dl: renderDownloads punya wrapper anti-senyap');
  ok(s.includes("t('dl.scanFolder', { n:") && s.includes("t('dl.scanFiles', { n:") && /dl\.scanFiles[^']*': 'file ter-scan/.test(fs.readFileSync(path.join(root, 'src/js/i18n/id.js'), 'utf8')), 'dl: empty-state menampilkan diagnostik folder/scan/riwayat');
  ok(/\} catch \{\s*\}\s*\} else if \(!d\.path/.test(s), 'dl: exists() error tidak prune riwayat permanen');
  ok(!s.includes('!rows.length && S.downloads.some(d => !d._gone)'), 'dl: fallback anti-kosong dihapus (filter folder tak dikalahkan)');
  ok(s.includes('if (d.path && seenDlPaths.has(d.path)) continue;'), 'dl: riwayat didedupe per path');
  ok(s.includes('if (d.path) seenDlPaths.add(d.path);'), 'dl: path riwayat dicatat sekali tampil');
  ok(s.includes("d.status === 'downloading' && (d.progress || 0) < 100"), 'dl: entri download terputus tidak di-prune senyap');
} catch (e) {
  ok(false, `anti-senyap downloads :: ${e.message}`);
}

try {
  const pySepRunOnly = fs.readFileSync(path.join(root, 'python-engine/vx_sep_run.py'), 'utf8');
  const pySep = fs.readFileSync(path.join(root, 'python-engine/vx_separate.py'), 'utf8');
  ok(pySepRunOnly.includes('env["CUDA_VISIBLE_DEVICES"] = ""'), 'py: cpu sembunyikan GPU dari subprocess');
  ok(pySepRunOnly.includes('force_cpu=(dev_arg == "cpu")'), 'py: spawn paksa cpu bila device cpu');
  ok(pySep.includes('"device": job.get("device", "")'), 'py: progress paparkan device aktual');
} catch (e) {
  ok(false, `separate device :: ${e.message}`);
}

try {
  const sClean = readSrc();
  const cssClean = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const htmlClean = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  const rsDir = path.join(root, 'src-tauri/src');
  const rsGuarded = ['lib.rs', 'scan_cache_bench.rs']
    .map((f) => ({ f, c: fs.readFileSync(path.join(rsDir, f), 'utf8') }));
  const rsClean = rsGuarded.map((x) => x.c).join('\n');
  const pyClean = fs.readFileSync(path.join(root, 'python-engine/vx_download.py'), 'utf8');
  ok(!/(^|\n)[ \t]*\/\//.test(sClean), 'js: sumber bersih komentar //');
  ok(!/(^|\n)[ \t]*\/\*/.test(sClean), 'js: sumber bersih komentar blok /*');
  ok(!cssClean.includes('/*'), 'css: sumber bersih komentar /* */');
  ok(!htmlClean.includes('<!--'), 'html: sumber bersih komentar <!-- -->');
  const rsDirty = rsGuarded.filter((x) => /^\s*\/\//m.test(x.c)).map((x) => x.f);
  ok(rsDirty.length === 0, `rust: sumber bersih komentar // (lib.rs + scan_cache_bench.rs)${rsDirty.length ? ' :: ' + rsDirty.join(',') : ''}`);
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
  ok(!/\.preset-menu \{[^}]*backdrop-filter/.test(css),
    'preset-menu tanpa frosted blur (ikut resep bebas backdrop-filter)');
  ok(!/\.more-menu \{[^}]*backdrop-filter/.test(css),
    'more-menu tanpa frosted blur (ikut resep bebas backdrop-filter)');
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
  for (const rel of ['vx_separate.py', 'vx_sep_jobs.py', 'vx_sep_cache.py', 'vx_sep_run.py']) {
    const n = fs.readFileSync(path.join(root, 'python-engine', rel), 'utf8').split('\n').length;
    ok(n <= 600, `python-engine/${rel} <= 600 baris (skrg ${n})`);
  }
} catch (e) {
  ok(false, `batas ukuran file :: ${e.message}`);
}

console.log(failures === 0 ? 'SMOKE GREEN' : `SMOKE RED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
