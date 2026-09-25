import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { startMockServer, type RunningMock } from '@duel/mock';
import {
  SseParser,
  type MachineView,
  type SessionView,
  type TelemetryStreamMessage,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-telemetry-00000000000000000001';
let mock: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let machineId: string;

async function control(body: unknown) {
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function base(): Promise<string> {
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
}

/** Reads the telemetry stream until `until` says stop, or the time runs out. */
async function watch(
  url: string,
  until: (messages: TelemetryStreamMessage[]) => boolean,
  timeoutMs = 5000,
): Promise<TelemetryStreamMessage[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const messages: TelemetryStreamMessage[] = [];
  try {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body!.getReader();
    const parser = new SseParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(value, 0)) {
        if (message.kind === 'data')
          messages.push(JSON.parse(message.data) as TelemetryStreamMessage);
      }
      if (until(messages)) break;
    }
  } catch {
    // Timed out: the caller checks what arrived.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return messages;
}

async function hardwareReads(): Promise<number> {
  const log = (await (await fetch(`${mock.url}/__mock/requests`)).json()) as Array<{
    path: string;
  }>;
  return log.filter((entry) => entry.path === '/api/train/hardware').length;
}

beforeAll(async () => {
  mock = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(async () => {
  await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  await control({ latencyMs: 0 });
  ctx = await testApp();
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name: 'Linux', baseUrl: mock.url, apiKey: KEY },
  });
  machineId = created.json<MachineView>().id;
});
afterEach(async () => {
  await ctx.app.close();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

describe('the telemetry poller', () => {
  it('polls a machine while someone watches, and stops when nobody does', async () => {
    const url = `${await base()}/api/telemetry/stream?machines=${machineId}`;
    const messages = await watch(url, (m) => m.filter((x) => x.type === 'sample').length >= 3);
    const samples = messages.filter((m) => m.type === 'sample');
    expect(samples.length).toBeGreaterThanOrEqual(3);
    const first = samples[0]?.type === 'sample' ? samples[0].sample : null;
    expect(first).toMatchObject({ vramTotalGb: 31.84, ramTotalGb: expect.any(Number) });
    expect(first?.gpuPowerW).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await hardwareReads();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await hardwareReads()).toBe(after);
  });

  it('backs off while a machine fails, and recovers when it answers again', async () => {
    const failing = { status: 500, body: { detail: 'sensor error' } };
    await control({ routes: { '/api/train/hardware': failing, '/api/system': failing } });
    const url = `${await base()}/api/telemetry/stream?machines=${machineId}`;
    const recovery = setTimeout(
      () => void control({ routes: { '/api/train/hardware': null, '/api/system': null } }),
      600,
    );
    const messages = await watch(url, (m) => m.some((x) => x.type === 'sample'));
    clearTimeout(recovery);
    const waits = messages
      .flatMap((m) => (m.type === 'status' ? m.statuses : []))
      .filter((s) => s.state === 'backoff')
      .map((s) => s.retryInMs);
    // 50, 100, 200, then capped at 200.
    expect(waits.slice(0, 3)).toEqual([50, 100, 200]);
    expect(messages.some((m) => m.type === 'sample')).toBe(true);
    const last = messages.filter((m) => m.type === 'status').at(-1);
    expect(last?.type === 'status' ? last.statuses[0]?.state : null).toBe('ok');
  });

  it('stops everything with the off switch, which survives a restart', async () => {
    const off = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { telemetry: false },
    });
    expect(off.json()).toEqual({ telemetry: false });
    const url = `${await base()}/api/telemetry/stream?machines=${machineId}`;
    const messages = await watch(url, () => false, 400);
    expect(messages.filter((m) => m.type === 'sample')).toEqual([]);
    expect(messages[0]).toMatchObject({ type: 'status', enabled: false });
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/settings' })).json()).toEqual({
      telemetry: false,
    });
  });
});

describe('telemetry in a race', () => {
  const race = async (): Promise<SessionView> => {
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        workload: 'text',
        machineIds: [machineId],
        config: {
          prompt: 'Why is the sky blue?',
          maxTokens: 64,
          thinking: false,
          reasoningEffort: null,
        },
        plan: { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' },
      },
    });
    const { id } = started.json<SessionView>();
    for (let i = 0; i < 300; i += 1) {
      const view = (
        await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      ).json<SessionView>();
      if (view.finishedAt) return view;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('the race did not finish');
  };

  it('records samples around each run, with a baseline, and adds up its energy', async () => {
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir, runTimings: { telemetryBaselineMs: 400 } });
    await control({ stream: { startupMs: 100, tokenMs: 25, answerTokens: 40 } });
    const view = await race();
    expect(view.telemetry).toEqual({ enabled: true });
    const telemetry = view.rounds[0]?.runs[0]?.telemetry;
    expect(telemetry?.samples.length).toBeGreaterThan(10);
    const energy = telemetry?.energy;
    expect(energy?.energyJ).toBeGreaterThan(0);
    expect(energy?.tokensPerJoule).toBeGreaterThan(0);
    // The fake GPU works harder while it streams than when it idles.
    expect(energy?.peakGpuPct).toBeGreaterThan(40);
    const idle = telemetry?.samples[0]?.gpuUtilPct ?? 100;
    expect(idle).toBeLessThan(20);
  });

  it('records nothing when telemetry is off', async () => {
    await ctx.app.inject({ method: 'PUT', url: '/api/settings', payload: { telemetry: false } });
    const view = await race();
    expect(view.telemetry).toEqual({ enabled: false });
    expect(view.rounds[0]?.runs[0]?.telemetry).toBeNull();
  });
});
