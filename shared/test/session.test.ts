import { describe, expect, it } from 'vitest';
import type { TimedEvent } from '../src/chat';
import {
  compactEvents,
  expandEvents,
  migrateSession,
  publicSession,
  sessionRequestSchema,
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

  it('migrate from version 1 or 2: one warm round, four sampling fields, custom prompt', () => {
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
    (v1.config as Record<string, unknown>).sampling = {
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
    };
    delete (v1.config as Record<string, unknown>).preset;
    delete (v1.config as Record<string, unknown>).prefill;
    const migrated = migrateSession(v1 as unknown as StoredSession);
    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.config).toMatchObject({
      preset: 'custom',
      prefill: 'warm',
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, repetitionPenalty: 1, seed: 42 },
    });
    expect(migrated.rounds[0]?.nonce).toBeNull();
    expect(migrated.workload).toBe('text');
    expect(migrated.rounds[0]?.runs[0]?.transcription).toBeNull();
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
