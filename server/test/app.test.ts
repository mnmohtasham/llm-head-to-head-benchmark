import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { tempDir, testApp } from './helpers';

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function appWithClient(files: Record<string, string>) {
  const dataDir = await tempDir();
  const clientDir = await tempDir();
  cleanup.push(dataDir, clientDir);
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(clientDir, name), text);
  }
  return buildApp({ dataDir, clientDir, mode: 'production' });
}

describe('health', () => {
  it('reports the id of the page build found at startup, so a page can spot an old server', async () => {
    const app = await appWithClient({
      'index.html': '<!doctype html><title>Model Duel</title>',
      'build.json': '{"buildId":"2026-09-25T01:00:00.000Z"}\n',
    });
    // A rebuild while the server runs must not change what it reports.
    await writeFile(
      path.join(cleanup[1] ?? '', 'build.json'),
      '{"buildId":"2026-09-25T02:00:00.000Z"}\n',
    );
    const health = (await app.inject({ url: '/api/health' })).json();
    expect(health).toMatchObject({
      ok: true,
      mode: 'production',
      build: '2026-09-25T01:00:00.000Z',
    });
    await app.close();
  });

  it('reports no build when there is no build.json or no page at all', async () => {
    const app = await appWithClient({ 'index.html': '<!doctype html>' });
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({ build: null });
    await app.close();
    const apiOnly = await testApp();
    cleanup.push(apiOnly.dataDir);
    expect((await apiOnly.app.inject({ url: '/api/health' })).json()).toMatchObject({
      build: null,
    });
    await apiOnly.app.close();
  });
});

describe('unknown routes', () => {
  it('names an API route the server does not have, and serves the page for other paths', async () => {
    const app = await appWithClient({ 'index.html': '<!doctype html><title>Model Duel</title>' });
    const missing = await app.inject({ url: '/api/machines/abc/nothing?refresh=1' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: 'no_route',
      message: 'This Model Duel server has no GET /api/machines/abc/nothing.',
    });
    const page = await app.inject({ url: '/anything/else' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Model Duel</title>');
    await app.close();
  });
});
