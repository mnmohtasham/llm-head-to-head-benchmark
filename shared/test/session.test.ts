import { describe, expect, it } from 'vitest';
import type { TimedEvent } from '../src/chat';
import type { ModelStatus } from '../src/models';
import {
  compactEvents,
  expandEvents,
  migrateSession,
  publicSession,
  raceWarnings,
  sessionRequestSchema,
  speculativeOn,
  summarizeSession,
} from '../src/session';
import { makeRun, makeSession, type StoredSession } from './make';

const config = { prompt: 'Hi', maxTokens: 64, thinking: true, reasoningEffort: null };

describe('sessionRequestSchema', () => {
  const parse = (machineIds: string[]) =>
    sessionRequestSchema.safeParse({ workload: 'text', machineIds, config });

  it('takes one to eight different machines', () => {
    expect(parse(['a']).success).toBe(true);
    expect(parse(['a', 'b', 'c']).success).toBe(true);
    expect(parse([]).error?.issues[0]?.message).toBe('Pick at least one machine.');
    expect(parse(['a', 'a']).error?.issues[0]?.message).toBe('Pick each machine only once.');
    expect(parse('abcdefghi'.split('')).error?.issues[0]?.message).toBe('Pick at most 8 machines.');
  });
});

function status(over: Partial<ModelStatus>): ModelStatus {
  return {
    activeModel: 'unsloth/Qwen3.8-27B-GGUF',
    modelIdentifier: 'unsloth/Qwen3.8-27B-GGUF',
    backend: 'gguf',
    quant: 'Q4_K_M',
    contextLength: 32768,
    maxContextLength: 262144,
    nativeContextLength: 262144,
    requestedContextLength: 32768,
    supportsReasoning: true,
    reasoningStyle: 'enable_thinking',
    reasoningAlwaysOn: false,
    reasoningEffortLevels: [],
    reasoningBudget: -1,
    speculativeType: 'off',
    specDrafterKind: null,
    specFallbackReason: null,
    cacheTypeKv: null,
    mlxKvBits: null,
    gpuMemoryMode: null,
    gpuLayers: -1,
    totalLayers: null,
    parallelSlots: 4,
    memoryWarning: null,
    loading: [],
    isVision: false,
    ...over,
  };
}

describe('raceWarnings', () => {
  it('says nothing when the machines match, or when only one machine races', () => {
    expect(
      raceWarnings([
        { name: 'A', status: status({}) },
        { name: 'B', status: status({}) },
      ]),
    ).toEqual([]);
    expect(raceWarnings([{ name: 'A', status: status({ speculativeType: 'auto' }) }])).toEqual([]);
  });

  it('names different models, else different quants, and different backends', () => {
    expect(
      raceWarnings([
        { name: 'A', status: status({ activeModel: 'x/One' }) },
        { name: 'B', status: status({ activeModel: 'x/Two', quant: 'Q8_0' }) },
      ]),
    ).toEqual(['The machines run different models: A has x/One, B has x/Two.']);
    expect(
      raceWarnings([
        { name: 'A', status: status({ quant: 'UD-IQ2_XXS' }) },
        { name: 'B', status: status({ quant: 'Q4_0', backend: 'mlx' }) },
        { name: 'C', status: null },
      ]),
    ).toEqual([
      'The machines run different quants: A has UD-IQ2_XXS, B has Q4_0.',
      'The machines use different backends: A has GGUF, B has MLX.',
    ]);
  });

  it('warns about speculative decoding unless it fell back', () => {
    expect(speculativeOn(status({ speculativeType: 'auto', specDrafterKind: 'mtp' }))).toBe(true);
    expect(
      speculativeOn(status({ speculativeType: 'auto', specFallbackReason: 'no drafter' })),
    ).toBe(false);
    expect(speculativeOn(status({ speculativeType: 'off' }))).toBe(false);
    const warnings = raceWarnings([
      { name: 'A', status: status({ speculativeType: 'auto' }) },
      { name: 'B', status: status({}) },
    ]);
    expect(warnings).toEqual([
      'Speculative decoding is on for A, so tokens arrive in groups there. Load with speculative decoding off for a like-for-like race.',
    ]);
  });
});

describe('raw events', () => {
  it('round-trip through the compact form, with times from the request', () => {
    const events: TimedEvent[] = [
      { t: 1000.5, read: 0, event: { type: 'ignored', why: 'role chunk' } },
      { t: 1300.25, read: 1, event: { type: 'reasoning', text: 'Hmm' } },
      { t: 1400.125, read: 2, event: { type: 'content', text: ' 日本' } },
      { t: 1500, read: 3, event: { type: 'finish', reason: 'stop' } },
    ];
    const compact = compactEvents(events, 1000);
    expect(compact[1]).toEqual([300.25, 1, 'r', 'Hmm']);
    expect(expandEvents(compact)).toEqual(events.map((e) => ({ ...e, t: e.t - 1000 })));
  });
});

describe('stored sessions', () => {
  it('lose their raw events on the way out, and summarise medians per machine', () => {
    const base = makeSession(
      ['fast', 'slow'],
      [
        [makeRun('fast', { decodeTokPerSec: 40 }), makeRun('slow', { decodeTokPerSec: 20 })],
        [makeRun('fast', { decodeTokPerSec: 44 }), makeRun('slow', {}, 'failed')],
        [makeRun('fast', { decodeTokPerSec: 42 }), makeRun('slow', { decodeTokPerSec: 22 })],
      ],
    );
    const stored = {
      ...base,
      warmup: null,
      rounds: base.rounds.map((round) => ({
        ...round,
        runs: round.runs.map((run) => ({
          ...run,
          raw: { headersAtMs: 1, endAtMs: 2, events: [] },
        })),
      })),
    } satisfies StoredSession;
    const view = publicSession(stored);
    expect('raw' in (view.rounds[0]?.runs[0] ?? {})).toBe(false);
    expect('raw' in (stored.rounds[0]?.runs[0] ?? {})).toBe(true);
    const summary = summarizeSession(stored);
    expect(summary.rounds).toBe(3);
    expect(summary.machines.map((m) => [m.id, m.state, m.decodeTokPerSec])).toEqual([
      ['fast', 'done', 42],
      ['slow', 'done', 21],
    ]);
  });

  it('migrate from version 1: one round, no plan, no warm-up, no RTT', () => {
    const v1 = {
      ...makeSession(['a'], [[makeRun('a')]]),
      schemaVersion: 1,
    } as Record<string, unknown>;
    delete v1.plan;
    delete v1.warmup;
    delete v1.progress;
    const oldRound = {
      index: 0,
      startedAt: null,
      sendSkewMs: 0,
      runs: [{ ...makeRun('a'), raw: null }],
    } as Record<string, unknown>;
    delete (oldRound.runs as Array<Record<string, unknown>>)[0]?.rtt;
    v1.rounds = [oldRound];
    const migrated = migrateSession(v1 as unknown as StoredSession);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.plan).toEqual({
      rounds: 1,
      warmup: false,
      settleMs: 0,
      sequencing: 'concurrent',
    });
    expect(migrated.warmup).toBeNull();
    expect(migrated.progress).toEqual({ phase: 'finished', round: null });
    expect(migrated.rounds[0]).toMatchObject({ order: ['a'], flags: [], finishedAt: null });
    expect(migrated.rounds[0]?.runs[0]?.rtt).toBeNull();
    // A current file passes through untouched.
    expect(migrateSession(migrated)).toBe(migrated);
  });
});
