import { rm } from 'node:fs/promises';
import { startMockServer, type RunningMock } from '@duel/mock';
import {
  publicSession,
  sessionStats,
  type DeviceRun,
  type MachineView,
  type ResultFile,
  type RunPlan,
  type SessionView,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyResult } from '../src/results';
import { testApp } from './helpers';

const LINUX_KEY = 'sk-unsloth-runs-linux-00000000000000001';
const MAC_KEY = 'sk-unsloth-runs-mac-0000000000000000002';
const TWO_ROUNDS: RunPlan = { rounds: 2, warmup: false, settleMs: 0, sequencing: 'concurrent' };
let linux: RunningMock;
let mac: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let ids: string[];

async function race(plan: Partial<RunPlan> = {}): Promise<SessionView> {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      workload: 'text',
      machineIds: ids,
      config: {
        prompt: 'Why is the sky blue?',
        maxTokens: 512,
        thinking: false,
        reasoningEffort: null,
      },
      plan: { ...TWO_ROUNDS, ...plan },
    },
  });
  expect(started.statusCode, started.body).toBe(201);
  const id = started.json<SessionView>().id;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const view = (
      await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })
    ).json<SessionView>();
    if (view.finishedAt) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the race did not finish');
}

const runs = async () =>
  (await ctx.app.inject({ method: 'GET', url: '/api/runs' })).json<{ runs: DeviceRun[] }>().runs;

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: LINUX_KEY });
  mac = await startMockServer({ profile: 'mac-mlx', apiKey: MAC_KEY });
});
afterAll(async () => {
  await Promise.all([linux.close(), mac.close()]);
});
beforeEach(async () => {
  for (const mock of [linux, mac]) {
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    await fetch(`${mock.url}/__mock/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: { startupMs: 40, tokenMs: 4, jitterMs: 0, answerTokens: 20 },
      }),
    });
  }
  ctx = await testApp();
  ids = [];
  for (const [name, mock, apiKey] of [
    ['Linux', linux, LINUX_KEY],
    ['Mac', mac, MAC_KEY],
  ] as const) {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name, baseUrl: mock.url, apiKey },
    });
    const id = created.json<MachineView>().id;
    // The probe gives the race its hardware snapshot.
    await ctx.app.inject({ method: 'POST', url: `/api/machines/${id}/probe`, payload: {} });
    ids.push(id);
  }
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('the Results rows', () => {
  it('has one row per machine per finished race, with the report’s own medians', async () => {
    expect(await runs()).toEqual([]);
    const session = await race();
    const rows = await runs();
    expect(rows.map((r) => r.machine)).toEqual(['Linux', 'Mac']);
    const [linuxRow, macRow] = rows;
    expect(linuxRow).toMatchObject({
      sessionId: session.id,
      kind: 'text',
      state: 'done',
      rounds: 2,
      roundsDone: 2,
      gpu: 'NVIDIA GeForce RTX 5090',
      platform: 'CUDA',
      model: 'unsloth/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
      engine: 'GGUF',
      thinking: 'off',
      prompt: 'Custom: Why is the sky blue?',
    });
    expect(linuxRow?.gpuMemoryGb).toBeGreaterThan(30);
    expect(linuxRow?.contextLength).toBeGreaterThan(0);
    expect(macRow?.platform).toBe('MLX');

    const stats = sessionStats(publicSession(session));
    const decode = stats.find((row) => row.key === 'decode');
    expect(linuxRow?.metrics.decode).toBe(decode?.summaries[0]?.median);
    expect(macRow?.metrics.decode).toBe(decode?.summaries[1]?.median);
    // No key or address reaches the rows.
    const body = JSON.stringify(rows);
    expect(body).not.toContain(LINUX_KEY);
    expect(body).not.toContain(linux.url);
  });

  it('adds new races first and drops deleted ones', async () => {
    const first = await race();
    const second = await race();
    expect((await runs()).map((r) => r.sessionId)).toEqual([
      second.id,
      second.id,
      first.id,
      first.id,
    ]);
    await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${second.id}` });
    expect((await runs()).map((r) => r.sessionId)).toEqual([first.id, first.id]);
  });
});

describe('median or average', () => {
  it('runs more than ten rounds, and summarises them as the plan asks', async () => {
    const session = await race({ rounds: 12, statistic: 'mean' });
    expect(session.rounds).toHaveLength(12);
    expect(session.plan.statistic).toBe('mean');
    const rows = await runs();
    expect(rows[0]).toMatchObject({ rounds: 12, roundsDone: 12 });
    const stats = sessionStats(publicSession(session));
    expect(rows[0]?.means.decode).toBe(stats.find((r) => r.key === 'decode')?.summaries[0]?.mean);

    const tooMany = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        workload: 'text',
        machineIds: ids,
        config: { prompt: 'Hi', maxTokens: 64, thinking: false, reasoningEffort: null },
        plan: { ...TWO_ROUNDS, rounds: 101 },
      },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.body).toContain('Run at most 100 rounds.');
  });

  it('switches a finished race between median and average, result file included', async () => {
    const session = await race();
    expect(session.plan.statistic).toBeUndefined();
    const result = async () =>
      (
        await ctx.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/result.json` })
      ).json<ResultFile>();
    expect((await result()).settings.plan.statistic).toBe('median');

    const switched = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/statistic`,
      payload: { statistic: 'mean' },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json<SessionView>().plan.statistic).toBe('mean');
    const file = await result();
    expect(file.settings.plan.statistic).toBe('mean');
    expect(verifyResult(file)).toBe(true);
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/sessions' })).json<
      | Array<{ id: string; statistic: string }>
      | { sessions: Array<{ id: string; statistic: string }> }
    >();
    const summaries = Array.isArray(list) ? list : list.sessions;
    expect(summaries.find((s) => s.id === session.id)?.statistic).toBe('mean');

    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/statistic`,
      payload: { statistic: 'mode' },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions/00000000-0000-4000-8000-000000000000/statistic',
      payload: { statistic: 'mean' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
