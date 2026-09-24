import { describe, expect, it } from 'vitest';
import type { ClientMetrics, RunView, TimedEvent } from '../src/chat';
import { bestOf, compareRuns } from '../src/compare';
import type { ModelStatus } from '../src/models';
import {
  compactEvents,
  expandEvents,
  publicSession,
  raceWarnings,
  sessionRequestSchema,
  speculativeOn,
  summarizeSession,
  type StoredSession,
} from '../src/session';

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

describe('bestOf', () => {
  it('marks the lowest or highest value of the finished runs', () => {
    expect(bestOf([300, 200, 250], 'lower', [true, true, true])).toEqual([false, true, false]);
    expect(bestOf([30, 40, 45], 'higher', [true, true, false])).toEqual([false, true, false]);
  });

  it('marks nothing without a comparison: one value, equal values, or no direction', () => {
    expect(bestOf([300, null], 'lower', [true, true])).toEqual([false, false]);
    expect(bestOf([5, 5], 'higher', [true, true])).toEqual([false, false]);
    expect(bestOf([1, 2], null, [true, true])).toEqual([false, false]);
    expect(bestOf(['stop', 'length'], 'lower', [true, true])).toEqual([false, false]);
  });

  it('marks ties at the top together', () => {
    expect(bestOf([10, 10, 20], 'lower', [true, true, true])).toEqual([true, true, false]);
  });
});

function run(
  machineId: string,
  over: Partial<ClientMetrics>,
  state: RunView['state'] = 'done',
): RunView {
  const client = {
    ttftMs: 300,
    firstAnswerMs: 900,
    thinkingMs: 600,
    decodeTokPerSec: 30,
    endToEndTokPerSec: 25,
    charsPerSec: 120,
    totalMs: 5000,
    outputTokens: 150,
    chunks: 150,
    finishReason: 'stop',
    ...over,
  } as ClientMetrics;
  return {
    id: `run-${machineId}`,
    machineId,
    machineName: machineId,
    prompt: 'Hi',
    maxTokens: 64,
    thinking: true,
    reasoningEffort: null,
    state,
    startedAt: '2026-09-25T00:00:00.000Z',
    finishedAt: '2026-09-25T00:00:05.000Z',
    modelBefore: 'm',
    modelAfter: 'm',
    reasoning: '',
    answer: '',
    live: { elapsedMs: 0, ttftMs: null, firstAnswerMs: null, chunks: 0, decodeTokPerSec: null },
    client,
    server: null,
    error: null,
    loopLagMs: null,
    sendOffsetMs: 0,
  };
}

describe('compareRuns', () => {
  it('highlights the faster machine, and leaves a failed machine out of the contest', () => {
    const rows = compareRuns([
      run('fast', { firstAnswerMs: 600, decodeTokPerSec: 45 }),
      run('slow', { firstAnswerMs: 900, decodeTokPerSec: 28 }),
      run('broken', { firstAnswerMs: 100, decodeTokPerSec: 90 }, 'failed'),
    ]);
    const row = (key: string) => rows.find((r) => r.key === key);
    expect(row('firstAnswer')?.best).toEqual([true, false, false]);
    expect(row('decode')?.best).toEqual([true, false, false]);
    expect(row('output')?.best).toEqual([false, false, false]);
    expect(row('finish')?.values).toEqual(['stop', 'stop', 'stop']);
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
  it('lose their raw events on the way out, and summarise per machine', () => {
    const stored = {
      schemaVersion: 1,
      id: '11111111-1111-4111-8111-111111111111',
      workload: 'text',
      createdAt: '2026-09-25T00:00:00.000Z',
      finishedAt: '2026-09-25T00:00:05.000Z',
      state: 'done',
      error: null,
      config: { ...config, sampling: {} },
      machines: [{ id: 'fast', name: 'Fast', color: '#fff', baseUrl: 'http://x', notes: '' }],
      rounds: [
        {
          index: 0,
          startedAt: null,
          sendSkewMs: 0,
          runs: [{ ...run('fast', {}), raw: { headersAtMs: 1, endAtMs: 2, events: [] } }],
        },
      ],
      provenance: [],
      loopLagMs: null,
    } satisfies StoredSession;
    const view = publicSession(stored);
    expect('raw' in (view.rounds[0]?.runs[0] ?? {})).toBe(false);
    expect('raw' in (stored.rounds[0]?.runs[0] ?? {})).toBe(true);
    expect(summarizeSession(stored).machines).toEqual([
      {
        id: 'fast',
        name: 'Fast',
        color: '#fff',
        state: 'done',
        firstAnswerMs: 900,
        decodeTokPerSec: 30,
      },
    ]);
  });
});
