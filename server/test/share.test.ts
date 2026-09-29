import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { startMockServer, type RunningMock } from '@duel/test-servers';
import { startShareMock, verifyEnvelope, type RunningShareMock } from '@duel/test-servers/share';
import {
  SHARE_SERVICE_ENDPOINT,
  SHORT_PROMPT,
  type MachineView,
  type SessionView,
  type ShareRecord,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ShareSettingsView } from '../src/share';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-share-linux-0000000000000001';
/** The stand-in service asks for a token, as LLM Bench does. */
const TOKEN = 'llmb_share-test-token-000000000001';
let linux: RunningMock;
let service: RunningShareMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;
/** A race with the sender's own prompt, which never leaves, and one with a standard prompt. */
let session: SessionView;
let standard: SessionView;

const settings = async () =>
  (await ctx.app.inject({ method: 'GET', url: '/api/share/settings' })).json<ShareSettingsView>();
const setToken = (token: unknown) =>
  ctx.app.inject({ method: 'PUT', url: '/api/share/settings', payload: { token } });
const preview = (race: SessionView = session) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/share/preview',
    payload: { sessionId: race.id, machineId: linuxId },
  });
async function send(race: SessionView = standard) {
  const shown = (await preview(race)).json<{ sha256: string }>();
  return ctx.app.inject({
    method: 'POST',
    url: '/api/share/send',
    payload: { sessionId: race.id, machineId: linuxId, sha256: shown.sha256 },
  });
}
async function raceWith(config: Record<string, unknown>): Promise<SessionView> {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      workload: 'text',
      machineIds: [linuxId],
      config: { maxTokens: 256, thinking: false, reasoningEffort: null, ...config },
      plan: { rounds: 2, warmup: false, settleMs: 0, sequencing: 'concurrent' },
    },
  });
  const id = started.json<SessionView>().id;
  let race = started.json<SessionView>();
  for (let i = 0; i < 400; i += 1) {
    race = (await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json();
    if (race.finishedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return race;
}

const control = (body: unknown) =>
  fetch(`${service.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
  service = await startShareMock({ token: TOKEN });
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
  ctx = await testApp({
    shareTimeouts: { connectMs: 1000, totalMs: 3000 },
    shareEndpoint: service.endpoint,
  });
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
  session = await raceWith({ prompt: 'My private medical question about /home/mani/notes.txt' });
  standard = await raceWith({ preset: 'short' });
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('share settings', () => {
  it('makes a signing key that stays on this computer, and sends to LLM Bench', async () => {
    const view = await settings();
    expect(view).toMatchObject({ endpoint: service.endpoint, hasToken: false, sent: {} });
    expect(view.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(view.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const file = path.join(ctx.dataDir, 'share.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('PRIVATE KEY');
    expect(JSON.stringify(view)).not.toContain('PRIVATE');
    // Only the tests point it anywhere else.
    const plain = await testApp();
    const shown = await plain.app.inject({ method: 'GET', url: '/api/share/settings' });
    expect(shown.json<ShareSettingsView>().endpoint).toBe(SHARE_SERVICE_ENDPOINT);
    await plain.app.close();
    await rm(plain.dataDir, { recursive: true, force: true });
  });

  it('takes a token and nothing else, and keeps it hidden', async () => {
    const saved = await setToken(TOKEN);
    expect(saved.statusCode).toBe(200);
    expect(saved.json<ShareSettingsView>()).toMatchObject({ hasToken: true, tokenMasked: '…0001' });
    expect(saved.body).not.toContain(TOKEN);
    for (const payload of [
      { endpoint: 'https://results.example.com/api/runs' },
      { endpoint: 'https://results.example.com/api/runs', token: TOKEN },
      { token: '' },
    ]) {
      const refused = await ctx.app.inject({ method: 'PUT', url: '/api/share/settings', payload });
      expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await setToken(null)).json<ShareSettingsView>().hasToken).toBe(false);
  });

  it('drops a token an earlier version saved for another service', async () => {
    const file = path.join(ctx.dataDir, 'share.json');
    const reopen = async (change: Record<string, unknown>) => {
      const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...saved, ...change }));
      await ctx.app.close();
      ctx = await testApp({ dataDir: ctx.dataDir, shareEndpoint: service.endpoint });
      return settings();
    };
    const kept = await reopen({ endpoint: null, token: TOKEN });
    expect(kept.hasToken).toBe(true);
    const dropped = await reopen({ endpoint: 'https://other.example/api/runs', token: 'theirs' });
    expect(dropped.hasToken).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ endpoint: null, token: null });
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

  it('names a standard prompt with its text, and the sender’s own as not standard', async () => {
    type Preview = { record: ShareRecord; notStandard: string | null };
    const own = (await preview()).json<Preview>();
    expect(own.record.settings).toMatchObject({ prompt: 'custom', promptText: null });
    expect(own.notStandard).toMatch(/standard prompt only/);
    const shared = (await preview(standard)).json<Preview>();
    expect(shared.notStandard).toBeNull();
    expect(shared.record.settings).toMatchObject({ prompt: 'short', promptText: SHORT_PROMPT });
  });

  it('never carries a name or the prompt, however it is asked', async () => {
    const asked = await ctx.app.inject({
      method: 'POST',
      url: '/api/share/preview',
      payload: {
        sessionId: session.id,
        machineId: linuxId,
        options: { includePrompt: true, displayName: 'Mani' },
      },
    });
    expect(asked.statusCode).toBe(400);
  });

  it('has nothing to send for a machine without a finished round', async () => {
    const answer = await ctx.app.inject({
      method: 'POST',
      url: '/api/share/preview',
      payload: { sessionId: session.id, machineId: 'someone-else' },
    });
    expect(answer.statusCode).toBe(400);
  });
});

describe('sending', () => {
  it('signs the record, sends it, and remembers where it went', async () => {
    // Without a token nothing is sent: refused here, before anything leaves this computer.
    const noToken = await send();
    expect(noToken.statusCode).toBe(409);
    expect(noToken.json<{ error: string }>().error).toBe('no_token');
    expect(service.received()).toHaveLength(0);
    await setToken(TOKEN);
    const sent = await send();
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ status: 201, host: new URL(service.url).host });
    const [envelope] = service.received();
    expect(envelope).toBeDefined();
    expect(verifyEnvelope(envelope!)).toBeNull();
    expect(envelope?.signature.publicKey).toBe((await settings()).publicKey);
    expect(sent.json<{ url: string }>().url).toMatch(new RegExp(`^${service.url}/runs/`));

    const key = `${standard.id}/${linuxId}`;
    expect((await settings()).sent[key]?.host).toBe(new URL(service.url).host);
    // Sending again replaces the same record.
    expect((await send()).json()).toMatchObject({ status: 200 });
    expect(service.received()).toHaveLength(1);
  });

  it('refuses a race with the sender’s own prompt', async () => {
    await setToken(TOKEN);
    const refused = await send(session);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe('not_standard');
    expect(service.received()).toHaveLength(0);
  });

  it('sends only what was previewed', async () => {
    await setToken(TOKEN);
    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/api/share/send',
      payload: { sessionId: standard.id, machineId: linuxId, sha256: 'f'.repeat(64) },
    });
    expect(changed.statusCode).toBe(409);
    expect(service.received()).toHaveLength(0);
  });

  it('reports refusals and redirects, and drops links to other hosts', async () => {
    await setToken(TOKEN);
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

  it('sends the token, and reports one the service refuses', async () => {
    await setToken('llmb_not-the-right-token-0000000000');
    expect((await send()).json<{ message: string }>().message).toMatch(/HTTP 401/);
    await setToken(TOKEN);
    expect((await send()).statusCode).toBe(200);
    expect(service.received()).toHaveLength(1);
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
