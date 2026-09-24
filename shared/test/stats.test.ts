import { describe, expect, it } from 'vitest';
import { abbaOrder, gate, roundFlags, sessionStats, summarize, type Summary } from '../src/stats';
import { makeRun, makeSession } from './make';

describe('summarize', () => {
  it('gives the median, spread and sample standard deviation for odd and even counts', () => {
    expect(summarize([3, 1, 2])).toEqual({ n: 3, median: 2, min: 1, max: 3, mean: 2, stdev: 1 });
    const even = summarize([1, 2, 3, 10]);
    expect(even).toMatchObject({ n: 4, median: 2.5, min: 1, max: 10, mean: 4 });
    expect(even.stdev).toBeCloseTo(4.0825, 3);
  });

  it('has no spread for a single value, and nothing for none', () => {
    expect(summarize([7])).toEqual({ n: 1, median: 7, min: 7, max: 7, mean: 7, stdev: null });
    expect(summarize([])).toEqual({
      n: 0,
      median: null,
      min: null,
      max: null,
      mean: null,
      stdev: null,
    });
    expect(summarize([Number.NaN, 4]).n).toBe(1);
  });
});

const s = (values: number[]): Summary => summarize(values);

describe('the winner gate', () => {
  it('names a winner when the medians are more than 10 percent apart', () => {
    const verdict = gate([s([30, 31, 29]), s([40, 41, 39])], 'higher');
    expect(verdict).toMatchObject({ kind: 'win', leader: 1, runnerUp: 0, reason: 'gap' });
    expect(verdict.ratio).toBeCloseTo(40 / 30, 5);
  });

  it('names a winner when the ranges do not overlap, even within 10 percent', () => {
    expect(gate([s([100, 101, 102]), s([105, 106, 107])], 'lower')).toMatchObject({
      kind: 'win',
      leader: 0,
      reason: 'ranges',
    });
  });

  it('calls a tie when the ranges overlap and the medians are close', () => {
    expect(gate([s([100, 104, 108]), s([102, 106, 110])], 'lower')).toMatchObject({
      kind: 'tie',
      leader: 0,
      runnerUp: 1,
    });
  });

  it('needs two rounds on both sides to trust ranges; one round can only win on the gap', () => {
    expect(gate([s([100]), s([105])], 'lower').kind).toBe('tie');
    expect(gate([s([100]), s([120])], 'lower').kind).toBe('win');
  });

  it('has no verdict without a direction or without two machines', () => {
    expect(gate([s([1]), s([2])], null).kind).toBe('none');
    expect(gate([s([1]), s([])], 'lower').kind).toBe('none');
  });

  it('compares the leader with the runner-up only', () => {
    const verdict = gate([s([50, 50]), s([10, 10]), s([47, 51])], 'higher');
    expect(verdict).toMatchObject({ leader: 0, runnerUp: 2, kind: 'tie' });
  });
});

describe('abbaOrder', () => {
  it('alternates forward and backward so nobody always goes first', () => {
    const order = [0, 1, 2, 3].map((round) => abbaOrder(['A', 'B'], round).join(''));
    expect(order).toEqual(['AB', 'BA', 'AB', 'BA']);
    expect(abbaOrder(['A', 'B', 'C'], 1)).toEqual(['C', 'B', 'A']);
  });
});

describe('sessionStats', () => {
  it('counts only finished rounds, never the warm-up, and gates each metric', () => {
    const session = makeSession(
      ['fast', 'slow'],
      [
        [makeRun('fast', { decodeTokPerSec: 44 }), makeRun('slow', { decodeTokPerSec: 30 })],
        [
          makeRun('fast', { decodeTokPerSec: 45 }),
          makeRun('slow', { decodeTokPerSec: 999 }, 'failed'),
        ],
        [makeRun('fast', { decodeTokPerSec: 43 }), makeRun('slow', { decodeTokPerSec: 31 })],
      ],
      [makeRun('fast', { decodeTokPerSec: 1 }), makeRun('slow', { decodeTokPerSec: 1000 })],
    );
    const decode = sessionStats(session).find((row) => row.key === 'decode');
    expect(decode?.summaries.map((x) => [x.n, x.median])).toEqual([
      [3, 44],
      [2, 30.5],
    ]);
    expect(decode?.verdict).toMatchObject({ kind: 'win', leader: 0 });
    const output = sessionStats(session).find((row) => row.key === 'output');
    expect(output?.verdict.kind).toBe('none');
  });

  it('calls equal machines a tie', () => {
    const round = (a: number, b: number) => [
      makeRun('a', { decodeTokPerSec: a, firstAnswerMs: 900 + a }),
      makeRun('b', { decodeTokPerSec: b, firstAnswerMs: 900 + b }),
    ];
    const session = makeSession(['a', 'b'], [round(30, 31), round(32, 29), round(28, 30)]);
    const rows = sessionStats(session);
    expect(rows.find((r) => r.key === 'decode')?.verdict.kind).toBe('tie');
    expect(rows.find((r) => r.key === 'firstAnswer')?.verdict.kind).toBe('tie');
  });
});

describe('roundFlags', () => {
  it('flags a busy controller, a failed machine and chunks that arrived together', () => {
    const names = new Map([
      ['a', 'Alpha'],
      ['b', 'Beta'],
    ]);
    const flags = roundFlags(
      [makeRun('a', { chunks: 100, coalescedChunks: 45 }), makeRun('b', {}, 'failed')],
      names,
      { max: 80 },
    );
    expect(flags.map((f) => [f.kind, f.machineId])).toEqual([
      ['lag', null],
      ['coalesced', 'a'],
      ['failed', 'b'],
    ]);
    expect(roundFlags([makeRun('a')], names, { max: 12 })).toEqual([]);
  });
});
