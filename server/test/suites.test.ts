import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/test-servers';
import {
  PUZZLE_PROMPT,
  SHORT_PROMPT,
  suiteCsv,
  type MachineView,
  type RunPlan,
  type SessionSummary,
  type SessionView,
  type Suite,
  type SuiteSummary,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SUITE_RUNNING } from '../src/races';
import { tempDir, testApp } from './helpers';

const LINUX_KEY = 'sk-unsloth-suite-linux-0000000000000001';
const MAC_KEY = 'sk-unsloth-suite-mac-00000000000000002';
let linux: RunningMock;
let mac: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;
let macId: string;

const FAST = { startupMs: 50, tokenMs: 3, jitterMs: 0, reasoningTokens: 8, answerTokens: 16 };
/** A race that runs for seconds, long enough to act while it runs. */
const SLOW = { tokenMs: 40, answerTokens: 400 };
const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

async function control(mock: RunningMock, body: unknown) {
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function addMachine(name: string, mock: RunningMock, apiKey: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name, baseUrl: mock.url, apiKey },
  });
  return created.json<MachineView>().id;
}

/** One prompt, thinking off, 64 tokens, one round on Linux, unless the test says otherwise. */
const suiteBody = (over: Record<string, unknown> = {}) => ({
  machineIds: [linuxId],
  presets: ['short'],
  thinking: [{ thinking: false }],
  maxTokens: [64],
  plan: ONE_ROUND,
  ...over,
});

const postSuite = (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/suites', payload });

async function startSuite(over: Record<string, unknown> = {}): Promise<Suite> {
  const response = await postSuite(suiteBody(over));
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Suite>();
}

async function getSuite(id: string): Promise<Suite> {
  const response = await ctx.app.inject({ method: 'GET', url: `/api/suites/${id}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Suite>();
}

/** Polls the suite until the check passes. */
async function until(id: string, check: (suite: Suite) => boolean): Promise<Suite> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const suite = await getSuite(id);
    if (check(suite)) return suite;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the suite did not get there in time');
}

const finished = (id: string) => until(id, (suite) => suite.finishedAt !== null);
const raceRunning = (id: string) => until(id, (suite) => suite.races[0]?.sessionId !== null);

async function getSession(id: string): Promise<SessionView> {
  return (await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json<SessionView>();
}

async function sessions(): Promise<SessionSummary[]> {
  return (await ctx.app.inject({ method: 'GET', url: '/api/sessions' })).json<{
    sessions: SessionSummary[];
  }>().sessions;
}

const raceBody = (machineIds: string[]) => ({
  workload: 'text',
  machineIds,
  config: { prompt: 'Hi', maxTokens: 64, thinking: false, reasoningEffort: null },
  plan: ONE_ROUND,
});

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: LINUX_KEY });
  mac = await startMockServer({ profile: 'mac-mlx', apiKey: MAC_KEY });
});
afterAll(async () => {
  await linux.close();
  await mac.close();
});
beforeEach(async () => {
  for (const mock of [linux, mac]) {
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    await control(mock, { latencyMs: 0, stream: FAST });
  }
  ctx = await testApp({ runTimings: { idleTimeoutMs: 5000 } });
  linuxId = await addMachine('Linux', linux, LINUX_KEY);
  macId = await addMachine('Mac', mac, MAC_KEY);
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('a suite', () => {
  it('runs every combination in turn, each as an ordinary race, and sums them up', async () => {
    const started = await startSuite({
      machineIds: [linuxId, macId],
      presets: ['short', 'puzzle'],
      thinking: [{ thinking: false }, { thinking: true }],
    });
    expect(started.state).toBe('running');
    expect(started.races.map((race) => race.state)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
    expect(started.machines.map((m) => m.name)).toEqual(['Linux', 'Mac']);

    const suite = await finished(started.id);
    expect(suite.state).toBe('done');
    expect(suite.races.map((race) => race.state)).toEqual(['done', 'done', 'done', 'done']);
    const ids = suite.races.map((race) => race.sessionId);
    expect(new Set(ids).size).toBe(4);

    for (const race of suite.races) {
      const session = await getSession(race.sessionId ?? '');
      expect(session.state).toBe('done');
      if (session.workload !== 'text') throw new Error('not a text race');
      // The server filled in the preset's prompt, as it does for the Text tab.
      expect(session.config).toMatchObject({
        preset: race.combo.preset,
        prompt: race.combo.preset === 'short' ? SHORT_PROMPT : PUZZLE_PROMPT,
        thinking: race.combo.thinking,
        maxTokens: 64,
        prefill: 'cold',
      });
      expect(session.provenance.map((p) => p.request?.enable_thinking)).toEqual([
        race.combo.thinking,
        race.combo.thinking,
      ]);
      expect(race.results.map((r) => [r.name, r.state, r.roundsDone])).toEqual([
        ['Linux', 'done', 1],
        ['Mac', 'done', 1],
      ]);
      // Both stand-ins report llama.cpp's timings, so the headline is the servers' own number.
      for (const result of race.results) {
        expect(result.headlines.decode).toMatchObject({ key: 'decodeServer', source: 'server' });
        expect(result.headlines.decode?.value).toBeGreaterThan(0);
      }
    }
    // One after another: each race starts after the one before has finished.
    for (let i = 1; i < suite.races.length; i += 1) {
      expect(suite.races[i]?.startedAt ?? '').not.toBe('');
      expect((suite.races[i]?.startedAt ?? '') >= (suite.races[i - 1]?.finishedAt ?? 'z')).toBe(
        true,
      );
    }
    expect((await sessions()).filter((s) => ids.includes(s.id))).toHaveLength(4);

    const listed = (await ctx.app.inject({ method: 'GET', url: '/api/suites' })).json<{
      suites: SuiteSummary[];
    }>();
    expect(listed.suites[0]).toMatchObject({
      id: suite.id,
      state: 'done',
      races: 4,
      counts: { done: 4, skipped: 0, failed: 0 },
      label: 'Short, Puzzle · thinking off; on · 64 tokens',
    });
    // The summary has a row per race and machine.
    expect(suiteCsv(suite).trim().split('\n')).toHaveLength(1 + 4 * 2);
    const files = await readdir(path.join(ctx.dataDir, 'suites'));
    expect(files).toEqual([`${suite.id}.json`]);
  });

  it('skips a race pre-flight refuses, with its reasons, and goes on', async () => {
    const started = await startSuite({ maxTokens: [64, 40_000, 128] });
    const suite = await finished(started.id);
    expect(suite.state).toBe('done');
    expect(suite.races.map((race) => race.state)).toEqual(['done', 'skipped', 'done']);
    const skipped = suite.races[1];
    expect(skipped?.sessionId).toBeNull();
    expect(skipped?.results).toEqual([]);
    expect(skipped?.error).toMatch(/do not fit Linux's context of 32,768/);
    expect(skipped?.issues).toMatchObject([{ level: 'error', code: 'no-fit', machineId: linuxId }]);
    expect(await sessions()).toHaveLength(2);
  });

  it('skips a race pre-flight warns about, unless the suite accepts warnings', async () => {
    await fetch(`${linux.url}/api/inference/load`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LINUX_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model_path: 'unsloth/Qwen3.8-27B-GGUF',
        gguf_variant: 'UD-IQ2_XXS',
        max_seq_length: 0,
      }),
    });
    const body = { machineIds: [linuxId, macId], maxTokens: [64, 128] };
    const refused = await finished((await startSuite(body)).id);
    expect(refused.races.map((race) => race.state)).toEqual(['skipped', 'skipped']);
    expect(refused.races[0]?.error).toBe(
      'Pre-flight found differences between the machines. Race anyway to start.',
    );
    expect(refused.races[0]?.issues.map((i) => `${i.level}:${i.code}`)).toContain('warning:quant');
    expect(await sessions()).toHaveLength(0);

    const accepted = await finished((await startSuite({ ...body, acknowledgeWarnings: true })).id);
    expect(accepted.races.map((race) => race.state)).toEqual(['done', 'done']);
    expect(accepted.settings.acknowledgeWarnings).toBe(true);
  });

  it('keeps a race that fails as failed, and goes on', async () => {
    // An error frame after three tokens: a race of 64 tokens fails, a race of 2 ends first.
    await control(linux, { stream: { errorAfterTokens: 3 } });
    const suite = await finished((await startSuite({ maxTokens: [64, 2] })).id);
    expect(suite.state).toBe('done');
    const [failed, done] = suite.races;
    expect(failed).toMatchObject({
      state: 'failed',
      error: 'Every machine failed in every round. Each pane says why.',
    });
    expect(failed?.sessionId).not.toBeNull();
    expect(failed?.results[0]).toMatchObject({
      state: 'failed',
      roundsDone: 0,
      error: 'Unsloth reported: Context size has been exceeded.',
    });
    expect(failed?.results[0]?.headlines.decode?.value).toBeNull();
    expect(done?.state).toBe('done');
    expect((await getSession(done?.sessionId ?? '')).state).toBe('done');
  });

  it('cancels the race in progress and every race after it', async () => {
    await control(linux, { stream: SLOW });
    const started = await startSuite({ maxTokens: [64, 128, 256] });
    const running = await raceRunning(started.id);
    const sessionId = running.races[0]?.sessionId ?? '';
    await new Promise((resolve) => setTimeout(resolve, 200));
    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/suites/${started.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    const suite = cancelled.json<Suite>();
    expect(suite.state).toBe('cancelled');
    expect(suite.finishedAt).not.toBeNull();
    expect(suite.races.map((race) => race.state)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(suite.races.map((race) => race.sessionId)).toEqual([sessionId, null, null]);
    expect(suite.races[1]?.error).toBe('The suite was cancelled before this race started.');
    // Through the race's own cancel: it is a cancelled race, and the machine stopped.
    expect((await getSession(sessionId)).state).toBe('cancelled');
    expect(await sessions()).toHaveLength(1);
    // Cancelling a finished suite changes nothing.
    const again = await ctx.app.inject({ method: 'POST', url: `/api/suites/${started.id}/cancel` });
    expect(again.json<Suite>().state).toBe('cancelled');
    // The race slot is free again.
    await control(linux, { stream: FAST });
    const race = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: raceBody([linuxId]),
    });
    expect(race.statusCode, race.body).toBe(201);
  });
});

describe('one at a time', () => {
  it('refuses a race, or another suite, while a suite runs', async () => {
    await control(linux, { stream: SLOW });
    const started = await startSuite({ maxTokens: [64, 128] });
    await raceRunning(started.id);
    const race = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: raceBody([macId]),
    });
    expect(race.statusCode).toBe(409);
    expect(race.json()).toEqual({ error: 'suite_running', message: SUITE_RUNNING });
    const second = await postSuite(suiteBody({ machineIds: [macId] }));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: 'suite_running',
      message: 'A suite is already running. Wait for it to finish or cancel it first.',
    });
    const removed = await ctx.app.inject({ method: 'DELETE', url: `/api/suites/${started.id}` });
    expect(removed.statusCode).toBe(409);
    await ctx.app.inject({ method: 'POST', url: `/api/suites/${started.id}/cancel` });
  });

  it('refuses a suite while a race runs', async () => {
    await control(linux, { stream: SLOW });
    const race = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: raceBody([linuxId]),
    });
    expect(race.statusCode).toBe(201);
    const refused = await postSuite(suiteBody({ machineIds: [macId] }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: 'busy',
      message: 'A race is running. Wait for it to finish or cancel it, then start the suite.',
    });
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/suites' })).json<{ suites: unknown[] }>()
        .suites,
    ).toEqual([]);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${race.json<SessionView>().id}/cancel`,
    });
  });

  it('starts one of a race and a suite asked for at the same moment', async () => {
    await control(linux, { stream: SLOW });
    const [race, suite] = await Promise.all([
      ctx.app.inject({ method: 'POST', url: '/api/sessions', payload: raceBody([linuxId]) }),
      postSuite(suiteBody()),
    ]);
    expect([race.statusCode, suite.statusCode].sort()).toEqual([201, 409]);
    if (suite.statusCode === 201) {
      await ctx.app.inject({ method: 'POST', url: `/api/suites/${suite.json<Suite>().id}/cancel` });
    } else {
      const id = race.json<SessionView>().id;
      await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` });
    }
  });
});

describe('when Model Duel stops', () => {
  it('marks a running suite interrupted at the next start and never resumes it', async () => {
    await control(linux, { stream: SLOW });
    const started = await startSuite({ maxTokens: [64, 128] });
    const running = await raceRunning(started.id);
    const sessionId = running.races[0]?.sessionId;
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });

    const suite = await getSuite(started.id);
    expect(suite).toMatchObject({
      state: 'interrupted',
      error: 'Model Duel stopped before this suite finished.',
    });
    expect(suite.finishedAt).not.toBeNull();
    expect(suite.races[0]).toMatchObject({
      state: 'interrupted',
      sessionId,
      error: 'Model Duel stopped during this race.',
    });
    expect(suite.races[1]).toMatchObject({
      state: 'interrupted',
      sessionId: null,
      error: 'Model Duel stopped before this race started.',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const all = await sessions();
    expect(all.map((s) => s.id)).toEqual([sessionId]);
    expect(all.every((s) => s.state !== 'running')).toBe(true);
    // The slot is free: a new suite starts.
    await control(linux, { stream: FAST });
    const next = await finished((await startSuite()).id);
    expect(next.state).toBe('done');
  });
});

describe('the suite record', () => {
  it('is deleted on its own: its races stay', async () => {
    const suite = await finished((await startSuite()).id);
    const sessionId = suite.races[0]?.sessionId ?? '';
    const removed = await ctx.app.inject({ method: 'DELETE', url: `/api/suites/${suite.id}` });
    expect(removed.statusCode).toBe(204);
    expect(await readdir(path.join(ctx.dataDir, 'suites'))).toEqual([]);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/suites/${suite.id}` })).statusCode,
    ).toBe(404);
    expect((await getSession(sessionId)).state).toBe('done');
    const again = await ctx.app.inject({ method: 'DELETE', url: `/api/suites/${suite.id}` });
    expect(again.statusCode).toBe(404);
  });

  it('answers 404 for an id that is not a suite, and never builds a path from it', async () => {
    for (const id of ['not-a-suite', '..%2F..%2Fmachines', '..%2Fsessions%2Fx', '0'.repeat(36)]) {
      for (const [method, url] of [
        ['GET', `/api/suites/${id}`],
        ['POST', `/api/suites/${id}/cancel`],
        ['DELETE', `/api/suites/${id}`],
      ] as const) {
        const response = await ctx.app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
        expect(response.json()).toMatchObject({ error: 'not_found' });
      }
    }
    const unknown = '0f0f0f0f-0000-4000-8000-000000000000';
    expect((await ctx.app.inject({ url: `/api/suites/${unknown}` })).statusCode).toBe(404);
  });

  it('skips files that are not suites when Model Duel starts', async () => {
    const dir = path.join(ctx.dataDir, 'suites');
    await writeFile(path.join(dir, 'notes.json'), '{}');
    await writeFile(path.join(dir, '0f0f0f0f-0000-4000-8000-000000000001.json'), 'not json');
    await writeFile(
      path.join(dir, '0f0f0f0f-0000-4000-8000-000000000002.json'),
      JSON.stringify({ id: '0f0f0f0f-0000-4000-8000-000000000003', schemaVersion: 1 }),
    );
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });
    const listed = (await ctx.app.inject({ method: 'GET', url: '/api/suites' })).json<{
      suites: unknown[];
    }>();
    expect(listed.suites).toEqual([]);
  });

  it('refuses a request that is not valid, and an unknown machine', async () => {
    const refused = async (over: Record<string, unknown>) => {
      const response = await postSuite(suiteBody(over));
      return { status: response.statusCode, message: response.json<{ message: string }>().message };
    };
    expect(await refused({ presets: [] })).toEqual({
      status: 400,
      message: 'Pick at least one prompt.',
    });
    expect((await refused({ presets: ['custom'] })).status).toBe(400);
    expect(
      await refused({
        presets: ['short', 'puzzle', 'code'],
        thinking: [{ thinking: false }, { thinking: true }],
        maxTokens: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      }),
    ).toEqual({
      status: 400,
      message:
        'That makes 54 races, and a suite runs at most 50. Pick fewer prompts, thinking settings or Max tokens values.',
    });
    expect(await refused({ machineIds: ['0f0f0f0f-0000-4000-8000-000000000000'] })).toEqual({
      status: 404,
      message: 'There is no machine with that id.',
    });
    expect(await readdir(path.join(ctx.dataDir, 'suites'))).toEqual([]);
  });
});

describe('access', () => {
  it('refuses changes asked for by another web site', async () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/suites',
        headers: { host: '127.0.0.1:3000', ...headers },
        payload: suiteBody(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'forbidden_origin' });
    }
    expect(await readdir(path.join(ctx.dataDir, 'suites'))).toEqual([]);
  });

  it('needs the password when the app has one', async () => {
    const dataDir = await tempDir();
    const app = await buildApp({ dataDir, password: 'correct horse battery staple' });
    try {
      for (const [method, url] of [
        ['GET', '/api/suites'],
        ['POST', '/api/suites'],
        ['GET', '/api/suites/0f0f0f0f-0000-4000-8000-000000000000'],
        ['POST', '/api/suites/0f0f0f0f-0000-4000-8000-000000000000/cancel'],
        ['DELETE', '/api/suites/0f0f0f0f-0000-4000-8000-000000000000'],
      ] as const) {
        const response = await app.inject({ method, url, payload: {} });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
        expect(response.json()).toMatchObject({ error: 'unauthorized' });
      }
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
