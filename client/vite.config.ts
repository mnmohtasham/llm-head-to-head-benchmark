import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
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

// Brotli and gzip copies of the text files, which the server sends to browsers that take them.
const compressible = /\.(js|css|html|svg|json)$/;
function precompress(): Plugin {
  const brotli = promisify(brotliCompress);
  const zip = promisify(gzip);
  return {
    name: 'model-duel-precompress',
    apply: 'build',
    async writeBundle(options) {
      const dir = options.dir ?? path.join(root, 'dist');
      const files = (await readdir(dir, { recursive: true })).filter((f) => compressible.test(f));
      await Promise.all(
        files.map(async (file) => {
          const full = path.join(dir, file);
          const data = await readFile(full);
          if (data.length < 1024) return;
          await writeFile(
            `${full}.br`,
            await brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
          );
          await writeFile(`${full}.gz`, await zip(data, { level: 9 }));
        }),
      );
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), buildInfo(), precompress()],
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
    // Maps for debugging, without the comment that makes every browser fetch them.
    sourcemap: 'hidden',
  },
});
