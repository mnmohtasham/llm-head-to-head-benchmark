import { rm } from 'node:fs/promises';
import { startMockServer, type RunningMock } from '@duel/mock';
import {
  DEFAULT_LOAD_SETTINGS,
  type LoadJob,
  type LoadStartResult,
  type MachineModelsView,
  type MachineStatusView,
  type MachineView,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closedPort, testApp } from './helpers';

const MAC_KEY = 'sk-unsloth-models-test-mac-00000000000001';
const LINUX_KEY = 'sk-unsloth-models-test-linux-0000000000002';

let mac: RunningMock;
let linux: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let macId: string;
let linuxId: string;

async function control(mock: RunningMock, body: unknown) {
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function addMachine(name: string, baseUrl: string, apiKey?: string): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name, baseUrl, ...(apiKey ? { apiKey } : {}) },
  });
  return response.json<MachineView>().id;
}

async function models(id: string, refresh = false) {
  const url = `/api/machines/${id}/models${refresh ? '?refresh=1' : ''}`;
  return (await ctx.app.inject({ method: 'GET', url })).json<MachineModelsView>();
}

async function status(id: string) {
  return (
    await ctx.app.inject({ method: 'GET', url: `/api/machines/${id}/status` })
  ).json<MachineStatusView>();
}

async function load(machineIds: string[], modelId: string, quant: string | null, settings = {}) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/models/load',
    payload: { machineIds, modelId, quant, settings: { ...DEFAULT_LOAD_SETTINGS, ...settings } },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ results: LoadStartResult[] }>().results;
}

async function jobs(): Promise<LoadJob[]> {
  return (await ctx.app.inject({ method: 'GET', url: '/api/loads' })).json<{ jobs: LoadJob[] }>()
    .jobs;
}

async function waitForJobs(ids: string[], seen: LoadJob[] = []): Promise<LoadJob[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = (await jobs()).filter((job) => ids.includes(job.machineId));
    seen.push(...current);
    if (
      current.length === ids.length &&
      current.every((job) => !['loading', 'cancelling'].includes(job.state))
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('loads did not finish');
}

beforeAll(async () => {
  mac = await startMockServer({ profile: 'mac-mlx', apiKey: MAC_KEY });
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: LINUX_KEY });
});
afterAll(async () => {
  await mac.close();
  await linux.close();
});
beforeEach(async () => {
  for (const mock of [mac, linux]) {
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    await control(mock, { loadMs: 300 });
  }
  ctx = await testApp();
  macId = await addMachine('Mac', mac.url, MAC_KEY);
  linuxId = await addMachine('Linux', linux.url, LINUX_KEY);
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('model lists', () => {
  it('lists the text models each machine has, loaded first, with complete quants only', async () => {
    const view = await models(macId);
    expect(view.error).toBeNull();
    expect(view.models?.map((m) => [m.modelId, m.loaded, m.quants.map((q) => q.quant)])).toEqual([
      ['unsloth/Qwen3.8-27B-GGUF', true, ['Q4_K_M']],
      ['lmstudio-community/Qwen3.8-8B-GGUF', false, ['Q4_K_M']],
      ['mlx-community/Qwen3.8-27B-4bit', false, []],
      ['unsloth/gemma-4-12b-it-GGUF', false, ['Q4_K_M', 'Q8_0']],
    ]);
    expect(view.models?.find((m) => m.source === 'lmstudio')?.loadId).toMatch(/^ref:/);
  });

  it('explains a rejected key and an unreachable machine instead of failing', async () => {
    const wrongKey = await addMachine('Wrong key', mac.url, 'sk-unsloth-not-the-right-key-0000000');
    expect((await models(wrongKey)).error).toMatch(/rejected the API key/);
    expect((await status(wrongKey)).error).toMatch(/rejected the API key/);
    const nowhere = await addMachine('Nowhere', `127.0.0.1:${await closedPort()}`, MAC_KEY);
    expect((await models(nowhere)).error).toMatch(/Nothing is listening/);
  });
});

describe('loading', () => {
  it('loads the same model on both machines, with progress, and reads the settings back', async () => {
    const results = await load([macId, linuxId], 'unsloth/gemma-4-12b-it-GGUF', 'Q4_K_M', {
      contextLength: 8192,
      speculativeType: 'off',
    });
    expect(results.map((r) => r.started)).toEqual([true, true]);
    const seen: LoadJob[] = [];
    const finished = await waitForJobs([macId, linuxId], seen);
    expect(finished.map((job) => job.state)).toEqual(['loaded', 'loaded']);
    expect(finished.every((job) => (job.durationMs ?? 0) >= 250)).toBe(true);
    expect(seen.some((job) => job.state === 'loading' && job.progress?.phase === 'mmap')).toBe(
      true,
    );

    for (const id of [macId, linuxId]) {
      const view = await status(id);
      expect(view.status).toMatchObject({
        activeModel: 'unsloth/gemma-4-12b-it-GGUF',
        quant: 'Q4_K_M',
        contextLength: 8192,
        speculativeType: 'off',
        cacheTypeKv: 'f16',
        parallelSlots: 1,
        memoryWarning: null,
      });
      expect(view.job).toMatchObject({
        state: 'loaded',
        quant: 'Q4_K_M',
        settings: { contextLength: 8192 },
      });
    }
  });

  it('skips a machine that does not have the quant, and says why', async () => {
    const results = await load([macId, linuxId], 'unsloth/gemma-4-12b-it-GGUF', 'Q8_0');
    expect(results).toEqual([
      expect.objectContaining({ machineId: macId, started: true }),
      {
        machineId: linuxId,
        started: false,
        job: null,
        reason: 'Q8_0 is not fully downloaded on this machine.',
      },
    ]);
    await waitForJobs([macId]);
    expect((await status(linuxId)).status?.activeModel).toBe('unsloth/Qwen3.8-27B-GGUF');
  });

  it('shows Unsloth’s own failure message and a memory warning', async () => {
    await control(linux, { failNextLoad: 'Failed to load GGUF model: gemma-4-12b-it-GGUF' });
    await control(mac, {
      memoryWarning: 'The weights do not fit in memory; llama.cpp pages them from disk.',
    });
    await load([macId, linuxId], 'unsloth/gemma-4-12b-it-GGUF', 'Q4_K_M');
    const [macJob, linuxJob] = await waitForJobs([macId, linuxId]);
    expect(linuxJob).toMatchObject({
      state: 'failed',
      error: 'Failed to load GGUF model: gemma-4-12b-it-GGUF',
    });
    expect(macJob).toMatchObject({
      state: 'loaded',
      memoryWarning: expect.stringMatching(/do not fit/),
    });
    expect((await status(macId)).status?.memoryWarning).toMatch(/do not fit/);
  });

  it('reads a padded slow answer, and a late failure hidden inside one', async () => {
    await control(mac, { loadMs: 500, padAfterMs: 100, padEveryMs: 40 });
    await control(linux, {
      loadMs: 800,
      padAfterMs: 100,
      padEveryMs: 40,
      failNextLoad: 'Failed late',
    });
    await load([macId, linuxId], 'unsloth/Qwen3.8-27B-GGUF', 'Q4_K_M', { contextLength: 4096 });
    const [macJob, linuxJob] = await waitForJobs([macId, linuxId]);
    expect(macJob?.state).toBe('loaded');
    expect(linuxJob).toMatchObject({ state: 'failed', error: 'Failed late' });
  });

  it('cancels a running load', async () => {
    await control(linux, { loadMs: 5000 });
    await load([linuxId], 'unsloth/Qwen3.8-8B-GGUF', 'Q4_K_M');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/api/machines/${linuxId}/load/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    const [job] = await waitForJobs([linuxId]);
    expect(job?.state).toBe('cancelled');
    expect(job?.durationMs).toBeLessThan(3000);
  });

  it('refuses a second load and an unload while a load runs, and reports a busy GPU', async () => {
    await control(linux, { loadMs: 1500 });
    await load([linuxId], 'unsloth/Qwen3.8-8B-GGUF', 'Q4_K_M');
    const second = await load([linuxId], 'unsloth/gemma-4-12b-it-GGUF', 'Q4_K_M');
    expect(second[0]).toMatchObject({
      started: false,
      reason: 'A load is already running on this machine.',
    });
    const unload = await ctx.app.inject({ method: 'POST', url: `/api/machines/${linuxId}/unload` });
    expect(unload.statusCode).toBe(409);
    await waitForJobs([linuxId]);

    await control(mac, { gpuBusy: true });
    await load([macId], 'unsloth/gemma-4-12b-it-GGUF', 'Q4_K_M');
    const [busy] = await waitForJobs([macId]);
    expect(busy?.error).toMatch(/GPU on that machine is busy/);
  });

  it('unloads the model and keeps the last load across a restart', async () => {
    await load([macId], 'unsloth/gemma-4-12b-it-GGUF', 'Q8_0');
    await waitForJobs([macId]);
    const unload = await ctx.app.inject({ method: 'POST', url: `/api/machines/${macId}/unload` });
    expect(unload.json<MachineStatusView>().status?.activeModel).toBeNull();
    const again = await ctx.app.inject({ method: 'POST', url: `/api/machines/${macId}/unload` });
    expect(again.json()).toMatchObject({ error: 'nothing_loaded' });

    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });
    expect((await status(macId)).job).toMatchObject({
      state: 'loaded',
      quant: 'Q8_0',
      modelId: 'unsloth/gemma-4-12b-it-GGUF',
    });
  });

  it('rejects an invalid request', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/models/load',
      payload: { machineIds: [], modelId: 'x', quant: null, settings: DEFAULT_LOAD_SETTINGS },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'Pick at least one machine.' });
  });
});
