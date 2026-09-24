import type { RunView } from './chat';

export type Better = 'lower' | 'higher' | null;
export type MetricUnit = 'ms' | 'tok/s' | 'chars/s' | 'tokens' | 'text';

export interface ComparisonRow {
  key: string;
  label: string;
  unit: MetricUnit;
  better: Better;
  /** One value per run, in the order given. */
  values: Array<number | string | null>;
  /** True where the value is the best of the finished runs. */
  best: boolean[];
}

interface RowSpec {
  key: string;
  label: string;
  unit: MetricUnit;
  better: Better;
  pick: (run: RunView) => number | string | null | undefined;
}

const ROWS: readonly RowSpec[] = [
  {
    key: 'firstAnswer',
    label: 'First answer word',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.client?.firstAnswerMs,
  },
  {
    key: 'ttft',
    label: 'Time to first token',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.client?.ttftMs,
  },
  {
    key: 'ttftServer',
    label: 'Time to first token, Unsloth',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.server?.monitor?.ttftMs,
  },
  {
    key: 'thinking',
    label: 'Thinking time',
    unit: 'ms',
    better: null,
    pick: (r) => r.client?.thinkingMs,
  },
  {
    key: 'decode',
    label: 'Decode speed',
    unit: 'tok/s',
    better: 'higher',
    pick: (r) => r.client?.decodeTokPerSec,
  },
  {
    key: 'decodeServer',
    label: 'Decode speed, Unsloth',
    unit: 'tok/s',
    better: 'higher',
    pick: (r) => r.server?.timings?.predictedPerSecond ?? r.server?.monitor?.tokPerSec,
  },
  {
    key: 'endToEnd',
    label: 'End-to-end speed',
    unit: 'tok/s',
    better: 'higher',
    pick: (r) => r.client?.endToEndTokPerSec,
  },
  {
    key: 'chars',
    label: 'Characters per second',
    unit: 'chars/s',
    better: 'higher',
    pick: (r) => r.client?.charsPerSec,
  },
  {
    key: 'prompt',
    label: 'Prompt processing, Unsloth',
    unit: 'tok/s',
    better: 'higher',
    pick: (r) => r.server?.timings?.promptPerSecond,
  },
  // Not marked: it grows with the number of tokens each model chose to write.
  {
    key: 'total',
    label: 'Total time',
    unit: 'ms',
    better: null,
    pick: (r) => r.client?.totalMs,
  },
  {
    key: 'output',
    label: 'Output tokens',
    unit: 'tokens',
    better: null,
    pick: (r) => r.client?.outputTokens ?? r.client?.chunks,
  },
  {
    key: 'finish',
    label: 'Finish reason',
    unit: 'text',
    better: null,
    pick: (r) => r.client?.finishReason ?? (r.state === 'done' ? null : r.state),
  },
];

/**
 * Marks the best value among runs that finished. Nothing is marked when fewer than two runs have
 * a value, or when every value is the same.
 */
export function bestOf(
  values: ReadonlyArray<number | string | null>,
  better: Better,
  eligible: readonly boolean[],
): boolean[] {
  const none = values.map(() => false);
  if (better === null) return none;
  const candidates = values.map((v, i) =>
    eligible[i] && typeof v === 'number' && Number.isFinite(v) ? v : null,
  );
  const numbers = candidates.filter((v): v is number => v !== null);
  if (numbers.length < 2) return none;
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  if (low === high) return none;
  const target = better === 'lower' ? low : high;
  return candidates.map((v) => v === target);
}

/** Metric rows by machine columns for the comparison table. */
export function compareRuns(runs: readonly RunView[]): ComparisonRow[] {
  const eligible = runs.map((run) => run.state === 'done');
  return ROWS.map((row) => {
    const values = runs.map((run) => row.pick(run) ?? null);
    return {
      key: row.key,
      label: row.label,
      unit: row.unit,
      better: row.better,
      values,
      best: bestOf(values, row.better, eligible),
    };
  });
}
