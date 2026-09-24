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
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
