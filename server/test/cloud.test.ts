import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/mock';
import { startCloudMock, type CloudMockProvider, type RunningCloudMock } from '@duel/mock/cloud';
import {
  type CloudModel,
  type MachineView,
  type PreflightResult,
  type RunPlan,
  type SessionView,
  type TextConfig,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-cloud-linux-0000000000000001';
const KEYS: Record<CloudMockProvider, string> = {
  openai: 'sk-proj-mockopenai000000000000000000000001',
  anthropic: 'sk-ant-api03-mockanthropic0000000000000001',
  gemini: 'AIzaSyMockGemini0000000000000000000001',
};
const MODELS: Record<CloudMockProvider, string> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.8-flash',
};
const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

let linux: RunningMock;
const clouds = {} as Record<CloudMockProvider, RunningCloudMock>;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;

async function listModels(provider: CloudMockProvider, apiKey = KEYS[provider]) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/cloud/models',
    payload: { provider, apiKey, baseUrl: clouds[provider].url },
  });
}

/** Adds a cloud participant with the model its list offers under that id. */
async function addCloud(provider: CloudMockProvider, model: string | null = MODELS[provider]) {
  const listed = (await listModels(provider)).json<{ models: CloudModel[] }>().models;
  const picked = model === null ? null : (listed.find((m) => m.id === model) ?? null);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: {
      name: provider,
      baseUrl: clouds[provider].url,
      apiKey: KEYS[provider],
      cloud: { provider, model: picked },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<MachineView>();
}

function payload(machineIds: string[], config: Partial<TextConfig> = {}, plan = ONE_ROUND) {
  return {
    workload: 'text',
    machineIds,
    config: {
      prompt: 'Why is the sky blue?',
      maxTokens: 1024,
      thinking: true,
      reasoningEffort: null,
      ...config,
    },
    plan,
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

async function race(machineIds: string[], config: Partial<TextConfig> = {}, plan = ONE_ROUND) {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: payload(machineIds, config, plan),
  });
  expect(started.statusCode, started.body).toBe(201);
  return finished(started.json<SessionView>().id);
}

async function preflight(machineIds: string[], config: Partial<TextConfig> = {}) {
  const { workload, config: body } = payload(machineIds, config);
  const answer = await ctx.app.inject({
    method: 'POST',
    url: '/api/preflight',
    payload: { workload, machineIds, config: body },
  });
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json<PreflightResult>().issues;
}

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    clouds[provider] = await startCloudMock({ provider, apiKey: KEYS[provider] });
  }
});
afterAll(async () => {
  await linux.close();
  await Promise.all(Object.values(clouds).map((c) => c.close()));
});
beforeEach(async () => {
  await fetch(`${linux.url}/__mock/reset`, { method: 'POST' });
  for (const cloud of Object.values(clouds)) {
    await fetch(`${cloud.url}/__mock/reset`, { method: 'POST' });
  }
  ctx = await testApp();
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name: 'Linux', baseUrl: linux.url, apiKey: KEY },
  });
  linuxId = created.json<MachineView>().id;
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('model lists', () => {
  it('lists only the text models each provider offers, with what they accept', async () => {
    const ids = async (provider: CloudMockProvider) =>
      (await listModels(provider)).json<{ models: CloudModel[] }>().models.map((m) => m.id);
    expect(await ids('openai')).toEqual(['gpt-4.1-mini', 'gpt-5.4-nano', 'gpt-6-luna']);
    expect(await ids('anthropic')).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
    expect(await ids('gemini')).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash']);

    const sonnet = (await listModels('anthropic'))
      .json<{ models: CloudModel[] }>()
      .models.find((m) => m.id === 'claude-sonnet-5');
    expect(sonnet).toMatchObject({
      label: 'Claude Sonnet 5',
      maxOutput: 128_000,
      thinking: 'optional',
      thinkingStyle: 'anthropic-adaptive',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('says plainly when a key is wrong or missing, and never sends a key back', async () => {
    for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
      const wrong = await listModels(provider, 'not-the-key-000000000000000');
      expect(wrong.statusCode).toBe(502);
      expect(wrong.json<{ message: string }>().message).toMatch(/did not accept the API key/);
    }
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/cloud/models',
      payload: { provider: 'openai', baseUrl: clouds.openai.url },
    });
    expect(missing.json<{ message: string }>().message).toBe('Enter the OpenAI API key first.');
  });

  it('uses a saved participant’s key when the form leaves it empty', async () => {
    const saved = await addCloud('gemini');
    const answer = await ctx.app.inject({
      method: 'POST',
      url: '/api/cloud/models',
      payload: { provider: 'gemini', machineId: saved.id },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json<{ models: CloudModel[] }>().models).toHaveLength(2);
  });
});

describe('cloud participants', () => {
  it('are saved with their model, show no key, and have nothing to probe', async () => {
    const view = await addCloud('anthropic');
    expect(view.cloud?.provider).toBe('anthropic');
    expect(view.cloud?.model?.id).toBe('claude-sonnet-5');
    expect(JSON.stringify(view)).not.toContain(KEYS.anthropic);
    expect(view.apiKeyMasked).toMatch(/…/);
    const probe = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${view.id}/probe`,
      payload: {},
    });
    expect(probe.statusCode).toBe(400);
    const hosts = (await ctx.app.inject({ method: 'GET', url: '/api/machines/hosts' })).json<{
      hosts: Record<string, string>;
    }>().hosts;
    expect(Object.keys(hosts)).not.toContain(view.id);
  });

  it('take https when the address has no scheme', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: {
        name: 'Claude',
        baseUrl: 'api.anthropic.com',
        apiKey: KEYS.anthropic,
        cloud: { provider: 'anthropic', model: null },
      },
    });
    expect(created.json<MachineView>().baseUrl).toBe('https://api.anthropic.com');
  });

  it('never lend a saved key to another provider', async () => {
    const gemini = await addCloud('gemini');
    const asOpenai = await ctx.app.inject({
      method: 'POST',
      url: '/api/cloud/models',
      payload: { provider: 'openai', machineId: gemini.id, baseUrl: clouds.openai.url },
    });
    expect(asOpenai.json<{ message: string }>().message).toBe('Enter the OpenAI API key first.');
    const switched = await ctx.app.inject({
      method: 'PUT',
      url: `/api/machines/${gemini.id}`,
      payload: {
        name: gemini.name,
        baseUrl: clouds.openai.url,
        cloud: { provider: 'openai', model: null },
      },
    });
    expect(switched.statusCode).toBe(400);
    const local = await ctx.app.inject({
      method: 'PUT',
      url: `/api/machines/${linuxId}`,
      payload: { name: 'Linux', baseUrl: linux.url, cloud: { provider: 'openai', model: null } },
    });
    expect(local.statusCode).toBe(400);
    expect(clouds.openai.bodies()).toEqual([]);
  });

  it('can change model later without touching the key', async () => {
    const view = await addCloud('openai');
    const listed = (await listModels('openai')).json<{ models: CloudModel[] }>().models;
    const nano = listed.find((m) => m.id === 'gpt-5.4-nano');
    const changed = await ctx.app.inject({
      method: 'PUT',
      url: `/api/machines/${view.id}`,
      payload: {
        name: view.name,
        baseUrl: view.baseUrl,
        notes: '',
        cloud: { provider: 'openai', model: nano },
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<MachineView>()).toMatchObject({
      hasApiKey: true,
      cloud: { model: { id: 'gpt-5.4-nano' } },
    });
  });
});

describe('pre-flight', () => {
  it('asks for a model, refuses a Max tokens above the model’s limit, and notes the rest', async () => {
    const none = await addCloud('openai', null);
    expect((await preflight([none.id])).find((i) => i.level === 'error')?.text).toBe(
      'Pick a OpenAI model for openai on the Machines screen.',
    );
    const haiku = await addCloud('anthropic', 'claude-haiku-4-5');
    const issues = await preflight([linuxId, haiku.id], { maxTokens: 70_000 });
    expect(issues.find((i) => i.machineId === haiku.id && i.level === 'error')?.text).toMatch(
      /writes at most 64,000 tokens/,
    );
    const fine = await preflight([linuxId, haiku.id], { maxTokens: 1024 });
    expect(fine.filter((i) => i.level === 'error')).toEqual([]);
    expect(fine.some((i) => i.code === 'cloud' && /reference/.test(i.text))).toBe(true);
  });
});

describe('a race with cloud models', () => {
  it('races a local machine against all three providers, measured the same way', async () => {
    const ids = [linuxId];
    for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
      ids.push((await addCloud(provider)).id);
    }
    const session = await race(ids);
    expect(session.state).toBe('done');
    const runs = session.rounds[0]?.runs ?? [];
    expect(runs.map((r) => r.error ?? r.state)).toEqual(['done', 'done', 'done', 'done']);
    for (const run of runs.slice(1)) {
      expect(run.answer.trim().split(/\s+/)).toHaveLength(40);
      expect(run.reasoning.trim().split(/\s+/)).toHaveLength(20);
      expect(run.client).toMatchObject({
        outputTokens: 60,
        finishReason: 'stop',
        sawDone: true,
        tokensEstimated: false,
      });
      expect(run.client?.ttftMs).toBeGreaterThanOrEqual(250);
      expect(run.client?.decodeTokPerSec).toBeGreaterThan(10);
    }
    expect(runs.map((r) => r.modelBefore)).toEqual([
      'unsloth/Qwen3.8-27B-GGUF',
      'gpt-6-luna',
      'claude-sonnet-5',
      'gemini-3.8-flash',
    ]);
    expect(runs[1]?.server?.cloud).toMatchObject({
      provider: 'openai',
      requestId: 'req_mock_openai',
      processingMs: 12,
    });
    expect(runs[2]?.server?.cloud?.requestId).toBe('req_mock_anthropic');
    expect(session.provenance.map((p) => p.cloud?.model?.id ?? null)).toEqual([
      null,
      'gpt-6-luna',
      'claude-sonnet-5',
      'gemini-3.8-flash',
    ]);

    // Each provider got its own API's request, with no Unsloth fields.
    const [openai] = clouds.openai.bodies();
    expect(openai).toMatchObject({
      model: 'gpt-6-luna',
      stream: true,
      store: false,
      max_output_tokens: 1024,
      reasoning: { summary: 'auto' },
    });
    expect(openai?.cancel_id).toBeUndefined();
    expect(String(openai?.input)).toContain('Why is the sky blue?');
    expect(clouds.anthropic.bodies()[0]).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      thinking: { type: 'adaptive', display: 'summarized' },
    });
    expect(clouds.anthropic.bodies()[0]?.temperature).toBeUndefined();
    expect(clouds.gemini.bodies()[0]).toMatchObject({
      generationConfig: { maxOutputTokens: 1024, thinkingConfig: { includeThoughts: true } },
    });
  });

  it('writes a result file that names the provider and model and holds no key', async () => {
    const openai = await addCloud('openai');
    const session = await race([linuxId, openai.id]);
    const answer = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/result.json`,
    });
    expect(answer.statusCode).toBe(200);
    const result = answer.json<{
      machines: Array<{ kind: string; cloud: unknown; hardware: unknown }>;
    }>();
    expect(result.machines.map((m) => m.kind)).toEqual(['local', 'cloud']);
    expect(result.machines[1]?.cloud).toMatchObject({ provider: 'openai', model: 'gpt-6-luna' });
    expect(answer.body).not.toContain(KEYS.openai);
    const stored = await readFile(path.join(ctx.dataDir, 'sessions', `${session.id}.json`), 'utf8');
    expect(stored).not.toContain(KEYS.openai);
  });

  it('turns thinking off where the model allows it', async () => {
    const claude = await addCloud('anthropic');
    const gemini = await addCloud('gemini', 'gemini-3.5-flash-lite');
    const session = await race([claude.id, gemini.id], { thinking: false });
    expect(session.state).toBe('done');
    expect(clouds.anthropic.bodies()[0]?.thinking).toEqual({ type: 'disabled' });
    // Gemini 3 cannot stop thinking; it is asked for the least.
    expect(clouds.gemini.bodies()[0]).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    });
    expect(session.rounds[0]?.runs[0]?.reasoning).toBe('');
  });

  it('reports a provider’s refusal in words, and the local machine still finishes', async () => {
    const openai = await addCloud('openai');
    await fetch(`${clouds.openai.url}/__mock/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failWith: 429 }),
    });
    const session = await race([linuxId, openai.id]);
    const [local, cloud] = session.rounds[0]?.runs ?? [];
    expect(local?.state).toBe('done');
    expect(cloud?.state).toBe('failed');
    expect(cloud?.error).toMatch(/OpenAI is rate-limiting this key/);
  });

  it('says when an answer ran into Max tokens', async () => {
    const gemini = await addCloud('gemini');
    await fetch(`${clouds.gemini.url}/__mock/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answerTokens: 400 }),
    });
    const session = await race([gemini.id], { maxTokens: 100 });
    expect(session.rounds[0]?.runs[0]?.client?.finishReason).toBe('length');
  });

  it('stops a cloud stream when the race is cancelled', async () => {
    const claude = await addCloud('anthropic');
    await fetch(`${clouds.anthropic.url}/__mock/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenMs: 50, answerTokens: 400 }),
    });
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: payload([claude.id]),
    });
    const id = started.json<SessionView>().id;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, payload: {} });
    const session = await finished(id);
    expect(session.state).toBe('cancelled');
    expect(session.rounds[0]?.runs[0]?.state).toBe('cancelled');
  });
});
