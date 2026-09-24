import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/mock';
import type { MachineView, ProbeExport, ProbeSummary } from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closedPort, otherWebServer, silentServer, testApp } from './helpers';

const MAC_KEY = 'sk-unsloth-probe-test-mac-0000000000000001';
const LINUX_KEY = 'sk-unsloth-probe-test-linux-000000000000002';

let mac: RunningMock;
let linux: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;

async function control(mock: RunningMock, body: unknown) {
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function add(baseUrl: string, apiKey?: string): Promise<MachineView> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name: 'Machine under test', baseUrl, ...(apiKey ? { apiKey } : {}) },
  });
  return response.json<MachineView>();
}

async function probe(id: string) {
  const response = await ctx.app.inject({ method: 'POST', url: `/api/machines/${id}/probe` });
  expect(response.statusCode).toBe(200);
  return { response, summary: response.json<ProbeSummary>() };
}

const statusesOf = (summary: ProbeSummary) =>
  Object.fromEntries(
    Object.entries(summary.report.capabilities).map(([key, capability]) => [
      key,
      capability.status,
    ]),
  );

beforeAll(async () => {
  mac = await startMockServer({ profile: 'mac-mlx', apiKey: MAC_KEY });
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: LINUX_KEY });
});
afterAll(async () => {
  await mac.close();
  await linux.close();
});
beforeEach(async () => {
  await fetch(`${mac.url}/__mock/reset`, { method: 'POST' });
  await fetch(`${linux.url}/__mock/reset`, { method: 'POST' });
  ctx = await testApp();
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('probing a healthy machine', () => {
  it('finds every capability on the Mac profile', async () => {
    const machine = await add(mac.url, MAC_KEY);
    const { summary } = await probe(machine.id);
    expect(summary.report.overall).toBe('ok');
    expect(Object.values(statusesOf(summary))).toEqual(Array(6).fill('ok'));
    expect(summary.report.platform.backend).toBe('mlx');
    expect(summary.report.rtt.samplesMs).toHaveLength(3);

    const listed = (await ctx.app.inject({ method: 'GET', url: '/api/machines' })).json<
      MachineView[]
    >();
    expect(listed[0]?.lastProbe?.report.overall).toBe('ok');
  });

  it('finds whisper.cpp on the Linux profile', async () => {
    const machine = await add(linux.url, LINUX_KEY);
    const { summary } = await probe(machine.id);
    expect(summary.report.issues).toEqual([]);
    expect(summary.report.gpus[0]?.name).toBe('NVIDIA GeForce RTX 5090');
    expect(summary.report.stt.engines.map((engine) => engine.available)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('sends the key to protected routes and measures round trips without it', async () => {
    const machine = await add(mac.url, MAC_KEY);
    await probe(machine.id);
    const requests = mac.requests();
    expect(requests.filter((r) => r.path !== '/api/health').every((r) => r.auth === 'valid')).toBe(
      true,
    );
    expect(requests.slice(-3).map((r) => [r.path, r.auth])).toEqual(
      Array(3).fill(['/api/health', 'none']),
    );
  });
});

describe('probing a machine with a problem', () => {
  it('reports a wrong key and stops before the protected routes', async () => {
    const machine = await add(mac.url, 'sk-unsloth-this-is-not-the-key-000000000');
    const { summary } = await probe(machine.id);
    expect(statusesOf(summary)).toMatchObject({ reachable: 'ok', key: 'error', text: 'unknown' });
    expect(summary.report.issues[0]?.title).toBe('The API key was rejected.');
    expect(mac.requests().map((r) => r.path)).not.toContain('/v1/models');
  });

  it('reports a key that Unsloth stopped accepting', async () => {
    const machine = await add(linux.url, LINUX_KEY);
    expect((await probe(machine.id)).summary.report.overall).toBe('ok');
    await control(linux, { rejectKey: true });
    const { summary } = await probe(machine.id);
    expect(summary.report.capabilities.key).toEqual({ status: 'error', summary: 'Rejected' });
  });

  it('asks for a key when none is saved', async () => {
    const machine = await add(mac.url);
    const { summary } = await probe(machine.id);
    expect(summary.report.issues[0]?.title).toBe('This machine needs an API key.');
  });

  it('says nothing is listening on a closed port', async () => {
    const port = await closedPort();
    const machine = await add(`127.0.0.1:${port}`, MAC_KEY);
    const { summary } = await probe(machine.id);
    expect(summary.report.capabilities.reachable).toEqual({
      status: 'error',
      summary: 'Nothing listening',
    });
    expect(summary.report.issues[0]?.title).toBe(`Nothing is listening at 127.0.0.1:${port}.`);
  });

  it('gives up on a machine that never answers', async () => {
    const silent = await silentServer();
    try {
      const machine = await add(silent.url, MAC_KEY);
      const started = Date.now();
      const { summary } = await probe(machine.id);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(summary.report.capabilities.reachable).toEqual({
        status: 'error',
        summary: 'No answer',
      });
      expect(summary.report.issues[0]?.title).toMatch(/did not answer in time/);
    } finally {
      await silent.close();
    }
  });

  it('recognises a web server that is not Unsloth', async () => {
    const web = await otherWebServer();
    try {
      const machine = await add(web.url, MAC_KEY);
      const { summary } = await probe(machine.id);
      expect(summary.report.capabilities.reachable).toEqual({
        status: 'error',
        summary: 'Not Unsloth',
      });
    } finally {
      await web.close();
    }
  });

  it('marks what an older Unsloth lacks as missing', async () => {
    await control(mac, {
      routes: {
        '/api/inference/audio/stt/status': { missing: true },
        '/api/inference/images/status': { missing: true },
        '/api/train/hardware': { missing: true },
      },
    });
    const machine = await add(mac.url, MAC_KEY);
    const { summary } = await probe(machine.id);
    expect(statusesOf(summary)).toMatchObject({
      text: 'ok',
      stt: 'missing',
      image: 'missing',
      telemetry: 'missing',
    });
    expect(summary.report.overall).toBe('ok');
  });

  it('keeps probing when one route hangs, and says which one failed', async () => {
    await control(mac, { routes: { '/v1/models': { hang: true } } });
    const machine = await add(mac.url, MAC_KEY);
    const { summary } = await probe(machine.id);
    expect(summary.report.capabilities.text.status).toBe('ok');
    expect(summary.report.issues.map((issue) => issue.title)).toContain(
      'Listing the models failed.',
    );
  });
});

describe('probe results', () => {
  it('drops the last probe when the address or key changes, but not for a new name', async () => {
    const machine = await add(mac.url, MAC_KEY);
    await probe(machine.id);
    const edit = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/machines/${machine.id}`,
        payload: { name: 'N', baseUrl: mac.url, ...payload },
      });
    expect((await edit({ name: 'New name' })).json<MachineView>().lastProbe).not.toBeNull();
    expect(
      (await edit({ apiKey: 'sk-unsloth-another-key-000000000000000' })).json<MachineView>()
        .lastProbe,
    ).toBeNull();
  });

  it('exports the probe as a named file', async () => {
    const machine = await add(linux.url, LINUX_KEY);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/machines/${machine.id}/probe/export` }))
        .statusCode,
    ).toBe(404);
    await probe(machine.id);
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/machines/${machine.id}/probe/export`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="probe-machine-under-test-\d{8}-\d{4}\.json"$/,
    );
    const file = response.json<ProbeExport>();
    expect(file).toMatchObject({
      kind: 'model-duel-probe',
      schemaVersion: 1,
      machine: { keyConfigured: true },
    });
    expect(Object.keys(file.raw.routes)).toHaveLength(9);
  });

  it('never lets the key reach a response, a stored probe, an export or a log line', async () => {
    // Even when Unsloth itself echoes the key back.
    await control(mac, { routes: { '/v1/props': { body: { note: `debug ${MAC_KEY}` } } } });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Leak test', baseUrl: mac.url, apiKey: MAC_KEY },
    });
    const { id } = created.json<MachineView>();
    const responses = [
      created,
      (await probe(id)).response,
      await ctx.app.inject({ method: 'GET', url: '/api/machines' }),
      await ctx.app.inject({ method: 'GET', url: `/api/machines/${id}` }),
      await ctx.app.inject({ method: 'GET', url: `/api/machines/${id}/probe` }),
      await ctx.app.inject({ method: 'GET', url: `/api/machines/${id}/probe/export` }),
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/machines/${id}`,
        payload: { name: 'Leak test 2', baseUrl: mac.url },
      }),
    ];
    for (const response of responses) expect(response.body).not.toContain(MAC_KEY);

    const stored = await readFile(path.join(ctx.dataDir, 'probes', `${id}.json`), 'utf8');
    expect(stored).not.toContain(MAC_KEY);
    expect(stored).toContain('debug sk-unsloth-…0001');

    const logs = ctx.logs.text();
    expect(logs).toContain('machine probed');
    expect(logs).not.toContain(MAC_KEY);
  });
});
