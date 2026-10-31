import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    
    
    
    target: 'es2020',
    minify: 'terser',
    cssMinify: true,
    
    
    sourcemap: false,
    terserOptions: {
      compress: {
        passes: 3,
        
        
        
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
