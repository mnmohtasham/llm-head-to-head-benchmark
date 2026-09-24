import type { RunView } from './chat';

export type Better = 'lower' | 'higher' | null;
export type MetricUnit = 'ms' | 'tok/s' | 'chars/s' | 'tokens' | 'text';

export interface MetricSpec {
  key: string;
  label: string;
  unit: MetricUnit;
  better: Better;
  pick: (run: RunView) => number | string | null | undefined;
}

/** The metrics compared between machines, with which direction is better. */
export const METRICS: readonly MetricSpec[] = [
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
