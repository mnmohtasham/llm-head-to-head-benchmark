import { rm } from 'node:fs/promises';
import {
  startCompatMock,
  startOllamaMock,
  type RunningEngineMock,
} from '@duel/test-servers/engines';
import type {
  DeviceRun,
  MachineView,
  PreflightResult,
  ProbeSummary,
  RunPlan,
  SessionView,
  TextConfig,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };
const KEY = 'sk-compat-test-key-0000000000000000001';

let ollama: RunningEngineMock;
let llama: RunningEngineMock;
let vllm: RunningEngineMock;
let ctx: Awaited<ReturnType<typeof testApp>>;

const post = (mock: RunningEngineMock, path: string, body: unknown = {}) =>
  fetch(`${mock.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function add(server: string, baseUrl: string, apiKey?: string): Promise<MachineView> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name: `${server} box`, baseUrl, server, ...(apiKey ? { apiKey } : {}) },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<MachineView>();
}

const probe = async (id: string) =>
  (await ctx.app.inject({ method: 'POST', url: `/api/machines/${id}/probe` })).json<ProbeSummary>();

async function race(
  ids: string[],
  config: Partial<TextConfig> = {},
  plan: Partial<RunPlan> = {},
): Promise<SessionView> {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      workload: 'text',
      machineIds: ids,
      config: { preset: 'short', maxTokens: 512, thinking: true, reasoningEffort: null, ...config },
      plan: { ...ONE_ROUND, ...plan },
      acknowledgeWarnings: true,
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

beforeAll(async () => {
  [ollama, llama, vllm] = await Promise.all([
    startOllamaMock({ config: { startupMs: 30, tokenMs: 3 } }),
    startCompatMock({ flavor: 'llama.cpp', token: KEY, config: { startupMs: 30, tokenMs: 3 } }),
    startCompatMock({ flavor: 'vllm', config: { startupMs: 30, tokenMs: 3 } }),
  ]);
});
afterAll(async () => {
  await Promise.all([ollama.close(), llama.close(), vllm.close()]);
});
beforeEach(async () => {
  await Promise.all([
    post(ollama, '/__mock/reset'),
    post(llama, '/__mock/reset'),
    post(vllm, '/__mock/reset'),
  ]);
  ctx = await testApp();
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('Ollama machines', () => {
  it('adds port 11434, probes the loaded model and races it with Ollama’s own timings', async () => {
    const machine = await add('ollama', '127.0.0.1');
    expect(machine.baseUrl).toBe('http://127.0.0.1:11434');
    const target = await add('ollama', ollama.url);

    const { report } = await probe(target.id);
    expect(report.capabilities.reachable.status).toBe('ok');
    expect(report.capabilities.text.summary).toMatch(/^qwen3:8b Q4_K_M loaded · 2 downloaded/);
    expect(report.capabilities.telemetry.status).toBe('missing');
    expect(report.versions.engine).toBe('Ollama 0.12.6');

    const session = await race([target.id], { thinking: false });
    const run = session.rounds[0]?.runs[0];
    expect(run?.state, run?.error ?? '').toBe('done');
    expect(run?.answer).toContain('the local model');
    expect(run?.reasoning).toBe('');
    // Ollama's eval timings stand in llama.cpp's place, so the server's decode speed is there.
    expect(run?.server?.timings?.predictedPerSecond).toBeGreaterThan(0);
    expect(run?.server?.ollama?.evalCount).toBe(30);
    expect(run?.server?.source).toBe('Ollama');
    const sent = ollama.bodies().at(-1) ?? {};
    expect(sent).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      think: false,
      keep_alive: '30m',
    });
    expect(sent.options).toMatchObject({ num_predict: 512 });
    expect(sent).not.toHaveProperty('options.num_ctx');

    const rows = (await ctx.app.inject({ url: '/api/runs' })).json<{ runs: DeviceRun[] }>().runs;
    expect(rows[0]).toMatchObject({
      server: 'ollama',
      engine: 'Ollama GGUF',
      thinking: 'off',
      serverVersion: 'Ollama 0.12.6',
    });
  });

  it('thinks when asked, and sends no think to a model that cannot', async () => {
    const target = await add('ollama', ollama.url);
    const thinking = await race([target.id], { thinking: true });
    expect(thinking.rounds[0]?.runs[0]?.reasoning).toContain('step0');
    expect(ollama.bodies().at(-1)?.think).toBe(true);

    await post(ollama, '/__mock/load', { names: ['gemma3:4b'] });
    const plain = await race([target.id], { thinking: false });
    expect(plain.rounds[0]?.runs[0]?.state).toBe('done');
    expect(ollama.bodies().at(-1)).not.toHaveProperty('think');
  });

  it('refuses a race with nothing loaded, and loads and unloads from the Models tab', async () => {
    const target = await add('ollama', ollama.url);
    await post(ollama, '/__mock/load', { names: [] });
    const preflight = await ctx.app.inject({
      method: 'POST',
      url: '/api/preflight',
      payload: {
        workload: 'text',
        machineIds: [target.id],
        config: { preset: 'short', maxTokens: 64, thinking: false, reasoningEffort: null },
      },
    });
    expect(preflight.json<PreflightResult>().issues.map((i) => i.code)).toContain('no-model');

    const loaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${target.id}/ollama/load`,
      payload: { model: 'gemma3:4b' },
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    const models = (
      await ctx.app.inject({ url: `/api/machines/${target.id}/ollama/models` })
    ).json<{ loaded: Array<{ name: string }>; downloaded: unknown[] }>();
    expect(models.loaded.map((m) => m.name)).toEqual(['gemma3:4b']);
    expect(models.downloaded).toHaveLength(2);
    const unloaded = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${target.id}/ollama/unload`,
      payload: { model: 'gemma3:4b' },
    });
    expect(unloaded.statusCode).toBe(200);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${target.id}/lmstudio/load`,
      payload: { model: 'gemma3:4b' },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it('races text only', async () => {
    const target = await add('ollama', ollama.url);
    const answer = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        workload: 'transcribe',
        machineIds: [target.id],
        config: { audio: { kind: 'clip' }, model: 'large-v3-turbo' },
        plan: ONE_ROUND,
        acknowledgeWarnings: true,
      },
    });
    if (answer.statusCode === 201) {
      const id = answer.json<SessionView>().id;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const view = (await ctx.app.inject({ url: `/api/sessions/${id}` })).json<SessionView>();
      expect(JSON.stringify(view)).toMatch(/runs Ollama, which races text only/);
    } else {
      expect(answer.statusCode).toBe(400);
    }
  });
});

describe('OpenAI-compatible machines', () => {
  it('probes llama-server with its key, and races it with llama.cpp’s timings', async () => {
    const without = await add('openai-compatible', llama.url);
    expect((await probe(without.id)).report.capabilities.key.summary).toBe('Key needed');

    const target = await add('openai-compatible', llama.url, KEY);
    const { report } = await probe(target.id);
    expect(report.overall).toBe('ok');
    expect(report.capabilities.text.summary).toBe(
      'qwen3-8b-q4_k_m.gguf on llama.cpp · 8,192 context',
    );
    expect(report.text).toMatchObject({ quant: 'Q4_K_M', slots: 4, backend: 'gguf' });
    expect(report.versions.engine).toBe('llama.cpp b6800-0123abcd');

    const session = await race([target.id], { thinking: false });
    const run = session.rounds[0]?.runs[0];
    expect(run?.state, run?.error ?? '').toBe('done');
    expect(run?.server?.timings?.predictedPerSecond).toBeGreaterThan(0);
    expect(run?.server?.source).toBe('llama.cpp');
    const sent = llama.bodies().at(-1) ?? {};
    expect(sent).toMatchObject({
      model: 'qwen3-8b-q4_k_m.gguf',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(sent).not.toHaveProperty('cancel_id');
    expect(sent).not.toHaveProperty('enable_thinking');

    const rows = (await ctx.app.inject({ url: '/api/runs' })).json<{ runs: DeviceRun[] }>().runs;
    expect(rows[0]).toMatchObject({
      server: 'openai-compatible',
      engine: 'llama.cpp GGUF',
      thinking: 'off',
      llamaCpp: 'b6800-0123abcd',
    });
  });

  it('races vLLM on Model Duel’s own timing, and runs throughput mode', async () => {
    const target = await add('openai-compatible', vllm.url);
    const { report } = await probe(target.id);
    expect(report.capabilities.text.summary).toBe('Qwen/Qwen3-8B on vLLM · 32,768 context');
    expect(report.issues.map((i) => i.title)).toContain(
      'vLLM reports token counts but not its own timings.',
    );
    const session = await race([target.id], { thinking: true });
    const run = session.rounds[0]?.runs[0];
    expect(run?.state, run?.error ?? '').toBe('done');
    expect(run?.reasoning).toContain('step0');
    expect(run?.server?.timings ?? null).toBeNull();
    expect(run?.client?.decodeTokPerSec).toBeGreaterThan(0);

    const batch = await race([target.id], { mode: 'throughput', concurrency: 2, thinking: false });
    expect(batch.rounds[0]?.runs[0]?.throughput?.requests).toHaveLength(2);
    expect(batch.rounds[0]?.runs[0]?.throughput?.aggregateTokPerSec).toBeGreaterThan(0);
  });

  it('says what the server answered when a run is refused', async () => {
    const target = await add('openai-compatible', vllm.url);
    await post(vllm, '/__mock/config', { failWith: 500 });
    const session = await race([target.id]);
    expect(session.rounds[0]?.runs[0]?.error).toBe(
      'OpenAI-compatible server answered HTTP 500: The mock was told to fail.',
    );
  });

  it('warns when machines run different servers', async () => {
    const a = await add('openai-compatible', vllm.url);
    const b = await add('ollama', ollama.url);
    const answer = await ctx.app.inject({
      method: 'POST',
      url: '/api/preflight',
      payload: {
        workload: 'text',
        machineIds: [a.id, b.id],
        config: { preset: 'short', maxTokens: 64, thinking: false, reasoningEffort: null },
      },
    });
    const text = answer.json<PreflightResult>().issues.find((i) => i.code === 'server')?.text;
    expect(text).toMatch(/openai-compatible box runs vLLM, ollama box runs Ollama/);
  });
});
