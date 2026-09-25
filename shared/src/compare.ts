import type { RunView } from './chat';

export type Better = 'lower' | 'higher' | null;
export type MetricUnit =
  'ms' | 'tok/s' | 'chars/s' | 'tokens' | 'text' | 'J' | 'tok/J' | 'W' | '%' | 'GB' | '×';

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
    key: 'energy',
    label: 'Energy per run, approx.',
    unit: 'J',
    better: 'lower',
    pick: (r) => r.telemetry?.energy.energyJ,
  },
  {
    key: 'tokensPerJoule',
    label: 'Tokens per joule, approx.',
    unit: 'tok/J',
    better: 'higher',
    pick: (r) => r.telemetry?.energy.tokensPerJoule,
  },
  {
    key: 'decodePower',
    label: 'Mean power while decoding, approx.',
    unit: 'W',
    better: null,
    pick: (r) => r.telemetry?.energy.meanDecodePowerW,
  },
  {
    key: 'peakGpu',
    label: 'Peak GPU',
    unit: '%',
    better: null,
    pick: (r) => r.telemetry?.energy.peakGpuPct,
  },
  {
    key: 'peakMemory',
    label: 'Peak GPU memory or RAM',
    unit: 'GB',
    better: null,
    pick: (r) => r.telemetry?.energy.peakVramGb ?? r.telemetry?.energy.peakRamGb,
  },
  {
    key: 'finish',
    label: 'Finish reason',
    unit: 'text',
    better: null,
    pick: (r) => r.client?.finishReason ?? (r.state === 'done' ? null : r.state),
  },
];

const energyPerAudioMinute = (r: RunView): number | null => {
  const joules = r.telemetry?.energy.energyJ ?? null;
  const seconds = r.transcription?.audioSeconds ?? null;
  return joules === null || !seconds ? null : joules / (seconds / 60);
};

/** The metrics of a transcription race. */
export const TRANSCRIBE_METRICS: readonly MetricSpec[] = [
  {
    key: 'rtf',
    label: 'Real-time factor',
    unit: '×',
    better: 'higher',
    pick: (r) => r.transcription?.rtf,
  },
  {
    key: 'processing',
    label: 'Processing time',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.transcription?.processingMs,
  },
  {
    key: 'processingServer',
    label: 'Processing time, Unsloth',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.transcription?.serverProcessingMs,
  },
  {
    key: 'wer',
    label: 'Word error rate',
    unit: '%',
    better: 'lower',
    pick: (r) => (r.transcription?.wer ? r.transcription.wer.wer * 100 : null),
  },
  {
    key: 'upload',
    label: 'Upload time',
    unit: 'ms',
    better: null,
    pick: (r) => r.transcription?.uploadMs,
  },
  {
    key: 'load',
    label: 'Model load time',
    unit: 'ms',
    better: null,
    pick: (r) => r.transcription?.loadMs,
  },
  {
    key: 'energy',
    label: 'Energy per run, approx.',
    unit: 'J',
    better: 'lower',
    pick: (r) => r.telemetry?.energy.energyJ,
  },
  {
    key: 'joulesPerMinute',
    label: 'Energy per audio minute, approx.',
    unit: 'J',
    better: 'lower',
    pick: energyPerAudioMinute,
  },
  {
    key: 'peakGpu',
    label: 'Peak GPU',
    unit: '%',
    better: null,
    pick: (r) => r.telemetry?.energy.peakGpuPct,
  },
  {
    key: 'peakMemory',
    label: 'Peak GPU memory or RAM',
    unit: 'GB',
    better: null,
    pick: (r) => r.telemetry?.energy.peakVramGb ?? r.telemetry?.energy.peakRamGb,
  },
];

export function metricsFor(workload: 'text' | 'transcribe'): readonly MetricSpec[] {
  return workload === 'transcribe' ? TRANSCRIBE_METRICS : METRICS;
}
