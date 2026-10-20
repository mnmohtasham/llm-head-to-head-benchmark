import { describe, expect, it } from 'vitest';
import { sessionRequestSchema, type SessionView } from '../src/session';
import {
  comboLabel,
  comboRequest,
  expandSuite,
  MAX_SUITE_RACES,
  suiteColumns,
  suiteCsv,
  suiteLabel,
  suiteRequestSchema,
  suiteResults,
  suiteRows,
  suiteSize,
  summarizeSuite,
  type Suite,
  type SuiteRace,
} from '../src/suite';
import { makeRun, makeSession } from './make';

const parse = (body: Record<string, unknown>) =>
  suiteRequestSchema.safeParse({ machineIds: ['a', 'b'], ...body });

const messages = (body: Record<string, unknown>) => {
  const parsed = parse(body);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('a suite request', () => {
  it('takes the axes and fills in the fixed settings', () => {
    const parsed = parse({
      presets: ['short', 'puzzle'],
      thinking: [{ thinking: false }, { thinking: true, reasoningEffort: 'low' }],
      maxTokens: [256, 1024],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      mode: 'latency',
      concurrency: 4,
      prefill: 'cold',
      acknowledgeWarnings: false,
      plan: { rounds: 3, warmup: true, settleMs: 2000, sequencing: 'concurrent' },
    });
    expect(parsed.data.thinking).toEqual([
      { thinking: false, reasoningEffort: null },
      { thinking: true, reasoningEffort: 'low' },
    ]);
    expect(suiteSize(parsed.data)).toBe(8);
  });

  it('takes standard prompts only', () => {
    const base = { thinking: [{ thinking: false }], maxTokens: [256] };
    expect(parse({ ...base, presets: ['custom'] }).success).toBe(false);
    expect(parse({ ...base, presets: ['long-8k', 'long-32k', 'fixed-length'] }).success).toBe(true);
  });

  it('says what is missing, repeated or impossible', () => {
    expect(messages({ presets: [], thinking: [{ thinking: false }], maxTokens: [256] })).toEqual([
      'Pick at least one prompt.',
    ]);
    expect(messages({ presets: ['short'], thinking: [], maxTokens: [256] })).toEqual([
      'Pick at least one thinking setting.',
    ]);
    expect(
      messages({ presets: ['short'], thinking: [{ thinking: false }], maxTokens: [] }),
    ).toEqual(['Give at least one Max tokens value.']);
    expect(
      messages({
        presets: ['short', 'short'],
        thinking: [{ thinking: true }, { thinking: true, reasoningEffort: null }],
        maxTokens: [256, 256],
      }),
    ).toEqual([
      'Pick each prompt only once.',
      'Pick each thinking setting only once.',
      'Give each Max tokens value only once.',
    ]);
    expect(
      messages({
        presets: ['short'],
        thinking: [{ thinking: false, reasoningEffort: 'low' }],
        maxTokens: [0],
      }),
    ).toEqual(['An effort level needs thinking on.', 'Allow at least 1 token.']);
    expect(
      messages({
        presets: ['short'],
        thinking: [{ thinking: false }],
        maxTokens: [256],
        machineIds: ['a', 'a'],
      }),
    ).toEqual(['Pick each machine only once.']);
  });

  it(`refuses more than ${MAX_SUITE_RACES} races and says how many it would be`, () => {
    const body = {
      presets: ['short', 'puzzle', 'code'],
      thinking: [{ thinking: false }, { thinking: true }],
      maxTokens: [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768],
    };
    expect(messages(body)).toEqual([
      'That makes 54 races, and a suite runs at most 50. Pick fewer prompts, thinking settings or Max tokens values.',
    ]);
    expect(parse({ ...body, maxTokens: body.maxTokens.slice(0, 8) }).success).toBe(true);
  });
});

describe('expanding a suite', () => {
  const axes = {
    presets: ['short', 'code'] as const,
    thinking: [
      { thinking: false, reasoningEffort: null },
      { thinking: true, reasoningEffort: 'high' as const },
    ],
    maxTokens: [512, 2048],
  };

  it('makes every combination once, prompt by prompt, then thinking, then Max tokens', () => {
    const combos = expandSuite({ ...axes, presets: [...axes.presets] });
    expect(combos).toHaveLength(suiteSize(axes));
    expect(combos.map(comboLabel)).toEqual([
      'Short · thinking off · 512 tokens',
      'Short · thinking off · 2,048 tokens',
      'Short · thinking on, high · 512 tokens',
      'Short · thinking on, high · 2,048 tokens',
      'Code · thinking off · 512 tokens',
      'Code · thinking off · 2,048 tokens',
      'Code · thinking on, high · 512 tokens',
      'Code · thinking on, high · 2,048 tokens',
    ]);
    expect(new Set(combos.map((c) => JSON.stringify(c))).size).toBe(8);
  });

  it('turns a combination into the race request the Text tab would send', () => {
    const parsed = suiteRequestSchema.parse({
      machineIds: ['a', 'b'],
      ...axes,
      presets: ['long-8k'],
      mode: 'throughput',
      concurrency: 2,
      prefill: 'warm',
      plan: { rounds: 2, warmup: false, settleMs: 0, sequencing: 'sequential' },
      acknowledgeWarnings: true,
    });
    const { machineIds, ...settings } = parsed;
    const suite = { machines: machineIds.map((id) => ({ id })), settings };
    const [combo] = expandSuite(settings).slice(3);
    if (!combo) throw new Error('no combination');
    const request = comboRequest(suite, combo);
    expect(request).toMatchObject({
      workload: 'text',
      machineIds: ['a', 'b'],
      plan: { rounds: 2, warmup: false, settleMs: 0, sequencing: 'sequential' },
      acknowledgeWarnings: true,
      config: {
        preset: 'long-8k',
        maxTokens: 2048,
        thinking: true,
        reasoningEffort: 'high',
        prefill: 'warm',
        mode: 'throughput',
        concurrency: 2,
        sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, seed: 42 },
      },
    });
    // The same shape POST /api/sessions takes, so the suite races through the same route logic.
    expect(sessionRequestSchema.parse(request)).toEqual(request);
  });

  it('describes its axes in a line', () => {
    expect(
      suiteLabel({
        ...suiteRequestSchema.parse({ machineIds: ['a'], ...axes, presets: ['short', 'code'] }),
      }),
    ).toBe('Short, Code · thinking off; on, high · 512, 2,048 tokens');
  });
});

/** Two machines, two rounds; `served` gives each machine's server decode speeds, or none. */
function race(served: { fast?: number[]; slow?: number[] } = {}): SessionView {
  const session = makeSession(
    ['fast', 'slow'],
    [0, 1].map((i) => [
      makeRun('fast', { ttftMs: 200 + i * 10, decodeTokPerSec: 40 + i * 2 }),
      makeRun('slow', { ttftMs: 400 + i * 10, decodeTokPerSec: 20 + i * 2 }),
    ]),
  );
  for (const round of session.rounds) {
    for (const run of round.runs) {
      const speeds = served[run.machineId as 'fast' | 'slow'];
      const speed = speeds?.[round.index];
      if (speed === undefined) continue;
      run.server = {
        timings: { predictedPerSecond: speed, promptPerSecond: 900 },
        monitor: { ttftMs: 150 + round.index },
      } as unknown as typeof run.server;
    }
  }
  session.machines = session.machines.map((m) => ({
    ...m,
    name: m.id === 'fast' ? 'Linux Box' : 'Mac Studio',
  }));
  return session;
}

describe('a race’s headline numbers', () => {
  it('uses the servers’ own numbers when every machine reports them', () => {
    const [fast, slow] = suiteResults(race({ fast: [50, 52], slow: [24, 26] }));
    expect(fast).toMatchObject({ name: 'Linux Box', state: 'done', rounds: 2, roundsDone: 2 });
    expect(fast?.headlines.decode).toEqual({ key: 'decodeServer', value: 51, source: 'server' });
    expect(slow?.headlines.decode).toEqual({ key: 'decodeServer', value: 25, source: 'server' });
    expect(fast?.headlines.ttft).toEqual({ key: 'ttftServer', value: 150.5, source: 'server' });
    expect(fast?.headlines.prompt).toEqual({ key: 'prompt', value: 900, source: null });
  });

  it('falls back to Model Duel’s measurement for every machine when one has no server number', () => {
    const [fast, slow] = suiteResults(race({ fast: [50, 52] }));
    expect(fast?.headlines.decode).toEqual({ key: 'decode', value: 41, source: 'measured' });
    expect(slow?.headlines.decode).toEqual({ key: 'decode', value: 21, source: 'measured' });
    expect(fast?.headlines.ttft).toEqual({ key: 'ttft', value: 205, source: 'measured' });
    expect(Object.keys(fast?.headlines ?? {})).toEqual([
      'ttft',
      'decode',
      'prompt',
      'tokensPerJoule',
    ]);
  });

  it('sums rounds up as the race does, and counts a machine’s failed rounds', () => {
    const session = race();
    session.plan = { ...session.plan, statistic: 'mean' };
    const round = session.rounds[1];
    if (round) round.runs[1] = makeRun('slow', { decodeTokPerSec: 99 }, 'failed');
    const [fast, slow] = suiteResults(session);
    expect(fast?.headlines.decode?.value).toBe(41);
    expect(slow).toMatchObject({ state: 'partial', roundsDone: 1, rounds: 2 });
    expect(slow?.headlines.decode?.value).toBe(20);
  });
});

/** A finished suite of two races on two machines: one done, one skipped by pre-flight. */
function suite(): Suite {
  const request = suiteRequestSchema.parse({
    machineIds: ['fast', 'slow'],
    presets: ['short'],
    thinking: [{ thinking: false }, { thinking: true }],
    maxTokens: [512],
  });
  const { machineIds, ...settings } = request;
  const [first, second] = expandSuite(settings);
  if (!first || !second) throw new Error('no combinations');
  const done: SuiteRace = {
    index: 0,
    combo: first,
    state: 'done',
    sessionId: '22222222-2222-4222-8222-222222222222',
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:01:00.000Z',
    error: null,
    issues: [],
    results: suiteResults(race({ fast: [50, 52], slow: [24, 26] })),
  };
  const skipped: SuiteRace = {
    index: 1,
    combo: second,
    state: 'skipped',
    sessionId: null,
    startedAt: '2026-10-01T10:01:00.000Z',
    finishedAt: '2026-10-01T10:01:01.000Z',
    error: 'The model on Mac Studio cannot think. Turn Thinking off to race it.',
    issues: [
      {
        level: 'error',
        code: 'no-thinking',
        machineId: 'slow',
        text: 'The model on Mac Studio cannot think. Turn Thinking off to race it.',
      },
    ],
    results: [],
  };
  return {
    schemaVersion: 1,
    id: '33333333-3333-4333-8333-333333333333',
    createdAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:01:01.000Z',
    state: 'done',
    error: null,
    machines: machineIds.map((id) => ({
      id,
      name: id === 'fast' ? 'Linux Box' : 'Mac Studio',
      color: '#fff',
    })),
    settings,
    races: [done, skipped],
  };
}

describe('the summary', () => {
  it('has a row per combination and machine, skipped races included', () => {
    const rows = suiteRows(suite());
    expect(rows.map((row) => row.key)).toEqual(['0/fast', '0/slow', '1/fast', '1/slow']);
    const columns = suiteColumns(suite());
    const text = (row: number, id: string) => {
      const target = rows[row];
      const column = columns.find((c) => c.id === id);
      return target && column ? column.text(target) : null;
    };
    expect(columns.map((c) => c.id)).toEqual([
      'prompt',
      'thinking',
      'maxTokens',
      'machine',
      'state',
      'rounds',
      'metric:ttft',
      'metric:decode',
      'metric:prompt',
      'metric:tokensPerJoule',
      'race',
    ]);
    expect(text(0, 'thinking')).toBe('Off');
    expect(text(0, 'metric:decode')).toBe('51.0 tok/s');
    expect(text(0, 'rounds')).toBe('2 of 2');
    expect(text(2, 'thinking')).toBe('On');
    expect(text(2, 'state')).toBe('skipped');
    expect(text(2, 'metric:decode')).toBe('—');
    expect(text(2, 'race')).toBe('—');
    expect(columns.find((c) => c.id === 'metric:decode')?.source?.(rows[1] ?? rows[0]!)).toBe(
      'server',
    );
  });

  it('has throughput’s own headlines for a throughput suite', () => {
    const s = suite();
    s.settings = { ...s.settings, mode: 'throughput' };
    expect(suiteColumns(s).map((c) => c.id)).toEqual([
      'prompt',
      'thinking',
      'maxTokens',
      'machine',
      'state',
      'rounds',
      'metric:aggregate',
      'metric:ttftMedian',
      'metric:tokensPerJoule',
      'race',
    ]);
  });

  it('exports as CSV with raw numbers, units and whose number each is', () => {
    const lines = suiteCsv(suite()).trim().split('\n');
    expect(lines[0]).toBe(
      'Prompt,Thinking,Max tokens,Machine,State,Rounds done,Time to first token (ms),"Time to first token, from",Decode speed (tok/s),"Decode speed, from","Prompt processing, Unsloth (tok/s)","Tokens per joule, approx. (tok/J)",Race',
    );
    expect(lines[1]).toBe(
      'Short,Off,512,Linux Box,done,2,150.5,server,51,server,900,,22222222-2222-4222-8222-222222222222',
    );
    expect(lines[4]).toBe('Short,On,512,Mac Studio,skipped,,,,,,,,');
    expect(lines).toHaveLength(5);
  });

  it('keeps names from machines out of spreadsheet formulas', () => {
    const s = suite();
    s.machines = s.machines.map((m) => ({ ...m, name: '=HYPERLINK("x")' }));
    expect(suiteCsv(s)).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('counts races by state for the list of suites', () => {
    const summary = summarizeSuite(suite());
    expect(summary).toMatchObject({
      id: '33333333-3333-4333-8333-333333333333',
      state: 'done',
      races: 2,
      label: 'Short · thinking off; on · 512 tokens',
    });
    expect(summary.counts).toMatchObject({ done: 1, skipped: 1, failed: 0, queued: 0 });
  });
});
