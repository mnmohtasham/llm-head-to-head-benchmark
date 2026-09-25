import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { startMockServer, type RunningMock } from '@duel/mock';
import { startShareMock, verifyEnvelope, type RunningShareMock } from '@duel/mock/share';
import type { MachineView, SessionView, ShareRecord } from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ShareSettingsView } from '../src/share';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-share-linux-0000000000000001';
let linux: RunningMock;
let service: RunningShareMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;
let session: SessionView;

const settings = async () =>
  (await ctx.app.inject({ method: 'GET', url: '/api/share/settings' })).json<ShareSettingsView>();
const setEndpoint = (endpoint: string | null, token?: string | null) =>
  ctx.app.inject({
    method: 'PUT',
    url: '/api/share/settings',
    payload: token === undefined ? { endpoint } : { endpoint, token },
  });
const preview = (options: Record<string, unknown> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/share/preview',
    payload: { sessionId: session.id, machineId: linuxId, options },
  });
async function send(options: Record<string, unknown> = {}) {
  const shown = (await preview(options)).json<{ sha256: string }>();
  return ctx.app.inject({
    method: 'POST',
    url: '/api/share/send',
    payload: { sessionId: session.id, machineId: linuxId, options, sha256: shown.sha256 },
  });
}
const control = (body: unknown) =>
  fetch(`${service.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
  service = await startShareMock();
});
afterAll(async () => {
  await Promise.all([linux.close(), service.close()]);
});
beforeEach(async () => {
  await fetch(`${linux.url}/__mock/reset`, { method: 'POST' });
  await fetch(`${service.url}/__mock/reset`, { method: 'POST' });
  await fetch(`${linux.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: { startupMs: 30, tokenMs: 3, jitterMs: 0, answerTokens: 15 } }),
  });
  ctx = await testApp({ shareTimeouts: { connectMs: 1000, totalMs: 3000 } });
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: {
      name: "Mani's secret lab",
      baseUrl: linux.url,
      apiKey: KEY,
      notes: 'Rack 4, 192.168.99.150',
    },
  });
  linuxId = created.json<MachineView>().id;
  await ctx.app.inject({ method: 'POST', url: `/api/machines/${linuxId}/probe`, payload: {} });
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      workload: 'text',
      machineIds: [linuxId],
      config: {
        prompt: 'My private medical question about /home/mani/notes.txt',
        maxTokens: 256,
        thinking: false,
        reasoningEffort: null,
      },
      plan: { rounds: 2, warmup: false, settleMs: 0, sequencing: 'concurrent' },
    },
  });
  const id = started.json<SessionView>().id;
  for (let i = 0; i < 400; i += 1) {
    session = (await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    if (session.finishedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('share settings', () => {
  it('makes a signing key that stays on this computer', async () => {
    const view = await settings();
    expect(view).toMatchObject({ endpoint: null, hasToken: false, sent: {} });
    expect(view.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(view.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const file = path.join(ctx.dataDir, 'share.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('PRIVATE KEY');
    expect(JSON.stringify(view)).not.toContain('PRIVATE');
  });

  it('takes https, or http to this computer only, and keeps the token hidden', async () => {
    for (const bad of [
      'http://results.example.com/api/runs',
      'ftp://results.example.com/',
      'https://user:pass@results.example.com/api/runs',
      'https://results.example.com/api/runs#x',
      'results.example.com',
    ]) {
      expect((await setEndpoint(bad)).statusCode, bad).toBe(400);
    }
    const ok = await setEndpoint('https://results.example.com/api/runs', 'share-token-1234567890');
    expect(ok.statusCode).toBe(200);
    expect(ok.json<ShareSettingsView>()).toMatchObject({
      endpoint: 'https://results.example.com/api/runs',
      hasToken: true,
      tokenMasked: '…7890',
    });
    expect(ok.body).not.toContain('share-token-1234567890');
    // A new address does not inherit the token, and no address means no token.
    const moved = await setEndpoint('https://other.example.com/api/runs');
    expect(moved.json<ShareSettingsView>().hasToken).toBe(false);
    await setEndpoint('https://other.example.com/api/runs', 'share-token-1234567890');
    expect((await setEndpoint(null)).json<ShareSettingsView>()).toMatchObject({
      endpoint: null,
      hasToken: false,
    });
    expect((await setEndpoint(service.endpoint)).statusCode).toBe(200);
  });
});

describe('the record', () => {
  it('holds the run and nothing that points at a person or a network', async () => {
    const answer = await preview();
    expect(answer.statusCode, answer.body).toBe(200);
    const { record } = answer.json<{ record: ShareRecord }>();
    expect(record).toMatchObject({
      format: 'model-duel-run',
      formatVersion: 1,
      raceId: session.id,
      displayName: null,
      race: { kind: 'text', state: 'done', rounds: 2, roundsDone: 2, machines: 1 },
      machine: { kind: 'local', platform: 'CUDA', os: 'Linux 6.17' },
      model: { id: 'unsloth/Qwen3.8-27B-GGUF', quant: 'Q4_K_M' },
      settings: { prompt: 'custom', promptText: null },
    });
    expect(record.machine.gpus[0]?.name).toBe('NVIDIA GeForce RTX 5090');
    const decode = record.metrics.find((m) => m.key === 'decode');
    expect(decode?.values).toHaveLength(2);
    const text = answer.body;
    for (const secret of [
      KEY,
      "Mani's secret lab",
      'Rack 4',
      '192.168.99.150',
      linux.url,
      'private medical',
      '/home/mani',
    ]) {
      expect(text).not.toContain(secret);
    }
    const answerText = session.rounds[0]?.runs[0]?.answer.trim().slice(0, 20) ?? 'none';
    expect(text).not.toContain(answerText);
  });

  it('adds the prompt and a display name only when asked, as plain text', async () => {
    const { record } = (
      await preview({
        includePrompt: true,
        displayName: '  Mani\u202e RTX\u0007 box https://evil.example/x  ',
      })
    ).json<{ record: ShareRecord }>();
    expect(record.settings.promptText).toBe('My private medical question about ~/notes.txt');
    expect(record.displayName).toBe('Mani RTX box <address>');
  });

  it('has nothing to send for a machine without a finished round', async () => {
    const answer = await ctx.app.inject({
      method: 'POST',
      url: '/api/share/preview',
      payload: { sessionId: session.id, machineId: 'someone-else', options: {} },
    });
    expect(answer.statusCode).toBe(400);
  });
});

describe('sending', () => {
  it('signs the record, sends it, and remembers where it went', async () => {
    expect((await send()).statusCode).toBe(409);
    await setEndpoint(service.endpoint);
    const sent = await send();
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ status: 201, host: new URL(service.url).host });
    const [envelope] = service.received();
    expect(envelope).toBeDefined();
    expect(verifyEnvelope(envelope!)).toBeNull();
    expect(envelope?.signature.publicKey).toBe((await settings()).publicKey);
    expect(sent.json<{ url: string }>().url).toMatch(new RegExp(`^${service.url}/runs/`));

    const key = `${session.id}/${linuxId}`;
    expect((await settings()).sent[key]?.host).toBe(new URL(service.url).host);
    // Sending again replaces the same record.
    expect((await send()).json()).toMatchObject({ status: 200 });
    expect(service.received()).toHaveLength(1);
  });

  it('sends only what was previewed', async () => {
    await setEndpoint(service.endpoint);
    const shown = (await preview()).json<{ sha256: string }>();
    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/api/share/send',
      payload: {
        sessionId: session.id,
        machineId: linuxId,
        options: { includePrompt: true },
        sha256: shown.sha256,
      },
    });
    expect(changed.statusCode).toBe(409);
    expect(service.received()).toHaveLength(0);
  });

  it('reports refusals and redirects, and drops links to other hosts', async () => {
    await setEndpoint(service.endpoint);
    await control({ failWith: 503 });
    const refused = await send();
    expect(refused.statusCode).toBe(502);
    expect(refused.json<{ message: string }>().message).toBe(
      'The service answered HTTP 503: The mock was told to fail.',
    );

    await control({ failWith: null, redirectTo: 'https://elsewhere.example/api/runs' });
    const redirected = await send();
    expect(redirected.json<{ message: string }>().message).toMatch(/redirect/);

    await control({ redirectTo: null, foreignLink: true });
    const foreign = await send();
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json<{ url: string | null }>().url).toBeNull();
  });

  it('sends the token to a service that needs one', async () => {
    const guarded = await startShareMock({ token: 'service-token-000000000001' });
    try {
      await setEndpoint(guarded.endpoint);
      expect((await send()).json<{ message: string }>().message).toMatch(/HTTP 401/);
      await setEndpoint(guarded.endpoint, 'service-token-000000000001');
      expect((await send()).statusCode).toBe(200);
      expect(guarded.received()).toHaveLength(1);
    } finally {
      await guarded.close();
    }
  });
});

describe('requests from other web sites', () => {
  it('are refused when they would change something', async () => {
    const attempt = (headers: Record<string, string>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/share/send',
        headers: { host: '127.0.0.1:3000', ...headers },
        payload: {},
      });
    expect((await attempt({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await attempt({ origin: 'null' })).statusCode).toBe(403);
    expect((await attempt({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await attempt({ origin: 'http://localhost:8080' })).statusCode).toBe(403);
    // The page itself, and tools outside a browser, get through to the checks.
    expect((await attempt({ origin: 'http://127.0.0.1:3000' })).statusCode).toBe(400);
    expect((await attempt({})).statusCode).toBe(400);
    // Reading stays open, as before.
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/share/settings',
      headers: { origin: 'https://evil.example' },
    });
    expect(read.statusCode).toBe(200);
  });
});
