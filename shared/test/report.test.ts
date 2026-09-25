import { describe, expect, it } from 'vitest';
import { blindRounds, labelVotes, shuffleSides, sidesOf, tallyVotes } from '../src/blind';
import { comparisonTable, roundTable, scoreboard, toCsv, toMarkdown } from '../src/report';
import { tokenTimeline, TIMELINE_POINTS, type SessionView } from '../src/session';
import { makeRun, makeSession, makeStatus } from './make';

/** Two machines, three rounds: Fast decodes about 1.5 times faster and starts sooner. */
function race(): SessionView {
  const round = (fast: number, slow: number) => [
    {
      ...makeRun('fast', { decodeTokPerSec: fast, ttftMs: 200, charsPerSec: fast * 4 }),
      answer: `Fast says ${fast}`,
    },
    {
      ...makeRun('slow', { decodeTokPerSec: slow, ttftMs: 390, charsPerSec: slow * 4 }),
      answer: `Slow says ${slow}`,
    },
  ];
  const session = makeSession(['fast', 'slow'], [round(44, 30), round(45, 29), round(43, 31)]);
  session.machines = [
    { id: 'fast', name: 'Linux Box', color: '#aabbcc', baseUrl: 'http://10.0.0.1:8888', notes: '' },
    {
      id: 'slow',
      name: 'Mac Studio',
      color: '#ddeeff',
      baseUrl: 'http://10.0.0.2:8888',
      notes: '',
    },
  ];
  session.provenance = [
    {
      machineId: 'fast',
      probedAt: null,
      versions: { unsloth: null, studio: 'v1', llamaCpp: 'b1' },
      platform: { os: 'Linux', backend: 'cuda', memoryTotalGb: 32 },
      gpus: [],
      statusBefore: makeStatus({ activeModel: 'org/Model-A', quant: 'Q4_K_M' }),
      statusAfter: null,
      request: { model: 'org/Model-A' },
      sttBefore: null,
      sttAfter: null,
      imageBefore: null,
      imageAfter: null,
      restore: null,
      agent: null,
    },
    {
      machineId: 'slow',
      probedAt: null,
      versions: { unsloth: null, studio: 'v1', llamaCpp: 'b1' },
      platform: { os: 'macOS', backend: 'mlx', memoryTotalGb: 64 },
      gpus: [],
      statusBefore: makeStatus({ activeModel: 'org/Model-B', quant: 'Q8_0' }),
      statusAfter: null,
      request: { model: 'org/Model-B' },
      sttBefore: null,
      sttAfter: null,
      imageBefore: null,
      imageAfter: null,
      restore: null,
      agent: null,
    },
  ];
  return session;
}

/** A small CSV reader for the tests: quoted fields, commas and doubled quotes. */
function parseCsv(text: string): string[][][] {
  return text
    .trim()
    .split(/\r\n\r\n/)
    .map((block) =>
      block.split(/\r\n/).map((line) => {
        const cells: string[] = [];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i] ?? '';
          if (quoted) {
            if (ch === '"' && line[i + 1] === '"') {
              cell += '"';
              i += 1;
            } else if (ch === '"') quoted = false;
            else cell += ch;
          } else if (ch === '"') quoted = true;
          else if (ch === ',') {
            cells.push(cell);
            cell = '';
          } else cell += ch;
        }
        cells.push(cell);
        return cells;
      }),
    );
}

describe('exports match the tables on the page', () => {
  it('CSV: the comparison and round tables, cell for cell', () => {
    const session = race();
    const comparison = comparisonTable(session);
    const rounds = roundTable(session);
    const [first, second] = parseCsv(toCsv([comparison, rounds]));
    expect(first?.[0]).toEqual(['Metric', 'Unit', 'Linux Box', 'Mac Studio', 'Result']);
    for (const [i, row] of comparison.rows.entries()) {
      const csv = first?.[i + 1] ?? [];
      expect(csv[0]).toBe(row.label);
      row.cells.forEach((cell, j) => {
        const value = csv[j + 2] ?? '';
        if (typeof cell.value === 'number') expect(Number(value)).toBeCloseTo(cell.value, 3);
        else expect(value).toBe(cell.value ?? '');
      });
    }
    expect(second?.[0]?.[0]).toBe('Round');
    expect(second?.map((row) => row[0])).toEqual(['Round', 'Round 1', 'Round 2', 'Round 3']);
    // Round 1, Linux Box: first answer word in ms, speed, RTT.
    expect(second?.[1]?.slice(2, 4)).toEqual(['900', '44']);
  });

  it('Markdown: every row and every value the page shows, with the winner in bold', () => {
    const session = race();
    const markdown = toMarkdown(session);
    const comparison = comparisonTable(session);
    for (const row of comparison.rows) {
      expect(markdown).toContain(row.label);
      for (const cell of row.cells) expect(markdown).toContain(cell.text);
    }
    const decode = comparison.rows.find((r) => r.key === 'decode');
    expect(decode?.cells[0]?.best).toBe(true);
    expect(markdown).toContain(`**${decode?.cells[0]?.text}**`);
    expect(markdown.split('\n')[0]).toBe('# Model Duel: Linux Box against Mac Studio');
    expect(markdown).toContain('## How to read this');
  });
});

describe('the scoreboard', () => {
  it('states ratios on length-independent metrics only, subject to the gate', () => {
    const lines = scoreboard(race());
    expect(lines.map((l) => l.key)).toEqual(['ttft', 'decode', 'chars']);
    expect(lines.find((l) => l.key === 'decode')).toEqual({
      key: 'decode',
      kind: 'win',
      text: 'Linux Box decodes 1.47× faster: 44.0 tok/s against 30.0 tok/s.',
      winnerId: 'fast',
    });
    expect(lines.every((l) => !/total|output|first answer/i.test(l.text))).toBe(true);
  });

  it('calls a close race a tie, and has nothing to say about one machine', () => {
    const session = race();
    // Overlapping ranges and medians within 10 percent: no winner.
    const values: Record<string, number[]> = { fast: [30, 32, 31], slow: [31, 30, 32] };
    for (const round of session.rounds) {
      for (const run of round.runs) {
        if (run.client) run.client.decodeTokPerSec = values[run.machineId]?.[round.index] ?? 0;
      }
    }
    const decode = scoreboard(session).find((l) => l.key === 'decode');
    expect(decode).toMatchObject({ kind: 'tie', winnerId: null });
    expect(decode?.text).toBe(
      'Decode speed is a tie: 31.0 tok/s against 31.0 tok/s, within the noise.',
    );
    expect(scoreboard(makeSession(['solo'], [[makeRun('solo')]]))).toEqual([]);
  });
});

describe('blind votes', () => {
  it('show only the answers: no name, id, colour or model before the reveal', () => {
    const session = race();
    const shown = JSON.stringify(blindRounds(session, [true, false, true]));
    for (const secret of [
      'Linux Box',
      'Mac Studio',
      'fast"',
      'slow"',
      '#aabbcc',
      'Model-A',
      '10.0.0.1',
    ]) {
      expect(shown).not.toContain(secret);
    }
    const rounds = blindRounds(session, [true, false, true]);
    expect(rounds[0]).toEqual({ round: 0, left: 'Fast says 44', right: 'Slow says 30' });
    expect(rounds[1]).toEqual({ round: 1, left: 'Slow says 29', right: 'Fast says 45' });
    expect(sidesOf(session, [true, false, true], 1)).toEqual({ left: 'slow', right: 'fast' });
  });

  it('shuffle sides both ways', () => {
    let n = 0;
    const sides = shuffleSides(6, () => (n++ % 2 === 0 ? 0.2 : 0.8));
    expect(sides).toEqual([true, false, true, false, true, false]);
  });

  it('add up per model pair across sessions', () => {
    const one = {
      ...race(),
      votes: [
        { round: 0, left: 'fast', right: 'slow', choice: 'left' as const, at: '' },
        { round: 1, left: 'slow', right: 'fast', choice: 'left' as const, at: '' },
        { round: 2, left: 'fast', right: 'slow', choice: 'tie' as const, at: '' },
      ],
    };
    const two = {
      ...race(),
      votes: [{ round: 0, left: 'slow', right: 'fast', choice: 'right' as const, at: '' }],
    };
    expect(tallyVotes([...labelVotes(one), ...labelVotes(two)])).toEqual([
      { a: 'org/Model-A Q4_K_M', b: 'org/Model-B Q8_0', winsA: 2, winsB: 1, ties: 1 },
    ]);
  });
});

describe('token timelines', () => {
  it('keep every token of a short run, thin a long one evenly, and keep its last point', () => {
    const events = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        t: 1000 + i * 10,
        event: { type: i < n / 4 ? 'reasoning' : 'content' },
      }));
    const short = tokenTimeline(events(50), 1000);
    expect(short).toHaveLength(50);
    expect(short[0]).toEqual([0, 1, 1]);
    const long = tokenTimeline(events(5000), 1000);
    expect(long).toHaveLength(TIMELINE_POINTS);
    expect(long[long.length - 1]).toEqual([49990, 5000, 0]);
  });
});
