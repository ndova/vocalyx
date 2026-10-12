import { isTauri } from './tauri.js';

const TOKEN_HEADER = 'X-VX-Token';
const ENG_RE = /^http:\/\/127\.0\.0\.1:8001\//;
let _tokPromise = null;
let _installed = false;

export async function engineToken(force) {  // token dibaca lewat command Rust (`engine_token`), bukan `readTextFile`: versi lama memakai `appDataDir()` (`identifier` com.vocalyx.app) sementara engine menulis ke `%APPDATA%\VocaLyx\engine-token`, jadi dua path berbeda, `readTextFile` gagal, header X-VX-Token tidak pernah terkirim, dan semua endpoint selain /health + /peaks membalas 401; Rust sudah tahu path-nya sendiri sehingga tak ada tebakan path di frontend dan `fs:scope` tidak perlu dilebarkan
  if (!_tokPromise || force) {
    _tokPromise = (async () => {
      if (!isTauri()) return null;
      try {
        const { invokeTauri } = await import('./tauri.js');
        const t = await invokeTauri('engine_token');
        return typeof t === 'string' && t.trim() ? t.trim() : null;
      } catch (e) {
        return null;
      }
    })();
    _tokPromise = _tokPromise.then((t) => {  // `null` berarti file token belum ada - engine baru menulisnya MENJELANG start, dan app bisa saja memanggil endpoint duluan; hasil kosong TIDAK boleh di-cache karena frontend terkunci tanpa token sampai app ditutup: request berikutnya selalu 401 dan retry di bawah tidak pernah menyala (karena `t2 !== t` sama-sama null)
      if (!t) _tokPromise = null;
      return t;
    });
  }
  return _tokPromise;
}

function isEngineUrl(u) {
  return typeof u === 'string' && (ENG_RE.test(u) || u.indexOf('/api/') === 0);
}

export function installEngineAuth() {
  if (_installed || typeof window === 'undefined' || !window.fetch) return;
  _installed = true;
  const rawFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isEngineUrl(url)) return rawFetch(input, init);
    return (async () => {
      const t = await engineToken();
      const headers = new Headers(
        init.headers || (typeof input !== 'string' && input.headers) || undefined);
      if (t && !headers.has(TOKEN_HEADER)) headers.set(TOKEN_HEADER, t);
      let res = await rawFetch(input, Object.assign({}, init, { headers }));
      if (res.status === 401 && typeof input === 'string') {  // paksa baca ulang token; syaratnya "token lama kosong ATAU berbeda", bukan hanya "harus berbeda": kalau `t` sudah `null` (engine belum menulis file token saat app start) dan `t2` masih `null` karena engine baru saja selesai start, logika lama tidak mencoba apa pun dan request ini berakhir sebagai 401
        const t2 = await engineToken(true);
        if (t2 && t2 !== t) {
          const h2 = new Headers(init.headers || undefined);
          h2.set(TOKEN_HEADER, t2);
          try {
            res = await rawFetch(input, Object.assign({}, init, { headers: h2 }));
          } catch (e) {}
        }
      }
      return res;
    })();
  };
}
