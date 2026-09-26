import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// Every build gets an id, compiled into the page and saved as build.json next to it. The server
// reports the id it found at startup, so a page can tell when the server is older than it is.
const buildId = new Date().toISOString();

function buildInfo(): Plugin {
  return {
    name: 'model-duel-build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build.json',
        source: `${JSON.stringify({ buildId })}\n`,
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), buildInfo()],
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  server: {
    port: 3000,
    strictPort: true,
    // Pass the page's own Host header through. Vite's shorthand ('/api': 'http://…') sets
    // changeOrigin, which rewrites Host to 127.0.0.1:3001; the API then sees a page on
    // localhost:3000 asking a different host and refuses every change as cross-site.
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
