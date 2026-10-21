import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SECURITY_HEADERS } from '../src/headers';
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
    await mkdir(path.dirname(path.join(clientDir, name)), { recursive: true });
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

describe('security headers', () => {
  it('come with the page and with every answer, and the API is never cached', async () => {
    const app = await appWithClient({ 'index.html': '<!doctype html><title>Model Duel</title>' });
    for (const url of ['/', '/api/health', '/api/machines', '/api/no-such-route']) {
      const response = await app.inject({ url });
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers[name], `${url} ${name}`).toBe(value);
      }
    }
    expect((await app.inject({ url: '/api/machines' })).headers['cache-control']).toBe('no-store');
    expect(SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['content-security-policy']).not.toContain('unsafe');
    await app.close();
  });
});

describe('caching and compression', () => {
  it('keeps bundles for good, checks the page each time, and lets routes set their own', async () => {
    const app = await appWithClient({
      'index.html': '<!doctype html><title>Model Duel</title>',
      'assets/index-abc123.js': 'console.log(1);',
    });
    expect((await app.inject({ url: '/assets/index-abc123.js' })).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect((await app.inject({ url: '/' })).headers['cache-control']).toBe('no-cache');
    expect((await app.inject({ url: '/api/audio/clip.wav' })).headers['cache-control']).toBe(
      'public, max-age=86400',
    );
    await app.close();
  });

  it('gzips large JSON answers for browsers that take it', async () => {
    const app = await appWithClient({ 'index.html': '<!doctype html>' });
    for (let i = 0; i < 70; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/machines',
        payload: { name: `Machine ${i}`, baseUrl: `10.0.0.${i + 1}`, notes: 'x'.repeat(200) },
      });
    }
    const plain = await app.inject({ url: '/api/machines' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.length).toBeGreaterThan(16 * 1024);
    const zipped = await app.inject({
      url: '/api/machines',
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.rawPayload.length).toBeLessThan(plain.body.length / 3);
    expect(JSON.parse(gunzipSync(zipped.rawPayload).toString('utf8'))).toHaveLength(70);
    await app.close();
  });
});
