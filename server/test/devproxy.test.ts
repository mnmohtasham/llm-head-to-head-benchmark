import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile, type ProxyOptions } from 'vite';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const CONFIG = fileURLToPath(new URL('../../client/vite.config.ts', import.meta.url));

describe('the development server', () => {
  // `npm run dev` serves the page from Vite and forwards /api to the app. If the forward
  // rewrites the Host header, the app sees a page asking another host and refuses every change.
  it(
    'forwards the page’s requests so the app accepts them, and still refuses other sites',
    { timeout: 30_000 },
    async () => {
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, CONFIG);
      const api = loaded?.config.server?.proxy?.['/api'];
      expect(typeof api, 'the /api proxy must be an object, not the shorthand').toBe('object');

      const ctx = await testApp();
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const target = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
      const vite = await createServer({
        configFile: false,
        root: loaded?.config.root,
        logLevel: 'silent',
        server: {
          host: '127.0.0.1',
          port: 0,
          strictPort: false,
          proxy: { '/api': { ...(api as ProxyOptions), target } },
        },
      });
      try {
        await vite.listen();
        const page = `http://127.0.0.1:${(vite.httpServer?.address() as AddressInfo).port}`;
        const post = (origin: string) =>
          fetch(`${page}/api/preflight`, {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'sec-fetch-site': 'same-origin',
            },
            body: '{}',
          });
        // Reaches the app's own checks: an empty request is a validation error, not a refusal.
        expect((await post(page)).status).toBe(400);
        expect((await post('https://evil.example')).status).toBe(403);
      } finally {
        await vite.close();
        await ctx.app.close();
        await rm(ctx.dataDir, { recursive: true, force: true });
      }
    },
  );
});
