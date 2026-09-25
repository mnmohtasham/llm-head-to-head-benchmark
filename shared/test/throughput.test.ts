import { describe, expect, it } from 'vitest';
import {
  migrateSession,
  observeQueue,
  percentile,
  preflightIssues,
  summarizeThroughput,
  textConfigSchema,
  type PreflightMachine,
  type RequestResult,
  type StoredSession,
} from '../src';
import { makeRun, makeSession, makeStatus } from './make';

const request = (index: number, patch: Partial<RequestResult> = {}): RequestResult => ({
  index,
  state: 'done',
  error: null,
  sendOffsetMs: 0,
  ttftMs: 200,
  totalMs: 2000,
  outputTokens: 100,
  decodeTokPerSec: 55,
  ...patch,
});

describe('throughput', () => {
  it('adds every finished request’s tokens over the whole batch', () => {
    const t = summarizeThroughput(
      [
        request(0),
        request(1, { sendOffsetMs: 1, ttftMs: 250 }),
        request(2, { sendOffsetMs: 2, ttftMs: 1200, totalMs: 3998 }),
        request(3, { sendOffsetMs: 3, state: 'failed', totalMs: null, outputTokens: null }),
      ],
      4,
      null,
    );
    // 300 tokens from 0 ms to 4000 ms.
    expect(t.outputTokens).toBe(300);
    expect(t.totalMs).toBe(4000);
    expect(t.aggregateTokPerSec).toBeCloseTo(75, 5);
    expect(t.ttftMedianMs).toBe(250);
    expect(t.ttftP95Ms).toBe(1200);
    expect(t.perRequestTokPerSec).toBe(55);
    expect(
      summarizeThroughput([request(0, { state: 'cancelled' })], 1, null).aggregateTokPerSec,
    ).toBeNull();
  });

  it('takes nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(
      percentile(
        Array.from({ length: 20 }, (_, i) => i + 1),
        95,
      ),
    ).toBe(19);
    expect(percentile([], 95)).toBeNull();
  });

  it('adds up the time a request waited in the queue, and its peaks', () => {
    const q = observeQueue([
      { at: 1000, capacity: 2, active: 2, queued: 2 },
      { at: 1250, capacity: 2, active: 2, queued: 2 },
      { at: 1500, capacity: 2, active: 2, queued: 1 },
      { at: 1750, capacity: 2, active: 2, queued: 0 },
      { at: 2000, capacity: 2, active: 1, queued: 0 },
    ]);
    expect(q).toEqual({ capacity: 2, maxActive: 2, maxQueued: 2, queuedMs: 750, samples: 5 });
    expect(observeQueue([])).toBeNull();
  });
});

describe('throughput settings and pre-flight', () => {
  it('default to latency, and to four requests when throughput is picked', () => {
    const config = textConfigSchema.parse({
      prompt: 'Hi',
      maxTokens: 64,
      thinking: false,
      reasoningEffort: null,
    });
    expect(config).toMatchObject({ mode: 'latency', concurrency: 4 });
    expect(
      textConfigSchema.safeParse({ ...config, concurrency: 33 }).error?.issues[0]?.message,
    ).toBe('Send at most 32 requests at once.');
  });

  const machine = (patch: Partial<PreflightMachine>): PreflightMachine => ({
    id: 'a',
    name: 'A',
    status: makeStatus({ contextLength: 8192 }),
    error: null,
    loading: false,
    promptTokens: 1000,
    tokenError: null,
    slots: 4,
    ...patch,
  });
  const throughput = {
    maxTokens: 1024,
    thinking: false,
    mode: 'throughput' as const,
    concurrency: 4,
  };

  it('stops more requests than slots, warns when slots are unknown or the context may split', () => {
    const codes = (m: PreflightMachine, config = throughput) =>
      preflightIssues([m], config).map((i) => [i.level, i.code]);
    expect(codes(machine({}))).toEqual([]);
    expect(codes(machine({ slots: 2 }))).toEqual([['error', 'slots']]);
    expect(codes(machine({ slots: null }))).toEqual([['warning', 'slots']]);
    // 8192 / 4 = 2048 per slot, less than 1000 + 1500.
    expect(codes(machine({}), { ...throughput, maxTokens: 1500 })).toEqual([
      ['warning', 'context-slots'],
    ]);
    expect(codes(machine({ slots: 1 }), { ...throughput, mode: 'latency' as never })).toEqual([]);
  });
});

describe('stored sessions', () => {
  it('migrate from version 7 as latency sessions', () => {
    const v7 = makeSession(['a'], [[makeRun('a')]]) as unknown as Record<string, unknown>;
    v7.schemaVersion = 7;
    const config = { ...(v7.config as Record<string, unknown>) };
    delete config.mode;
    delete config.concurrency;
    v7.config = config;
    const migrated = migrateSession(v7 as unknown as StoredSession);
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.config).toMatchObject({ mode: 'latency', concurrency: 1 });
    expect(migrated.rounds[0]?.runs[0]?.throughput).toBeNull();
  });
});
