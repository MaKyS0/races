import { defineConfig } from 'vite';

export default defineConfig({
  base: './',               // relative paths so the same build works in a browser, Capacitor (file/https scheme) and GitHub Pages
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 1200, assetsInlineLimit: 0 },
  server: { host: true, port: 5173 },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
