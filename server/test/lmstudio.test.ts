import { rm } from 'node:fs/promises';
import { startMockServer, type RunningMock } from '@duel/mock';
import { startLmStudioMock, type RunningLmMock } from '@duel/mock/lmstudio';
import type {
  DeviceRun,
  MachineStatusView,
  MachineView,
  PreflightResult,
  ProbeSummary,
  RunPlan,
  SessionView,
  TextConfig,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const UNSLOTH_KEY = 'sk-unsloth-lm-test-linux-00000000000001';
const TOKEN = 'lmstudio-token-000000000000000000001';
const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

let linux: RunningMock;
let lm: RunningLmMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;
let lmId: string;

const control = (body: unknown) =>
  fetch(`${lm.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const loadOnMock = (keys: string[]) =>
  fetch(`${lm.url}/__mock/load`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys }),
  });

function payload(ids: string[], config: Partial<TextConfig> = {}, plan: Partial<RunPlan> = {}) {
  return {
    workload: 'text',
    machineIds: ids,
    config: {
      prompt: 'Why is the sky blue?',
      maxTokens: 512,
      thinking: true,
      reasoningEffort: null,
      ...config,
    },
    plan: { ...ONE_ROUND, ...plan },
  };
}

async function finished(id: string): Promise<SessionView> {
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

async function race(ids: string[], config: Partial<TextConfig> = {}, plan: Partial<RunPlan> = {}) {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { ...payload(ids, config, plan), acknowledgeWarnings: true },
  });
  expect(started.statusCode, started.body).toBe(201);
  return finished(started.json<SessionView>().id);
}

async function preflight(ids: string[], config: Partial<TextConfig> = {}) {
  const { workload, config: body } = payload(ids, config);
  const answer = await ctx.app.inject({
    method: 'POST',
    url: '/api/preflight',
    payload: { workload, machineIds: ids, config: body },
  });
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json<PreflightResult>().issues;
}

async function addLm(baseUrl: string, apiKey?: string) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: {
      name: 'lenovo LM Studio',
      baseUrl,
      server: 'lmstudio',
      ...(apiKey ? { apiKey } : {}),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<MachineView>();
}

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: UNSLOTH_KEY });
  lm = await startLmStudioMock();
});
afterAll(async () => {
  await Promise.all([linux.close(), lm.close()]);
});
beforeEach(async () => {
  await fetch(`${linux.url}/__mock/reset`, { method: 'POST' });
  await fetch(`${lm.url}/__mock/reset`, { method: 'POST' });
  await fetch(`${linux.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: { startupMs: 40, tokenMs: 4, jitterMs: 0, answerTokens: 20 } }),
  });
  await control({ startupMs: 60, tokenMs: 4 });
  ctx = await testApp();
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name: 'Linux', baseUrl: linux.url, apiKey: UNSLOTH_KEY },
  });
  linuxId = created.json<MachineView>().id;
  lmId = (await addLm(lm.url)).id;
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('an LM Studio machine', () => {
  it('uses port 1234 when the address leaves it out', async () => {
    const view = await addLm('192.168.99.240');
    expect(view).toMatchObject({ baseUrl: 'http://192.168.99.240:1234', server: 'lmstudio' });
  });

  it('is probed as LM Studio: reachable, no token needed, its loaded model, no STT or images', async () => {
    const probed = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${lmId}/probe`,
      payload: {},
    });
    expect(probed.statusCode, probed.body).toBe(200);
    const { report } = probed.json<ProbeSummary>();
    expect(report.capabilities.reachable.status).toBe('ok');
    expect(report.capabilities.key.summary).toBe('No token needed');
    expect(report.capabilities.text).toEqual({
      status: 'ok',
      summary: 'qwen/qwen3.8-27b Q4_K_M loaded · 3 downloaded',
    });
    expect(report.capabilities.stt.status).toBe('missing');
    expect(report.capabilities.telemetry.status).toBe('missing');
    expect(report.text).toMatchObject({ contextLength: 8192, slots: 4, backend: 'gguf' });

    // Unsloth's address is not LM Studio.
    const wrong = await addLm(linux.url);
    const refused = (
      await ctx.app.inject({ method: 'POST', url: `/api/machines/${wrong.id}/probe`, payload: {} })
    ).json<ProbeSummary>();
    expect(refused.report.capabilities.reachable).toEqual({
      status: 'error',
      summary: 'Not LM Studio',
    });
  });

  it('asks for a token when LM Studio requires one', async () => {
    const guarded = await startLmStudioMock({ token: TOKEN });
    try {
      const bare = await addLm(guarded.url);
      const refused = (
        await ctx.app.inject({ method: 'POST', url: `/api/machines/${bare.id}/probe`, payload: {} })
      ).json<ProbeSummary>();
      expect(refused.report.capabilities.key).toEqual({ status: 'error', summary: 'Token needed' });
      const keyed = await addLm(guarded.url, TOKEN);
      const accepted = (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/machines/${keyed.id}/probe`,
          payload: {},
        })
      ).json<ProbeSummary>();
      expect(accepted.report.capabilities.key.summary).toBe('Token accepted');
      expect(JSON.stringify(accepted)).not.toContain(TOKEN);
    } finally {
      await guarded.close();
    }
  });

  it('reports its loaded model in the same status shape as Unsloth', async () => {
    const view = (
      await ctx.app.inject({ method: 'GET', url: `/api/machines/${lmId}/status` })
    ).json<MachineStatusView>();
    expect(view.status).toMatchObject({
      server: 'lmstudio',
      activeModel: 'qwen/qwen3.8-27b',
      quant: 'Q4_K_M',
      backend: 'gguf',
      contextLength: 8192,
      parallelSlots: 4,
      supportsReasoning: true,
      reasoningAlwaysOn: false,
      reasoningEffortLevels: ['low', 'medium', 'xhigh'],
    });
  });
});

describe('a race with LM Studio', () => {
  it('races Unsloth and LM Studio side by side, with LM Studio’s own timings', async () => {
    const session = await race([linuxId, lmId]);
    expect(session.state).toBe('done');
    const [unsloth, studio] = session.rounds[0]?.runs ?? [];
    expect(unsloth?.state).toBe('done');
    expect(studio?.state, studio?.error ?? '').toBe('done');
    expect(studio?.reasoning.trim().split(/\s+/)).toHaveLength(12);
    expect(studio?.answer.trim().split(/\s+/)).toHaveLength(40);
    expect(studio?.client).toMatchObject({ outputTokens: 52, finishReason: 'stop', sawDone: true });
    expect(studio?.client?.ttftMs).toBeGreaterThanOrEqual(60);
    expect(studio?.server?.lmstudio).toMatchObject({ outputTokens: 52, reasoningTokens: 12 });
    expect(studio?.server?.lmstudio?.ttftMs).toBeGreaterThanOrEqual(55);
    expect(studio?.server?.lmstudio?.tokPerSec).toBeGreaterThan(10);
    expect(studio?.modelBefore).toBe('qwen/qwen3.8-27b');

    const [body] = lm.bodies();
    expect(body).toMatchObject({
      model: 'qwen/qwen3.8-27b',
      stream: true,
      store: false,
      max_output_tokens: 512,
      reasoning: 'on',
      repeat_penalty: 1,
    });
    expect(String(body?.input)).toContain('Why is the sky blue?');
    expect(body?.cancel_id).toBeUndefined();
    expect(body?.seed).toBeUndefined();
    expect(session.provenance[1]).toMatchObject({ server: 'lmstudio' });

    const rows = (await ctx.app.inject({ method: 'GET', url: '/api/runs' })).json<{
      runs: DeviceRun[];
    }>().runs;
    expect(rows.find((r) => r.machineId === lmId)).toMatchObject({
      server: 'lmstudio',
      engine: 'LM Studio GGUF',
      kvCache: null,
      speculative: null,
      slots: 4,
      thinking: 'on',
    });
    expect(typeof rows.find((r) => r.machineId === lmId)?.metrics.decodeServer).toBe('number');
  });

  it('sends thinking off, or an effort the model takes', async () => {
    const off = await race([lmId], { thinking: false });
    expect(lm.bodies().at(-1)?.reasoning).toBe('off');
    expect(off.rounds[0]?.runs[0]?.reasoning).toBe('');
    await race([lmId], { reasoningEffort: 'low' });
    expect(lm.bodies().at(-1)?.reasoning).toBe('low');
  });

  it('runs several requests at once in throughput mode', async () => {
    const session = await race([lmId], { mode: 'throughput', concurrency: 3, thinking: false });
    const run = session.rounds[0]?.runs[0];
    expect(run?.state, run?.error ?? '').toBe('done');
    expect(run?.throughput?.requests.filter((r) => r.state === 'done')).toHaveLength(3);
    expect(lm.bodies()).toHaveLength(3);
  });

  it('says so when LM Studio refuses a request', async () => {
    await control({ failWith: 500 });
    const session = await race([lmId]);
    expect(session.rounds[0]?.runs[0]?.error).toBe(
      'LM Studio answered HTTP 500: The mock was told to fail.',
    );
  });

  it('stops LM Studio’s stream when the race is cancelled', async () => {
    await control({ tokenMs: 60, answerTokens: 400 });
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: payload([lmId]),
    });
    const id = started.json<SessionView>().id;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, payload: {} });
    const session = await finished(id);
    expect(session.rounds[0]?.runs[0]?.state).toBe('cancelled');
  });
});

describe('pre-flight', () => {
  it('needs exactly one loaded model, and says what it cannot check', async () => {
    const clear = await preflight([lmId]);
    expect(clear.filter((i) => i.level === 'error')).toEqual([]);
    expect(clear.find((i) => i.code === 'lmstudio')?.text).toMatch(/cannot count tokens/);

    await loadOnMock([]);
    expect((await preflight([lmId])).find((i) => i.level === 'error')?.code).toBe('no-model');
    await loadOnMock(['qwen/qwen3.8-27b', 'google/gemma-4-12b']);
    expect((await preflight([lmId])).find((i) => i.level === 'error')?.text).toMatch(
      /more than one model loaded: qwen\/qwen3\.8-27b, google\/gemma-4-12b/,
    );
  });

  it('warns that a mixed race compares the servers too, and checks LM Studio’s parallel slots', async () => {
    const mixed = await preflight([linuxId, lmId]);
    expect(mixed.find((i) => i.code === 'server')?.text).toMatch(/lenovo LM Studio runs LM Studio/);
    expect(mixed.some((i) => i.code === 'kv-cache' || i.code === 'speculative')).toBe(false);
    const busy = await preflight([lmId], { mode: 'throughput', concurrency: 6 });
    expect(busy.find((i) => i.code === 'slots')?.text).toMatch(
      /Load it again in LM Studio with 6 parallel/,
    );
  });
});

describe('loading on the Models tab', () => {
  it('lists, loads and unloads through LM Studio, and keeps Unsloth’s routes away', async () => {
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/machines/${lmId}/lmstudio/models`,
    });
    expect(listed.json<{ models: Array<{ key: string }> }>().models).toHaveLength(4);
    const loaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${lmId}/lmstudio/load`,
      payload: { model: 'google/gemma-4-12b', contextLength: 16384, parallel: 2 },
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    const unloaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${lmId}/lmstudio/unload`,
      payload: { instanceId: 'qwen/qwen3.8-27b' },
    });
    expect(unloaded.statusCode, unloaded.body).toBe(200);
    const status = (
      await ctx.app.inject({ method: 'GET', url: `/api/machines/${lmId}/status` })
    ).json<MachineStatusView>().status;
    expect(status).toMatchObject({
      activeModel: 'google/gemma-4-12b',
      contextLength: 16384,
      parallelSlots: 2,
    });

    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/machines/${lmId}/models` })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/machines/${linuxId}/lmstudio/models` }))
        .statusCode,
    ).toBe(400);
  });
});
