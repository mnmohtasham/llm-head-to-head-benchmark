import { stat } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/mock';
import {
  sessionStats,
  type ImageConfig,
  type MachineView,
  type PreflightResult,
  type RunPlan,
  type SessionView,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const LINUX_KEY = 'sk-unsloth-img-linux-000000000000000001';
const MAC_KEY = 'sk-unsloth-img-mac-00000000000000000002';
const FLUX = 'unsloth/FLUX.2-klein-9B-GGUF';
const FLUX_FILE = 'FLUX.2-klein-9B-Q4_K_M.gguf';
let linux: RunningMock;
let mac: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;
let macId: string;

async function control(mock: RunningMock, body: unknown) {
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function unsloth(mock: RunningMock, key: string, route: string) {
  const response = await fetch(`${mock.url}${route}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return (await response.json()) as Record<string, unknown>;
}

async function addMachine(name: string, mock: RunningMock, apiKey: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name, baseUrl: mock.url, apiKey },
  });
  return created.json<MachineView>().id;
}

const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

function payload(
  machineIds: string[],
  config: Partial<ImageConfig> = {},
  plan: Partial<RunPlan> = {},
): Record<string, unknown> {
  return {
    workload: 'image',
    machineIds,
    config: {
      model: FLUX,
      ggufFilename: FLUX_FILE,
      preset: 'lighthouse',
      width: 256,
      height: 256,
      steps: 4,
      seed: 7,
      restoreText: false,
      ...config,
    },
    plan: { ...ONE_ROUND, ...plan },
    acknowledgeWarnings: true,
  };
}

const post = (body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/sessions', payload: body });

async function getSession(id: string): Promise<SessionView> {
  return (await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json<SessionView>();
}

async function finished(id: string): Promise<SessionView> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const view = await getSession(id);
    if (view.finishedAt) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the race did not finish');
}

async function race(...args: Parameters<typeof payload>): Promise<SessionView> {
  const response = await post(payload(...args));
  expect(response.statusCode, response.body).toBe(201);
  return finished(response.json<SessionView>().id);
}

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: LINUX_KEY });
  mac = await startMockServer({ profile: 'mac-mlx', apiKey: MAC_KEY });
});
afterAll(async () => {
  await linux.close();
  await mac.close();
});
beforeEach(async () => {
  for (const mock of [linux, mac]) await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  // At 256 by 256, a sixteenth of these: Linux 100 ms a step, the Mac 250 ms.
  await control(linux, { loadMs: 60, image: { loadMs: 150, stepMs: 1600, decodeMs: 1600 } });
  await control(mac, { loadMs: 60, image: { loadMs: 250, stepMs: 4000, decodeMs: 3200 } });
  ctx = await testApp({ runTimings: { imagePollMs: 20 } });
  linuxId = await addMachine('Linux', linux, LINUX_KEY);
  macId = await addMachine('Mac', mac, MAC_KEY);
});
afterEach(async () => {
  await ctx.app.close();
});

describe('pre-flight for images', () => {
  it('notes that the chat model goes, and stops a file that is not on disk', async () => {
    const checked = await ctx.app.inject({
      method: 'POST',
      url: '/api/preflight',
      payload: { workload: 'image', machineIds: [linuxId, macId], config: payload([]).config },
    });
    const issues = checked.json<PreflightResult>().issues;
    expect(issues.map((i) => [i.level, i.code, i.machineId])).toEqual([
      ['note', 'handoff', linuxId],
      ['note', 'handoff', macId],
    ]);
    expect(issues[0]?.text).toBe(
      'Loading the image model unloads unsloth/Qwen3.8-27B-GGUF on Linux. It stays unloaded after the race.',
    );
    // Notes never hold a race back.
    const started = await post({ ...payload([linuxId, macId]), acknowledgeWarnings: false });
    expect(started.statusCode).toBe(201);
    await finished(started.json<SessionView>().id);

    const q8 = await post(payload([linuxId], { ggufFilename: 'FLUX.2-klein-9B-Q8_0.gguf' }));
    expect(q8.statusCode).toBe(400);
    expect(q8.json<{ message: string }>().message).toContain(
      'FLUX.2-klein-9B-Q8_0.gguf is not fully downloaded on Linux.',
    );
  });

  it('lists the image models on disk with their complete files', async () => {
    const answer = await ctx.app.inject({ method: 'GET', url: `/api/machines/${linuxId}/image` });
    const body = answer.json<{ status: { loaded: boolean }; models: unknown[] }>();
    expect(body.status.loaded).toBe(false);
    expect(body.models).toEqual([
      {
        repoId: FLUX,
        displayName: 'FLUX.2-klein-9B-GGUF',
        format: 'gguf',
        files: [{ filename: FLUX_FILE, quant: 'Q4_K_M', sizeBytes: 5_600_000_000 }],
      },
      {
        repoId: 'unsloth/Qwen-Image-2.1-GGUF',
        displayName: 'Qwen-Image-2.1-GGUF',
        format: 'gguf',
        files: [
          { filename: 'Qwen-Image-2.1-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 4_200_000_000 },
        ],
      },
    ]);
  });
});

describe('an image race', () => {
  it('times the steps and the decode, keeps both images, and the faster machine wins', async () => {
    const session = await race([linuxId, macId]);
    expect(session.state).toBe('done');
    const [fast, slow] = [linuxId, macId].map((id) => {
      const run = session.rounds[0]?.runs.find((r) => r.machineId === id);
      expect(run?.state, run?.error ?? '').toBe('done');
      return run;
    });
    const a = fast?.image;
    const b = slow?.image;
    expect(a).toMatchObject({
      width: 256,
      height: 256,
      seed: 7,
      steps: 4,
      totalSteps: 4,
      stored: true,
    });
    // 100 ms a step on Linux and 250 ms on the Mac, read every 20 ms.
    expect(a?.stepsPerSec).toBeGreaterThan(7.5);
    expect(a?.stepsPerSec).toBeLessThan(12.5);
    expect(b?.stepsPerSec).toBeGreaterThan(3);
    expect(b?.stepsPerSec).toBeLessThan(5);
    expect(a?.firstStepMs).toBeGreaterThanOrEqual(95);
    expect(a?.firstStepMs).toBeLessThan(200);
    // The decode is 100 ms, then 20 ms of saving.
    expect(a?.decodeTailMs).toBeGreaterThanOrEqual(100);
    expect(a?.decodeTailMs).toBeLessThan(220);
    expect(a?.totalMs).toBeGreaterThanOrEqual(520);
    expect(a?.loadMs).toBeGreaterThanOrEqual(150);
    expect(a).toMatchObject({
      engine: 'diffusers',
      device: 'cuda',
      dtype: 'bfloat16',
      speedMode: 'off',
    });
    expect(b?.device).toBe('mps');
    expect(a?.timeline.length).toBeGreaterThan(10);

    const png = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/images/${fast?.id}`,
    });
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect(png.rawPayload.readUInt32BE(16)).toBe(256);

    const provenance = session.provenance.find((p) => p.machineId === linuxId);
    expect(provenance?.request).toMatchObject({
      width: 256,
      height: 256,
      steps: 4,
      seed: 7,
      batch_size: 1,
    });
    expect(provenance?.imageAfter).toMatchObject({ repoId: FLUX, speedMode: 'off' });
    expect(provenance?.statusBefore?.activeModel).toBe('unsloth/Qwen3.8-27B-GGUF');

    const stats = sessionStats(session);
    expect(stats.find((row) => row.key === 'stepsPerSec')?.verdict).toMatchObject({
      kind: 'win',
      leader: 0,
    });
    // The image load pushed the chat model out, and nothing brought it back.
    expect((await unsloth(linux, LINUX_KEY, '/api/inference/status')).active_model).toBeNull();

    const md = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export.md`,
    });
    expect(md.body).toContain('| Denoising speed (higher is better) |');
    expect(md.body).toContain('| Engine | diffusers | diffusers |');
    expect(md.body).toContain('| Device | cuda | mps |');
    expect(md.body).toContain('256×256, 4 steps, guidance 0, seed 7, one image per run');
    expect(md.body).toContain('| Chat model afterwards | left unloaded | left unloaded |');

    const removed = await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}` });
    expect(removed.statusCode).toBe(204);
    await expect(stat(path.join(ctx.dataDir, 'images', session.id))).rejects.toThrow();
  });

  it('loads in the warm-up, not in the rounds, and loads the chat model again afterwards', async () => {
    const session = await race([linuxId], { restoreText: true }, { rounds: 2, warmup: true });
    expect(session.warmup?.runs[0]?.image?.loadMs).toBeGreaterThanOrEqual(150);
    expect(session.warmup?.runs[0]?.image?.steps).toBe(2);
    expect(session.rounds.map((r) => r.runs[0]?.image?.loadMs)).toEqual([null, null]);
    const provenance = session.provenance[0];
    expect(provenance?.restore).toMatchObject({
      model: 'unsloth/Qwen3.8-27B-GGUF',
      state: 'loaded',
      error: null,
    });
    const status = await unsloth(linux, LINUX_KEY, '/api/inference/status');
    expect(status.active_model).toBe('unsloth/Qwen3.8-27B-GGUF');
    // Loading the chat model pushed the image model out in turn.
    expect((await unsloth(linux, LINUX_KEY, '/api/inference/images/status')).loaded).toBe(false);
  });

  it('reports a load that fails, and still brings the chat model back', async () => {
    await control(linux, { image: { failNextLoad: 'Not enough memory for the transformer.' } });
    const session = await race([linuxId], { restoreText: true });
    const run = session.rounds[0]?.runs[0];
    expect(run?.state).toBe('failed');
    expect(run?.error).toBe('Not enough memory for the transformer.');
    expect(session.provenance[0]?.restore?.state).toBe('loaded');
  });

  it('cancels a generation in flight on the machine too', async () => {
    await control(linux, { image: { stepMs: 16_000 } });
    const started = await post(payload([linuxId]));
    const id = started.json<SessionView>().id;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const progress = await unsloth(linux, LINUX_KEY, '/api/inference/images/generate-progress');
      if (progress.active === true) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cancelled = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    const view = await finished(id);
    expect(view.state).toBe('cancelled');
    expect(view.rounds[0]?.runs[0]?.state).toBe('cancelled');
    // Like Unsloth, the machine stops at the end of the step it is on.
    let active = true;
    const until = Date.now() + 3000;
    while (active && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      active =
        (await unsloth(linux, LINUX_KEY, '/api/inference/images/generate-progress')).active ===
        true;
    }
    expect(active).toBe(false);
  });
});
