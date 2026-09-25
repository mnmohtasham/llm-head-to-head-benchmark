import { startMockServer, type RunningMock } from '@duel/mock';
import {
  sessionStats,
  type MachineStatusView,
  type MachineView,
  type PreflightResult,
  type RunPlan,
  type SessionView,
  type TextConfig,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-tput-linux-00000000000000001';
let linux: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;

async function control(body: unknown) {
  await fetch(`${linux.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

function payload(config: Partial<TextConfig> = {}) {
  return {
    workload: 'text',
    machineIds: [linuxId],
    config: {
      prompt: 'Why is the sky blue?',
      maxTokens: 1024,
      thinking: false,
      reasoningEffort: null,
      mode: 'throughput',
      concurrency: 4,
      ...config,
    },
    plan: ONE_ROUND,
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

async function race(config: Partial<TextConfig> = {}): Promise<SessionView> {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: payload(config),
  });
  expect(started.statusCode, started.body).toBe(201);
  return finished(started.json<SessionView>().id);
}

async function preflight(config: Partial<TextConfig> = {}) {
  const { workload, machineIds, config: body } = payload(config);
  const answer = await ctx.app.inject({
    method: 'POST',
    url: '/api/preflight',
    payload: { workload, machineIds, config: body },
  });
  return answer.json<PreflightResult>().issues;
}

/** Loads the mock's model with more slots through pre-flight's shortcut, and waits. */
async function reloadWithSlots(slots: number) {
  const answer = await ctx.app.inject({
    method: 'POST',
    url: `/api/machines/${linuxId}/reload-slots`,
    payload: { slots },
  });
  expect(answer.statusCode, answer.body).toBe(202);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = (
      await ctx.app.inject({ method: 'GET', url: `/api/machines/${linuxId}/status` })
    ).json<MachineStatusView>();
    if (status.job?.state === 'loaded' && status.status?.parallelSlots === slots) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the reload did not finish');
}

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
});
afterAll(async () => {
  await linux.close();
});
beforeEach(async () => {
  await fetch(`${linux.url}/__mock/reset`, { method: 'POST' });
  await control({
    loadMs: 50,
    stream: { startupMs: 60, tokenMs: 8, jitterMs: 0, answerTokens: 40, slotSlowdown: 0.3 },
  });
  ctx = await testApp({ runTimings: { queuePollMs: 25 } });
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name: 'Linux', baseUrl: linux.url, apiKey: KEY },
  });
  linuxId = created.json<MachineView>().id;
});
afterEach(async () => {
  await ctx.app.close();
});

describe('throughput mode', () => {
  it('stops more requests than slots, and the shortcut reloads with enough, keeping the rest', async () => {
    const before = await preflight();
    expect(before.map((i) => [i.level, i.code])).toEqual([['error', 'slots']]);
    expect(before[0]?.text).toBe(
      'Linux serves 1 request at once, so 3 of the 4 would wait in the queue, which measures the queue rather than the machine. Reload its model with 4 slots.',
    );
    const status = await reloadWithSlots(4);
    expect(status.status).toMatchObject({
      activeModel: 'unsloth/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
      parallelSlots: 4,
    });
    expect(await preflight()).toEqual([]);
    // Latency mode never looks at slots.
    expect(await preflight({ mode: 'latency', concurrency: 8 })).toEqual([]);
  });

  it('sends every request at once and adds them up; more at once means more in total', async () => {
    await reloadWithSlots(4);
    const single = await race({ concurrency: 1 });
    const four = await race({ concurrency: 4 });
    const one = single.rounds[0]?.runs[0]?.throughput;
    const all = four.rounds[0]?.runs[0];
    const t = all?.throughput;
    expect(all?.state).toBe('done');
    expect(t?.concurrency).toBe(4);
    expect(t?.requests.map((r) => r.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(t?.requests.every((r) => r.outputTokens === 40)).toBe(true);
    expect(Math.max(...(t?.requests.map((r) => r.sendOffsetMs) ?? [99]))).toBeLessThan(5);
    expect(t?.outputTokens).toBe(160);
    // Each token takes 1.9 times as long with four busy slots, so the total is about 2.1 times one.
    const gain = (t?.aggregateTokPerSec ?? 0) / (one?.aggregateTokPerSec ?? 1);
    expect(gain).toBeGreaterThan(1.6);
    expect(gain).toBeLessThan(2.8);
    expect(t?.perRequestTokPerSec).toBeLessThan(one?.perRequestTokPerSec ?? 0);
    expect(t?.ttftMedianMs).toBeGreaterThanOrEqual(60);
    expect(t?.ttftP95Ms).toBeGreaterThanOrEqual(t?.ttftMedianMs ?? 0);
    expect(t?.queue).toMatchObject({ capacity: 4, maxQueued: 0, queuedMs: 0 });
    expect(t?.queue?.maxActive).toBeGreaterThanOrEqual(3);
    // The first request streams into the pane as in latency mode.
    expect(all?.answer.length).toBeGreaterThan(0);
    expect(all?.client?.outputTokens).toBe(40);

    const stats = sessionStats(four);
    expect(stats[0]?.key).toBe('aggregate');
    const md = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${four.id}/export.md` });
    expect(md.body).toContain('| Aggregate output speed (higher is better) |');
    expect(md.body).toContain('- Throughput: 4 identical requests sent at once');
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/sessions/${four.id}/export.csv` });
    expect(csv.body).toContain('Linux aggregate (tok/s)');
  });

  it('counts the time requests wait for a slot when the queue fills', async () => {
    await reloadWithSlots(4);
    // A machine that says four slots but serves two at a time: two requests queue.
    await control({ slotCapacity: 2 });
    const session = await race({ concurrency: 4 });
    const t = session.rounds[0]?.runs[0]?.throughput;
    expect(t?.requests.every((r) => r.state === 'done')).toBe(true);
    expect(t?.queue?.maxQueued).toBe(2);
    expect(t?.queue?.maxActive).toBe(2);
    expect(t?.queue?.queuedMs).toBeGreaterThan(200);
    // The two that waited reached their first token a whole request later.
    expect(t?.ttftP95Ms).toBeGreaterThan((t?.ttftMedianMs ?? 0) + 200);
  });

  it('cancels every request of the batch', async () => {
    await reloadWithSlots(4);
    await control({ stream: { tokenMs: 200 } });
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: payload(),
    });
    const id = started.json<SessionView>().id;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` });
    const view = await finished(id);
    const run = view.rounds[0]?.runs[0];
    expect(run?.state).toBe('cancelled');
    expect(run?.throughput?.requests.map((r) => r.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    // Each stream stops at its next token and gives its slot back.
    let active = -1;
    const until = Date.now() + 3000;
    while (active !== 0 && Date.now() < until) {
      const monitor = (await (
        await fetch(`${linux.url}/api/inference/monitor`, {
          headers: { authorization: `Bearer ${KEY}` },
        })
      ).json()) as { queue: { active: number } };
      active = monitor.queue.active;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(active).toBe(0);
  });
});
