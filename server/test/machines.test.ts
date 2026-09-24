import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MachineView } from '@duel/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { tempDir, testApp } from './helpers';

const KEY = 'sk-unsloth-registry-test-0000000000000001';
let ctx: Awaited<ReturnType<typeof testApp>>;

beforeEach(async () => {
  ctx = await testApp();
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

async function add(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/api/machines', payload });
}

describe('machine registry', () => {
  it('adds a machine with a normalised address and a masked key', async () => {
    const response = await add({ name: 'M3 Ultra', baseUrl: ' 192.168.1.20 ', apiKey: KEY });
    expect(response.statusCode).toBe(201);
    const machine = response.json<MachineView>();
    expect(machine).toMatchObject({
      name: 'M3 Ultra',
      baseUrl: 'http://192.168.1.20:8888',
      hasApiKey: true,
      apiKeyMasked: 'sk-unsloth-…0001',
      notes: '',
      color: '#e8a33d',
      lastProbe: null,
    });
    expect(response.body).not.toContain(KEY);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/machines' });
    expect(list.json<MachineView[]>()).toHaveLength(1);
    expect(list.body).not.toContain(KEY);
  });

  it('stores the key only in machines.json, readable by its owner alone', async () => {
    await add({ name: 'M3 Ultra', baseUrl: '192.168.1.20', apiKey: KEY });
    const file = path.join(ctx.dataDir, 'machines.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number };
    expect(saved.schemaVersion).toBe(1);
    expect(JSON.stringify(saved)).toContain(KEY);
  });

  it('gives the next machine the next colour', async () => {
    await add({ name: 'A', baseUrl: '10.0.0.1' });
    const second = (await add({ name: 'B', baseUrl: '10.0.0.2' })).json<MachineView>();
    expect(second.color).toBe('#c6dbe0');
    expect(second.hasApiKey).toBe(false);
    expect(second.apiKeyMasked).toBeNull();
  });

  it('explains what is wrong with the input, field by field', async () => {
    const missing = await add({ name: ' ', baseUrl: '' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: 'validation',
      fields: { name: 'Give the machine a name.', baseUrl: 'Enter the machine address.' },
    });
    const badUrl = await add({ name: 'X', baseUrl: 'ftp://host' });
    expect(badUrl.json()).toMatchObject({
      fields: { baseUrl: 'Use an http:// or https:// address.' },
    });
    const badColor = await add({ name: 'X', baseUrl: 'host', color: 'red' });
    expect(badColor.json()).toMatchObject({ fields: { color: 'Pick one of the colours.' } });
    const notJson = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(notJson.statusCode).toBe(400);
  });

  it('keeps the key on edit when the field is empty, replaces it, or removes it', async () => {
    const { id } = (await add({ name: 'A', baseUrl: '10.0.0.1', apiKey: KEY })).json<MachineView>();
    const edit = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/machines/${id}`,
        payload: { name: 'A', baseUrl: '10.0.0.1', ...payload },
      });

    expect((await edit({ apiKey: '' })).json()).toMatchObject({ apiKeyMasked: 'sk-unsloth-…0001' });
    expect((await edit({})).json()).toMatchObject({ apiKeyMasked: 'sk-unsloth-…0001' });
    const replaced = await edit({ apiKey: 'sk-unsloth-registry-test-0000000000000002' });
    expect(replaced.json()).toMatchObject({ apiKeyMasked: 'sk-unsloth-…0002' });
    const removed = await edit({ apiKey: null, name: 'Renamed' });
    expect(removed.json()).toMatchObject({ name: 'Renamed', hasApiKey: false, apiKeyMasked: null });
  });

  it('deletes a machine', async () => {
    const { id } = (await add({ name: 'A', baseUrl: '10.0.0.1' })).json<MachineView>();
    expect(
      (await ctx.app.inject({ method: 'DELETE', url: `/api/machines/${id}` })).statusCode,
    ).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/machines/${id}` })).statusCode).toBe(
      404,
    );
    expect(
      (await ctx.app.inject({ method: 'DELETE', url: `/api/machines/${id}` })).statusCode,
    ).toBe(404);
  });

  it('answers 404 for ids it does not know, including path tricks', async () => {
    for (const url of [
      '/api/machines/nope',
      '/api/machines/..%2F..%2Fetc',
      '/api/machines/x/probe/export',
    ]) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/machines/nope/probe' })).statusCode,
    ).toBe(404);
  });

  it('keeps machines across restarts', async () => {
    await add({ name: 'Kept', baseUrl: '10.0.0.9', apiKey: KEY });
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/machines' })).json<
      MachineView[]
    >();
    expect(list.map((m) => [m.name, m.apiKeyMasked])).toEqual([['Kept', 'sk-unsloth-…0001']]);
  });
});

describe('the data folder on startup', () => {
  it('tightens the permissions of an existing machines file', async () => {
    const dataDir = await tempDir();
    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, 'machines.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, machines: [] }));
    await chmod(file, 0o644);
    const app = await buildApp({ dataDir });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses to start on a damaged or newer machines file instead of overwriting it', async () => {
    const dataDir = await tempDir();
    const file = path.join(dataDir, 'machines.json');
    await writeFile(file, '{not json');
    await expect(buildApp({ dataDir })).rejects.toThrow(/not valid JSON/);
    await writeFile(file, JSON.stringify({ schemaVersion: 99, machines: [] }));
    await expect(buildApp({ dataDir })).rejects.toThrow(/newer version/);
    expect(await readFile(file, 'utf8')).toContain('99');
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe('host names the app answers to', () => {
  it('refuses a request addressed to an unknown name, which blocks DNS rebinding', async () => {
    const rebound = await ctx.app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: { host: 'evil.example:3000' },
    });
    expect(rebound.statusCode).toBe(403);
    expect(rebound.json()).toMatchObject({ error: 'forbidden_host' });
    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: { host: 'evil.example:3000' },
      payload: { name: 'X', baseUrl: 'evil.example' },
    });
    expect(write.statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/machines' })).json()).toEqual([]);
  });

  it('answers localhost, IP addresses, and names allowed at startup', async () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '192.168.1.5:3000']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/machines',
        headers: { host },
      });
      expect(response.statusCode, host).toBe(200);
    }
    const dataDir = await tempDir();
    const app = await buildApp({ dataDir, allowedHosts: ['duel.lan'] });
    expect(
      (await app.inject({ url: '/api/health', headers: { host: 'duel.lan:3000' } })).statusCode,
    ).toBe(200);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});
