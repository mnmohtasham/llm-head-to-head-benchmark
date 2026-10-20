import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_FILTER,
  HISTORY_METRICS,
  inHistoryOf,
  runChanges,
  runHistory,
} from '../src/history';
import type { DeviceRun } from '../src/runs';
import { makeDeviceRun } from './make';

/** A run of the RTX on day `day` of October, decoding at `decode` by its server. */
function on(day: number, over: Partial<DeviceRun> = {}, decode = 57): DeviceRun {
  const date = `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  return makeDeviceRun({
    sessionId: `session-${day}`,
    createdAt: date,
    metrics: { decode: decode - 2, decodeServer: decode, ttft: 160, ttftServer: 150 },
    means: { decode: decode - 3, decodeServer: decode - 1, ttft: 170, ttftServer: 155 },
    ...over,
  });
}

describe('which runs make a history', () => {
  it('keeps the machine, model, quant and engine, and by default the prompt and thinking', () => {
    const anchor = on(1);
    const filter = DEFAULT_HISTORY_FILTER;
    expect(inHistoryOf(anchor, on(2), filter)).toBe(true);
    expect(inHistoryOf(anchor, on(2, { machineId: 'amd' }), filter)).toBe(false);
    expect(inHistoryOf(anchor, on(2, { model: 'unsloth/gemma-5-12b' }), filter)).toBe(false);
    expect(inHistoryOf(anchor, on(2, { quant: 'Q8_0' }), filter)).toBe(false);
    expect(inHistoryOf(anchor, on(2, { engine: 'LM Studio GGUF' }), filter)).toBe(false);
    expect(inHistoryOf(anchor, on(2, { kind: 'throughput', concurrency: 1 }), filter)).toBe(false);

    const otherPrompt = on(2, { prompt: '8K', promptText: 'On Liberty…' });
    const thinking = on(3, { thinking: 'on, low' });
    expect(inHistoryOf(anchor, otherPrompt, filter)).toBe(false);
    expect(inHistoryOf(anchor, thinking, filter)).toBe(false);
    const any = { samePrompt: false, sameThinking: false, sameConcurrency: false };
    expect(inHistoryOf(anchor, otherPrompt, any)).toBe(true);
    expect(inHistoryOf(anchor, thinking, any)).toBe(true);
    expect(inHistoryOf(anchor, thinking, { ...any, sameThinking: true })).toBe(false);
    // A throughput history keeps the number of requests at once unless told otherwise.
    const batch = on(4, { kind: 'throughput', concurrency: 4 });
    expect(inHistoryOf(batch, on(5, { kind: 'throughput', concurrency: 8 }), filter)).toBe(false);
    expect(
      inHistoryOf(batch, on(5, { kind: 'throughput', concurrency: 8 }), {
        ...filter,
        sameConcurrency: false,
      }),
    ).toBe(true);
  });

  it('takes finished runs only, oldest first, from among many', () => {
    const runs = [
      on(3),
      on(1),
      on(2, { state: 'failed' }),
      on(4, { state: 'partial' }),
      on(5, { machineId: 'amd' }),
    ];
    const many = Array.from({ length: 400 }, (_, i) =>
      on(10, { sessionId: `other-${i}`, quant: i % 2 ? 'Q8_0' : 'Q4_K_M' }),
    );
    const history = runHistory([...runs, ...many], on(1));
    expect(history.runs.map((r) => r.createdAt.slice(8, 10))).toEqual([
      '01',
      '03',
      '04',
      ...Array.from({ length: 200 }, () => '10'),
    ]);
    expect(history.series.map((s) => s.key)).toEqual(['decode', 'ttft']);
    expect(history.series[0]?.points).toHaveLength(203);
  });
});

describe('the series', () => {
  it('uses the server’s number where the run has it, and says which', () => {
    const runs = [
      on(1),
      on(2, { metrics: { decode: 50, decodeServer: null, ttft: 200, ttftServer: null } }),
      on(3, { metrics: { decode: null, decodeServer: null, ttft: null, ttftServer: null } }),
    ];
    const [decode, ttft] = runHistory(runs, runs[0]!).series;
    expect(decode).toMatchObject({
      label: 'Decode speed',
      unit: 'tok/s',
      serverKey: 'decodeServer',
    });
    expect(decode?.points).toEqual([
      { value: 57, source: 'server', server: 57, measured: 55 },
      { value: 50, source: 'measured', server: null, measured: 50 },
      { value: null, source: null, server: null, measured: null },
    ]);
    expect(ttft?.points.map((p) => p.source)).toEqual(['server', 'measured', null]);
  });

  it('follows the median or average', () => {
    const runs = [on(1), on(2)];
    expect(runHistory(runs, runs[0]!, DEFAULT_HISTORY_FILTER, 'mean').series[0]?.points[0]).toEqual(
      { value: 56, source: 'server', server: 56, measured: 54 },
    );
  });

  it('follows the headline numbers of every kind', () => {
    expect(HISTORY_METRICS).toEqual({
      text: ['decode', 'ttft'],
      throughput: ['aggregate', 'ttftMedian'],
      transcribe: ['rtf'],
      image: ['stepsPerSec'],
    });
    const stt = (day: number, rtf: number, serverRtf: number | null) =>
      on(day, {
        kind: 'transcribe',
        workload: 'transcribe',
        quant: null,
        engine: 'whisper.cpp on cuda',
        prompt: null,
        promptText: null,
        thinking: null,
        settings: 'LibriSpeech clip, en',
        metrics: { rtf, rtfServer: serverRtf },
        means: { rtf, rtfServer: serverRtf },
      });
    const runs = [stt(1, 20, 24), stt(2, 18, 21)];
    const [rtf] = runHistory(runs, runs[0]!).series;
    expect(rtf).toMatchObject({ key: 'rtf', serverKey: 'rtfServer', label: 'Real-time factor' });
    expect(rtf?.summary?.text).toBe(
      'Latest 21.0× on 2026-10-02 is 13% slower than the best, 24.0× on 2026-10-01. Both are the servers’ own numbers.',
    );
  });
});

describe('latest against best', () => {
  it('says how far the latest is from the best, in percent', () => {
    const runs = [on(1, {}, 60), on(2, {}, 64), on(3, {}, 48)];
    const [decode, ttft] = runHistory(runs, runs[0]!).series;
    expect(decode?.summary).toMatchObject({
      basis: 'server',
      latest: 2,
      best: 1,
      latestValue: 48,
      bestValue: 64,
      percent: 25,
      text: 'Latest 48.0 tok/s on 2026-10-03 is 25% slower than the best, 64.0 tok/s on 2026-10-02. Both are the servers’ own numbers.',
    });
    // Every time to first token is the same: the latest is as good as the best.
    expect(ttft?.summary).toMatchObject({ latest: 2, best: 2, percent: 0 });
    expect(ttft?.summary?.text).toMatch(/^Latest 150 ms on 2026-10-03 is the best of 3 runs\./);
  });

  it('compares lower-is-better numbers the right way round', () => {
    const runs = [
      on(1, { metrics: { ttft: 200, ttftServer: 180 } }),
      on(2, { metrics: { ttft: 260, ttftServer: 234 } }),
    ];
    const ttft = runHistory(runs, runs[0]!).series[1];
    expect(ttft?.summary).toMatchObject({ best: 0, latest: 1 });
    expect(ttft?.summary?.percent).toBeCloseTo(30, 6);
    expect(ttft?.summary?.text).toMatch(/is 30% slower than the best, 180 ms on 2026-10-01\./);
  });

  it('compares on Model Duel’s measurements when not every run has the server’s number', () => {
    const runs = [
      on(1, { metrics: { decode: 52, decodeServer: 57 } }),
      on(2, { metrics: { decode: 50, decodeServer: null } }),
    ];
    const decode = runHistory(runs, runs[0]!).series[0];
    expect(decode?.summary).toMatchObject({ basis: 'measured', bestValue: 52, latestValue: 50 });
    expect(decode?.summary?.text).toBe(
      'Latest 50.0 tok/s on 2026-10-02 is 3.8% slower than the best, 52.0 tok/s on 2026-10-01. Both are Model Duel’s measurements, since not every run has the server’s number.',
    );
  });

  it('has nothing to compare with one run, or none', () => {
    const one = runHistory([on(1)], on(1));
    expect(one.runs).toHaveLength(1);
    expect(one.series[0]?.summary).toBeNull();
    expect(one.changes).toEqual([]);
    const none = runHistory([on(1, { state: 'failed' })], on(1, { state: 'failed' }));
    expect(none.runs).toEqual([]);
    expect(none.series[0]?.points).toEqual([]);
    expect(none.series[0]?.summary).toBeNull();
    // Numbers missing from every run but one leave nothing to compare either.
    const gaps = [on(1), on(2, { metrics: {} })];
    expect(runHistory(gaps, gaps[0]!).series[0]?.summary).toBeNull();
  });

  it('says only the measurement where the server never has one', () => {
    const batch = (day: number, aggregate: number) =>
      on(day, {
        kind: 'throughput',
        concurrency: 4,
        metrics: { aggregate, ttftMedian: 400 },
        means: { aggregate, ttftMedian: 400 },
      });
    const runs = [batch(1, 200), batch(2, 250)];
    const [aggregate] = runHistory(runs, runs[0]!).series;
    expect(aggregate?.serverKey).toBeNull();
    expect(aggregate?.points[0]?.source).toBe('measured');
    expect(aggregate?.summary?.text).toBe(
      'Latest 250.0 tok/s on 2026-10-02 is the best of 2 runs.',
    );
  });
});

describe('what changed between runs', () => {
  it('marks version, memory, KV cache and context changes with the day they came', () => {
    const runs = [
      on(1),
      on(2),
      on(3, { llamaCpp: 'b9650', studio: '0.1.820' }),
      on(4, { llamaCpp: 'b9650', studio: '0.1.820', kvCache: 'q8_0', contextLength: 65536 }),
      on(5, {
        llamaCpp: 'b9650',
        studio: '0.1.820',
        kvCache: 'q8_0',
        contextLength: 65536,
        gpuMemoryMode: 'offload',
      }),
    ];
    const history = runHistory(runs, runs[0]!);
    expect(history.changes.map((c) => [c.index, c.text])).toEqual([
      [2, 'Unsloth Studio 0.1.815-beta → 0.1.820 on 2026-10-03'],
      [2, 'llama.cpp b9601 → b9650 on 2026-10-03'],
      [3, 'KV cache default → q8_0 on 2026-10-04'],
      [3, 'Context 32,768 → 65,536 on 2026-10-04'],
    ]);
    // A setting one run does not know is no change: the mode was not reported before.
    expect(history.changes.some((c) => c.field === 'gpuMemoryMode')).toBe(false);
    expect(runChanges(runs[4]!, on(6, { ...runs[4], gpuMemoryMode: 'gpu' }))).toEqual([
      { field: 'gpuMemoryMode', label: 'GPU memory mode', from: 'offload', to: 'gpu' },
    ]);
  });

  it('numbers each run that came with changes, and says how the numbers moved', () => {
    const update = { llamaCpp: 'b9650', studio: '0.1.820' };
    const runs = [
      on(1),
      on(2, update, 31),
      on(3, update, 30),
      on(4, {
        ...update,
        kvCache: 'q8_0',
        metrics: { decode: 40, decodeServer: null, ttft: 100, ttftServer: null },
      }),
    ];
    const { marks } = runHistory(runs, runs[0]!);
    expect(marks.map((m) => [m.number, m.index, m.changes.map((c) => c.field)])).toEqual([
      [1, 1, ['studio', 'llamaCpp']],
      [2, 3, ['kvCache']],
    ]);
    expect(marks[0]?.effects.map((e) => e.text)).toEqual([
      'Decode speed 57.0 tok/s → 31.0 tok/s, 46% slower',
      'Time to first token 150 ms → 150 ms, about the same',
    ]);
    expect(marks[0]?.effects[0]).toMatchObject({ basis: 'server', better: false });
    // The run with the second change has no server numbers, so both runs' measurements count.
    expect(marks[1]?.effects.map((e) => [e.basis, e.better, e.text])).toEqual([
      ['measured', true, 'Decode speed 28.0 tok/s → 40.0 tok/s, 43% faster'],
      ['measured', true, 'Time to first token 160 ms → 100 ms, 38% faster'],
    ]);
  });

  it('lists what the runs were asked differently once the history takes any prompt', () => {
    const runs = [on(1), on(2, { prompt: '8K', promptText: 'On Liberty…', maxTokens: 2048 })];
    const any = { samePrompt: false, sameThinking: false, sameConcurrency: false };
    expect(runHistory(runs, runs[0]!, any).changes.map((c) => c.text)).toEqual([
      'Prompt Short → 8K on 2026-10-02',
      'Max tokens 512 → 2,048 on 2026-10-02',
    ]);
  });

  it('ignores versions a machine that was never probed did not give', () => {
    expect(runChanges(on(1, { llamaCpp: null, studio: null }), on(2))).toEqual([]);
    expect(runChanges(on(1), on(2, { llamaCpp: null }))).toEqual([]);
  });
});
