import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // `esnext` membiarkan Vite meneruskan apa adanya tanpa transformasi, jadi
    // struktur dan nama di bundle tetap persis seperti source. `es2020` memaksa
    // transformasi sehingga tidak ada yang lolos apa adanya.
    target: 'es2020',
    minify: 'terser',
    cssMinify: true,
    // Source map frontend hanya Fassung ke-syntaks TS dan berguna saat debug,
    // tapi di rilis justru memberi peta lengkap modul + nama fungsi asli.
    sourcemap: false,
    terserOptions: {
      compress: {
        passes: 3,
        // Buang log/debug/info saja. `warn`/`error` sengaja ditahan:
        // `downloads.js` menangkap error render yang tidak muncul di UI, jadi
        // kalau ikut dibuang, produksi jadi tanpa jejak sama sekali.
        drop_console: ['log', 'debug', 'info'],
        drop_debugger: true,
      },
      mangle: true,
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, '')
      }
    }
  },
  clearScreen: false
});
