import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/mock';
import {
  computeClientMetrics,
  expandEvents,
  SseParser,
  type MachineView,
  type PreflightResult,
  type RunPlan,
  type RunView,
  type SessionStreamMessage,
  type SessionSummary,
  type SessionView,
  type StoredSession,
  type TextConfig,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const LINUX_KEY = 'sk-unsloth-race-linux-00000000000000001';
const MAC_KEY = 'sk-unsloth-race-mac-0000000000000000002';
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

async function addMachine(name: string, mock: RunningMock, apiKey: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name, baseUrl: mock.url, apiKey },
  });
  return created.json<MachineView>().id;
}

/** One round, no warm-up, no pause: the phase 4 race, unless a test asks for more. */
const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

async function startSession(
  machineIds: string[],
  config: Partial<TextConfig> = {},
  plan: Partial<RunPlan> = {},
): Promise<SessionView> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      workload: 'text',
      machineIds,
      config: {
        prompt: 'Why is the sky blue?',
        maxTokens: 1024,
        thinking: true,
        reasoningEffort: null,
        ...config,
      },
      plan: { ...ONE_ROUND, ...plan },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<SessionView>();
}

function sessionPayload(
  machineIds: string[],
  config: Partial<TextConfig> = {},
  plan: Partial<RunPlan> = {},
): Record<string, unknown> {
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
    plan: { ...ONE_ROUND, ...plan },
  };
}

const post = (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/sessions', payload });

async function getSession(id: string): Promise<SessionView> {
  return (await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json<SessionView>();
}

async function finished(id: string): Promise<SessionView> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const view = await getSession(id);
    if (view.finishedAt) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the race did not finish');
}

function runOf(session: SessionView, machineId: string): RunView {
  const run = session.rounds[0]?.runs.find((r) => r.machineId === machineId);
  if (!run) throw new Error(`no run for ${machineId}`);
  return run;
}

/** Runs one prompt on the Linux mock alone and returns its run. */
async function single(config: Partial<TextConfig> = {}): Promise<RunView> {
  const session = await finished((await startSession([linuxId], config)).id);
  return runOf(session, linuxId);
}

async function monitorOf(mock: RunningMock, key: string) {
  const response = await fetch(`${mock.url}/api/inference/monitor`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return (await response.json()) as { entries: Array<Record<string, unknown>> };
}

const FAST = { startupMs: 50, tokenMs: 3, jitterMs: 0, reasoningTokens: 8, answerTokens: 16 };

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

describe('a run on one machine', () => {
  it('measures the time to first token within 20 ms of the mock’s startup delay', async () => {
    await control(linux, { stream: { startupMs: 300 } });
    const run = await single();
    expect(run.state).toBe('done');
    expect(run.client?.ttftMs).toBeGreaterThanOrEqual(300);
    expect(run.client?.ttftMs).toBeLessThan(320);
  });

  it('agrees with Unsloth’s own decode speed within 10 percent, and finds its monitor row', async () => {
    await control(linux, { stream: { tokenMs: 20, reasoningTokens: 20, answerTokens: 40 } });
    const run = await single();
    const client = run.client?.decodeTokPerSec ?? 0;
    const server = run.server?.timings?.predictedPerSecond ?? 0;
    expect(client).toBeGreaterThan(35);
    expect(Math.abs(client - server) / server).toBeLessThan(0.1);
    expect(run.server?.monitor).toMatchObject({ completionTokens: 60, stopReason: 'stop' });
    expect(run.server?.monitor?.ttftMs).toBeLessThanOrEqual(run.client?.ttftMs ?? 0);
  });

  it('keeps thinking and answer apart, and records the model before and after', async () => {
    const run = await single();
    expect(run.reasoning.trim().split(/\s+/)).toHaveLength(8);
    expect(run.answer.trim().split(/\s+/)).toHaveLength(16);
    expect(run.client).toMatchObject({
      outputTokens: 24,
      finishReason: 'stop',
      sawDone: true,
      tokensEstimated: false,
    });
    expect(run.client?.thinkingMs).toBeGreaterThan(0);
    expect(run).toMatchObject({
      modelBefore: 'unsloth/Qwen3.8-27B-GGUF',
      modelAfter: 'unsloth/Qwen3.8-27B-GGUF',
      sendOffsetMs: 0,
    });
    expect(run.loopLagMs?.max).toBeGreaterThanOrEqual(0);
  });

  it('sends no thinking when it is off', async () => {
    const run = await single({ thinking: false });
    expect(run.reasoning).toBe('');
    expect(run.client?.firstReasoningMs).toBeNull();
    expect(run.client?.firstAnswerMs).toBe(run.client?.ttftMs);
  });

  it('ignores UI frames and counts keep-alives', async () => {
    await control(linux, {
      stream: { startupMs: 160, keepaliveEveryMs: 30, toolFrames: true },
    });
    const run = await single();
    expect(run.state).toBe('done');
    expect(run.client?.keepalives).toBeGreaterThanOrEqual(3);
    expect(run.answer).not.toContain('Searching');
  });

  it('stops the race when Unsloth cuts the prompt to fit the context', async () => {
    await control(linux, { stream: { truncated: true, tokenMs: 20 } });
    const session = await finished((await startSession([linuxId, macId], {}, { rounds: 3 })).id);
    expect(session.state).toBe('failed');
    expect(session.error).toMatch(/^Unsloth cut the prompt on Linux to fit its context/);
    expect(session.rounds).toHaveLength(1);
    expect(runOf(session, linuxId)).toMatchObject({
      state: 'failed',
      error: 'Unsloth cut the prompt to fit the context.',
    });
    expect(runOf(session, macId).error).toBe('Stopped because Unsloth cut the prompt on Linux.');
    expect(session.rounds[0]?.flags.map((f) => f.kind)).toContain('truncated');
  });
});

describe('when a run goes wrong', () => {
  it('stops a silent stream at the idle timeout', async () => {
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir, runTimings: { idleTimeoutMs: 400 } });
    await control(linux, { stream: { stallAfterTokens: 3 } });
    const run = await single();
    expect(run).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/sent nothing for 0\.4 s/),
    });
    expect(run.client?.chunks).toBe(3);
  });

  it('surfaces an error frame from Unsloth', async () => {
    await control(linux, { stream: { errorAfterTokens: 3 } });
    expect(await single()).toMatchObject({
      state: 'failed',
      error: 'Unsloth reported: Context size has been exceeded.',
    });
  });

  it('explains a dropped connection', async () => {
    await control(linux, { stream: { disconnectAfterTokens: 3 } });
    const run = await single();
    expect(run.state).toBe('failed');
    expect(run.error).toMatch(/^The stream from 127\.0\.0\.1:\d+ broke after 3 chunks/);
  });

  it('will not start on a machine with no model: pre-flight says why', async () => {
    await fetch(`${linux.url}/api/inference/unload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LINUX_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model_path: 'unsloth/Qwen3.8-27B-GGUF' }),
    });
    const response = await post(sessionPayload([linuxId, macId]));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'preflight',
      message: 'No model is loaded on Linux. Load one on the Models tab.',
      issues: [{ level: 'error', code: 'no-model', machineId: linuxId }],
    });
  });

  it('rejects an invalid request, an unknown machine and a machine picked twice', async () => {
    const post = (payload: Record<string, unknown>) =>
      ctx.app.inject({ method: 'POST', url: '/api/sessions', payload });
    const config = { prompt: 'Hi', maxTokens: 10, thinking: true, reasoningEffort: null };
    expect(
      (
        await post({
          workload: 'text',
          machineIds: [linuxId],
          config: { ...config, prompt: ' ', maxTokens: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect((await post({ workload: 'text', machineIds: [], config })).statusCode).toBe(400);
    expect(
      (await post({ workload: 'text', machineIds: [linuxId, linuxId], config })).json(),
    ).toMatchObject({ message: 'Pick each machine only once.' });
    expect(
      (
        await post({
          workload: 'text',
          machineIds: ['0f0f0f0f-0000-4000-8000-000000000000'],
          config,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('a race between two machines', () => {
  it('sends identical requests within 5 ms of each other, and the faster machine wins', async () => {
    await control(linux, { stream: { tokenMs: 8, reasoningTokens: 10, answerTokens: 30 } });
    await control(mac, { stream: { tokenMs: 20, reasoningTokens: 10, answerTokens: 30 } });
    const session = await finished((await startSession([linuxId, macId])).id);
    expect(session.state).toBe('done');
    const round = session.rounds[0];
    expect(round?.sendSkewMs).toBeGreaterThanOrEqual(0);
    expect(round?.sendSkewMs).toBeLessThan(5);
    const fast = runOf(session, linuxId);
    const slow = runOf(session, macId);
    expect([fast.state, slow.state]).toEqual(['done', 'done']);
    expect(fast.client?.decodeTokPerSec ?? 0).toBeGreaterThan(slow.client?.decodeTokPerSec ?? 0);

    // The same body everywhere except the model name.
    const [a, b] = session.provenance.map((p) => p.request ?? {});
    const strip = (body: Record<string, unknown>) => ({ ...body, model: '' });
    expect(strip(a ?? {})).toEqual(strip(b ?? {}));
    expect(session.provenance.map((p) => p.statusBefore?.quant)).toEqual(['Q4_K_M', 'Q4_K_M']);
  });

  it('keeps going when one machine dies mid-race, with partial numbers for the dead one', async () => {
    const doomedKey = 'sk-unsloth-race-doomed-0000000000000003';
    const doomed = await startMockServer({ profile: 'mac-mlx', apiKey: doomedKey });
    await control(doomed, { latencyMs: 0, stream: { ...FAST, tokenMs: 30, answerTokens: 200 } });
    await control(linux, { stream: { tokenMs: 10, answerTokens: 60 } });
    const doomedId = await addMachine('Doomed', doomed, doomedKey);
    const { id } = await startSession([linuxId, doomedId]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    doomed.app.server.closeAllConnections();
    await doomed.close();
    const session = await finished(id);
    expect(session.state).toBe('done');
    expect(runOf(session, linuxId).state).toBe('done');
    const dead = runOf(session, doomedId);
    expect(dead.state).toBe('failed');
    expect(dead.error).toMatch(/broke after \d+ chunks/);
    expect(dead.client?.chunks).toBeGreaterThan(0);
    expect(dead.client?.ttftMs).not.toBeNull();
  });

  it('cancels every machine, and both mocks stop generating', async () => {
    for (const mock of [linux, mac]) {
      await control(mock, { stream: { tokenMs: 40, answerTokens: 400 } });
    }
    const { id } = await startSession([linuxId, macId]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cancelled = (
      await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` })
    ).json<SessionView>();
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.rounds[0]?.runs.map((r) => r.state)).toEqual(['cancelled', 'cancelled']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [mock, key] of [
      [linux, LINUX_KEY],
      [mac, MAC_KEY],
    ] as const) {
      const row = (await monitorOf(mock, key)).entries[0];
      expect(row?.status).toBe('cancelled');
      expect(Number(row?.completion_tokens)).toBeLessThan(400);
    }
  });

  it('runs one race at a time', async () => {
    await control(linux, { stream: { tokenMs: 30, answerTokens: 100 } });
    const { id } = await startSession([linuxId]);
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        workload: 'text',
        machineIds: [macId],
        config: { prompt: 'Hi', maxTokens: 10, thinking: true, reasoningEffort: null },
        plan: ONE_ROUND,
      },
    });
    expect(second.statusCode).toBe(409);
    await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` });
  });

  it('needs racing anyway when pre-flight warns, and then races', async () => {
    await fetch(`${linux.url}/api/inference/load`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LINUX_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model_path: 'unsloth/Qwen3.8-27B-GGUF',
        gguf_variant: 'UD-IQ2_XXS',
        max_seq_length: 0,
      }),
    });
    const refused = await post(sessionPayload([linuxId, macId]));
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{ error: string; issues: Array<{ level: string; code: string }> }>();
    expect(body.error).toBe('preflight_warnings');
    expect(body.issues.map((i) => `${i.level}:${i.code}`)).toContain('warning:quant');
    expect(body.issues.every((i) => i.level === 'warning')).toBe(true);
    const accepted = await post({ ...sessionPayload([linuxId, macId]), acknowledgeWarnings: true });
    expect(accepted.statusCode).toBe(201);
    await finished(accepted.json<SessionView>().id);
  });
});

describe('pre-flight and presets', () => {
  it('counts the prompt on each machine and stops one that does not fit the context', async () => {
    await fetch(`${linux.url}/api/inference/load`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LINUX_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model_path: 'unsloth/Qwen3.8-27B-GGUF',
        gguf_variant: 'Q4_K_M',
        max_seq_length: 4096,
      }),
    });
    const check = await ctx.app.inject({
      method: 'POST',
      url: '/api/preflight',
      payload: {
        machineIds: [linuxId, macId],
        config: { preset: 'long-8k', maxTokens: 256, thinking: false, reasoningEffort: null },
      },
    });
    const result = check.json<PreflightResult>();
    expect(result.promptWords).toBeGreaterThan(6000);
    // The nonce line adds a few words to what the machines count.
    expect(result.promptTokens[linuxId]).toBeGreaterThan(result.promptWords);
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([
      expect.objectContaining({ code: 'no-fit', machineId: linuxId }),
    ]);
    const start = await post(
      sessionPayload([linuxId, macId], { preset: 'long-8k', prompt: '', maxTokens: 256 }),
    );
    expect(start.statusCode).toBe(400);
  });

  it('lists the presets with their sizes', async () => {
    const { presets } = (await ctx.app.inject({ method: 'GET', url: '/api/presets' })).json<{
      presets: Array<{ id: string; words: number; preview: string }>;
    }>();
    expect(presets.map((p) => p.id)).toEqual([
      'short',
      'long-8k',
      'long-32k',
      'puzzle',
      'code',
      'fixed-length',
    ]);
    const long = presets.find((p) => p.id === 'long-32k');
    expect(long?.words).toBeGreaterThan(25_000);
    expect(long?.preview).toContain('Summarize the argument of the text above');
  });

  it('warm prefill reuses the cache from round two; cold never does, on either kind of machine', async () => {
    const run = async (prefill: 'warm' | 'cold') =>
      finished(
        (
          await startSession(
            [linuxId, macId],
            { preset: 'long-8k', prompt: '', maxTokens: 40, thinking: false, prefill },
            { rounds: 3 },
          )
        ).id,
      );
    const warm = await run('warm');
    const cachedWarm = warm.rounds.map((round) =>
      round.runs.map((r) => r.client?.cachedTokens ?? 0),
    );
    expect(cachedWarm[0]).toEqual([0, 0]);
    for (const round of cachedWarm.slice(1))
      for (const cached of round) expect(cached).toBeGreaterThan(64);
    expect(warm.rounds[1]?.flags.map((f) => f.kind)).toEqual(['cache', 'cache']);

    const cold = await run('cold');
    for (const round of cold.rounds) {
      expect(round.nonce).toMatch(/^[0-9a-f]{12}$/);
      // The fixed start of the nonce line can match, like a chat template: under the threshold.
      for (const run of round.runs) expect(run.client?.cachedTokens ?? 0).toBeLessThan(64);
      expect(round.flags.filter((f) => f.kind === 'cache')).toEqual([]);
    }
    expect(new Set(cold.rounds.map((round) => round.nonce)).size).toBe(3);
    // The seed goes out with cold prefill only.
    expect(cold.provenance[0]?.request?.seed).toBe(42);
    expect(warm.provenance[0]?.request?.seed).toBeUndefined();
  });

  it('fixed length: every machine must stop on length, or the round is flagged', async () => {
    const fixed = { preset: 'fixed-length' as const, prompt: '', maxTokens: 10, thinking: false };
    const even = await finished((await startSession([linuxId, macId], fixed)).id);
    expect(even.rounds[0]?.runs.map((r) => r.client?.finishReason)).toEqual(['length', 'length']);
    expect(even.rounds[0]?.flags).toEqual([]);

    await control(mac, { stream: { answerTokens: 5 } });
    const uneven = await finished((await startSession([linuxId, macId], fixed)).id);
    expect(uneven.rounds[0]?.flags).toEqual([
      expect.objectContaining({ kind: 'length', machineId: macId }),
    ]);
  });
});

describe('saved races', () => {
  it('survive a restart: listed, reopened whole, with raw events and without keys', async () => {
    const { id } = await startSession([linuxId, macId]);
    const done = await finished(id);
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });

    const list = (await ctx.app.inject({ method: 'GET', url: '/api/sessions' })).json<{
      sessions: SessionSummary[];
    }>().sessions;
    expect(list.map((s) => s.id)).toEqual([id]);
    expect(list[0]?.machines.map((m) => [m.name, m.state])).toEqual([
      ['Linux', 'done'],
      ['Mac', 'done'],
    ]);
    const reopened = await getSession(id);
    expect(reopened).toEqual(done);
    expect(reopened.provenance.map((p) => p.statusBefore?.backend)).toEqual(['gguf', 'gguf']);

    const text = await readFile(path.join(ctx.dataDir, 'sessions', `${id}.json`), 'utf8');
    expect(text).not.toContain(LINUX_KEY);
    expect(text).not.toContain(MAC_KEY);
    const stored = JSON.parse(text) as StoredSession;
    expect(stored.schemaVersion).toBe(6);
    const run = stored.rounds[0]?.runs[0];
    const raw = run?.raw;
    expect(raw?.events.length).toBeGreaterThan(20);
    // The raw events give back the same numbers.
    const again = computeClientMetrics({
      requestAt: 0,
      headersAt: raw?.headersAtMs ?? null,
      endAt: raw?.endAtMs ?? 0,
      events: expandEvents(raw?.events ?? []),
    });
    expect(again.outputTokens).toBe(run?.client?.outputTokens);
    expect(again.ttftMs).toBeCloseTo(run?.client?.ttftMs ?? 0, 1);
  });

  it('marks a race that was running when Model Duel stopped as interrupted', async () => {
    const { id } = await startSession([linuxId]);
    await finished(id);
    const file = path.join(ctx.dataDir, 'sessions', `${id}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as StoredSession;
    stored.state = 'running';
    stored.finishedAt = null;
    const run = stored.rounds[0]?.runs[0];
    if (run) {
      run.finishedAt = null;
      run.state = 'streaming';
    }
    await writeFile(file, JSON.stringify(stored));
    await writeFile(path.join(ctx.dataDir, 'sessions', 'not-a-session.json'), '{');
    await writeFile(
      path.join(ctx.dataDir, 'sessions', '0f0f0f0f-0000-4000-8000-000000000000.json'),
      '{ broken',
    );
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });
    const reopened = await getSession(id);
    expect(reopened).toMatchObject({
      state: 'interrupted',
      error: 'Model Duel stopped before this race finished.',
    });
    expect(reopened.rounds[0]?.runs[0]?.state).toBe('failed');
  });

  it('deletes a finished race, but not a running one', async () => {
    const { id } = await startSession([linuxId]);
    const busy = await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${id}` });
    expect(busy.statusCode).toBe(409);
    await finished(id);
    const gone = await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${id}` });
    expect(gone.statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })).statusCode).toBe(
      404,
    );
    expect(
      (await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })).statusCode,
    ).toBe(404);
  });
});

describe('the event stream to the browser', () => {
  async function collect(url: string): Promise<SessionStreamMessage[]> {
    const response = await fetch(url);
    const reader = response.body!.getReader();
    const parser = new SseParser();
    const messages: SessionStreamMessage[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(value, 0)) {
        if (message.kind === 'data') {
          messages.push(JSON.parse(message.data) as SessionStreamMessage);
        }
      }
    }
    return messages;
  }

  async function listen(): Promise<string> {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    return `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  }

  it('resumes from a snapshot mid-race, and the text adds up for every machine', async () => {
    const base = await listen();
    for (const mock of [linux, mac]) await control(mock, { stream: { tokenMs: 15 } });
    const { id } = await startSession([linuxId, macId]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const messages = await collect(`${base}/api/sessions/${id}/stream`);
    const first = messages[0];
    const last = messages[messages.length - 1];
    expect(first?.type).toBe('snapshot');
    expect(last?.type).toBe('finished');
    if (first?.type !== 'snapshot' || last?.type !== 'finished') return;
    // Joined mid-race: some text had already arrived.
    const already = first.session.rounds[0]?.runs.map((r) => r.reasoning + r.answer) ?? [];
    expect(already.some((text) => text.length > 0)).toBe(true);
    expect(messages.filter((m) => m.type === 'run')).toHaveLength(2);

    for (const machineId of [linuxId, macId]) {
      let text = first.session.rounds[0]?.runs.find((r) => r.machineId === machineId);
      let answer = text?.answer ?? '';
      for (const message of messages) {
        if (message.type === 'delta') {
          answer += message.runs.find((r) => r.machineId === machineId)?.answer ?? '';
        }
      }
      text = runOf(last.session, machineId);
      expect(answer).toBe(text.answer);
    }

    const replay = await collect(`${base}/api/sessions/${id}/stream`);
    expect(replay.map((m) => m.type)).toEqual(['snapshot', 'finished']);
  });
});

describe('rounds', () => {
  it('warms up, then runs three rounds with an RTT before each and a pause between them', async () => {
    const session = await finished(
      (await startSession([linuxId, macId], {}, { rounds: 3, warmup: true, settleMs: 150 })).id,
    );
    expect(session.state).toBe('done');
    expect(session.warmup?.runs.map((r) => r.state)).toEqual(['done', 'done']);
    expect(session.warmup?.runs[0]?.prompt).toBe('Reply with the single word: ready.');
    expect(session.rounds.map((r) => r.index)).toEqual([0, 1, 2]);
    for (const round of session.rounds) {
      expect(round.runs.map((r) => r.state)).toEqual(['done', 'done']);
      for (const run of round.runs) {
        expect(run.rtt?.samplesMs).toHaveLength(3);
        expect(run.rtt?.medianMs).toBeGreaterThanOrEqual(0);
      }
      expect(round.sendSkewMs).toBeLessThan(5);
    }
    const gaps = session.rounds
      .slice(1)
      .map(
        (round, i) =>
          Date.parse(round.startedAt ?? '') - Date.parse(session.rounds[i]?.finishedAt ?? ''),
      );
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(140);
    expect(session.progress).toEqual({ phase: 'finished', round: null });

    // The results log counts rounds and gives medians, never the warm-up.
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/sessions' })).json<{
      sessions: SessionSummary[];
    }>().sessions;
    expect(list[0]?.rounds).toBe(3);
    expect(list[0]?.machines.every((m) => m.decodeTokPerSec !== null)).toBe(true);
  });

  it('takes turns in ABBA order when sequential, one machine at a time', async () => {
    const session = await finished(
      (await startSession([linuxId, macId], {}, { rounds: 3, sequencing: 'sequential' })).id,
    );
    expect(session.rounds.map((r) => r.order)).toEqual([
      [linuxId, macId],
      [macId, linuxId],
      [linuxId, macId],
    ]);
    expect(session.rounds.every((r) => r.sendSkewMs === null)).toBe(true);
    // The second machine starts only after the first one finished, by Unsloth's own clocks.
    const linuxRows = (await monitorOf(linux, LINUX_KEY)).entries.filter((e) =>
      String(e.endpoint).includes('chat'),
    );
    const macRows = (await monitorOf(mac, MAC_KEY)).entries.filter((e) =>
      String(e.endpoint).includes('chat'),
    );
    const firstLinux = linuxRows[linuxRows.length - 1];
    const firstMac = macRows[macRows.length - 1];
    expect(Number(firstMac?.started_at)).toBeGreaterThanOrEqual(Number(firstLinux?.finished_at));
  });

  it('stops during the pause between rounds when cancelled', async () => {
    const { id } = await startSession([linuxId], {}, { rounds: 3, settleMs: 5000 });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await getSession(id)).progress.phase === 'settling') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const started = Date.now();
    const cancelled = (
      await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` })
    ).json<SessionView>();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.rounds).toHaveLength(1);
    expect(cancelled.rounds[0]?.runs[0]?.state).toBe('done');
  });

  it('opens a race saved by phase 4, in the version 1 format', async () => {
    const source = new URL('../../fixtures/sessions/phase4-race-v1.json', import.meta.url);
    const original = JSON.parse(await readFile(source, 'utf8')) as StoredSession;
    await copyFile(source, path.join(ctx.dataDir, 'sessions', `${original.id}.json`));
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });
    const view = await getSession(original.id);
    expect(view.schemaVersion).toBe(6);
    expect(view.workload).toBe('text');
    expect(view.plan).toEqual({ rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' });
    expect(view.warmup).toBeNull();
    expect(view.rounds).toHaveLength(1);
    expect(view.rounds[0]?.order).toEqual(original.machines.map((m) => m.id));
    expect(view.rounds[0]?.runs.every((run) => run.rtt === null)).toBe(true);
    expect(view.rounds[0]?.runs[0]?.client?.decodeTokPerSec).toBe(
      original.rounds[0]?.runs[0]?.client?.decodeTokPerSec,
    );
  });
});

describe('report and votes', () => {
  async function finishedRace(rounds = 2): Promise<SessionView> {
    return finished((await startSession([linuxId, macId], {}, { rounds })).id);
  }

  it('exports the session as JSON, CSV and Markdown, without keys', async () => {
    const session = await finishedRace();
    const json = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export.json`,
    });
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.headers['content-disposition']).toMatch(
      /^attachment; filename="model-duel-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.json"$/,
    );
    expect(json.body).not.toContain(LINUX_KEY);
    expect(json.body).not.toContain(MAC_KEY);
    const stored = JSON.parse(json.body) as StoredSession;
    expect(stored.rounds[0]?.runs[0]?.raw?.events.length).toBeGreaterThan(10);

    const csv = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export.csv`,
    });
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    const [comparison, roundsBlock] = csv.body.trim().split('\r\n\r\n');
    expect(comparison?.split('\r\n')[0]).toBe('Metric,Unit,Linux,Mac,Result');
    expect(roundsBlock?.split('\r\n').map((line) => line.split(',')[0])).toEqual([
      'Round',
      'Round 1',
      'Round 2',
    ]);

    const md = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export.md`,
    });
    expect(md.headers['content-type']).toMatch(/^text\/markdown/);
    expect(md.body.split('\n')[0]).toBe('# Model Duel: Linux against Mac');
    expect(md.body).toContain('| Decode speed (higher is better) |');
  });

  it('keeps one blind vote per round, checks it, and tallies per model pair', async () => {
    await fetch(`${linux.url}/api/inference/load`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LINUX_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model_path: 'unsloth/Qwen3.8-27B-GGUF',
        gguf_variant: 'UD-IQ2_XXS',
        max_seq_length: 0,
        speculative_type: 'off',
      }),
    });
    const started = await post({
      ...sessionPayload([linuxId, macId], {}, { rounds: 2 }),
      acknowledgeWarnings: true,
    });
    const session = await finished(started.json<SessionView>().id);
    const vote = (body: Record<string, unknown>, id = session.id) =>
      ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/vote`, payload: body });

    const first = await vote({ round: 0, left: linuxId, right: macId, choice: 'left' });
    expect(first.statusCode).toBe(200);
    expect(first.json<SessionView>().votes).toHaveLength(1);
    const changed = await vote({ round: 0, left: macId, right: linuxId, choice: 'tie' });
    expect(changed.json<SessionView>().votes).toEqual([
      expect.objectContaining({ round: 0, left: macId, choice: 'tie' }),
    ]);
    await vote({ round: 1, left: macId, right: linuxId, choice: 'right' });

    expect(
      (await vote({ round: 0, left: linuxId, right: linuxId, choice: 'left' })).statusCode,
    ).toBe(400);
    expect((await vote({ round: 7, left: linuxId, right: macId, choice: 'left' })).statusCode).toBe(
      400,
    );
    expect(
      (
        await vote(
          { round: 0, left: linuxId, right: macId, choice: 'left' },
          '0f0f0f0f-0000-4000-8000-000000000000',
        )
      ).statusCode,
    ).toBe(404);

    const tally = (await ctx.app.inject({ method: 'GET', url: '/api/votes/tally' })).json<{
      tally: Array<{ a: string; b: string; winsA: number; winsB: number; ties: number }>;
    }>().tally;
    expect(tally).toEqual([
      {
        a: 'unsloth/Qwen3.8-27B-GGUF Q4_K_M',
        b: 'unsloth/Qwen3.8-27B-GGUF UD-IQ2_XXS',
        winsA: 0,
        winsB: 1,
        ties: 1,
      },
    ]);
  });
});
