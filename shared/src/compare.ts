import type { RunView } from './chat';

export type Better = 'lower' | 'higher' | null;
export type MetricUnit =
  | 'ms'
  | 'tok/s'
  | 'chars/s'
  | 'tokens'
  | 'text'
  | 'J'
  | 'tok/J'
  | 'W'
  | '%'
  | 'GB'
  | '×'
  | 'steps/s'
  | 'fps'
  | 'MB';

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

/** The metrics of an image race, one image per run. */
export const IMAGE_METRICS: readonly MetricSpec[] = [
  {
    key: 'imageTime',
    label: 'Time per image',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.image?.totalMs,
  },
  {
    key: 'stepsPerSec',
    label: 'Denoising speed',
    unit: 'steps/s',
    better: 'higher',
    pick: (r) => r.image?.stepsPerSec,
  },
  {
    key: 'firstStep',
    label: 'Time to first step',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.image?.firstStepMs,
  },
  {
    key: 'decodeTail',
    label: 'Decode and save after the last step',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.image?.decodeTailMs,
  },
  {
    key: 'load',
    label: 'Model load time',
    unit: 'ms',
    better: null,
    pick: (r) => r.image?.loadMs,
  },
  {
    key: 'energyPerImage',
    label: 'Energy per image, approx.',
    unit: 'J',
    better: 'lower',
    pick: (r) => r.telemetry?.energy.energyJ,
  },
  {
    key: 'power',
    label: 'Mean power while denoising, approx.',
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
];

/** The metrics of a throughput race: one batch of requests per machine per round. */
export const THROUGHPUT_METRICS: readonly MetricSpec[] = [
  {
    key: 'aggregate',
    label: 'Aggregate output speed',
    unit: 'tok/s',
    better: 'higher',
    pick: (r) => r.throughput?.aggregateTokPerSec,
  },
  {
    key: 'perRequest',
    label: 'Speed of each request',
    unit: 'tok/s',
    better: 'higher',
    pick: (r) => r.throughput?.perRequestTokPerSec,
  },
  {
    key: 'ttftMedian',
    label: 'Time to first token, median request',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.throughput?.ttftMedianMs,
  },
  {
    key: 'ttftP95',
    label: 'Time to first token, 95th percentile',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.throughput?.ttftP95Ms,
  },
  {
    key: 'batchTime',
    label: 'Time for every request',
    unit: 'ms',
    better: null,
    pick: (r) => r.throughput?.totalMs,
  },
  {
    key: 'queued',
    label: 'Time with a request waiting for a slot',
    unit: 'ms',
    better: null,
    pick: (r) => r.throughput?.queue?.queuedMs,
  },
  {
    key: 'outputTokens',
    label: 'Output tokens, all requests',
    unit: 'tokens',
    better: null,
    pick: (r) => r.throughput?.outputTokens,
  },
  {
    key: 'energy',
    label: 'Energy per batch, approx.',
    unit: 'J',
    better: null,
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

/** The metrics of a command race: one encode per machine per round. */
export const COMMAND_METRICS: readonly MetricSpec[] = [
  {
    key: 'encodeTime',
    label: 'Encode time',
    unit: 'ms',
    better: 'lower',
    pick: (r) => r.command?.wallMs,
  },
  {
    key: 'encodeFps',
    label: 'Frames per second',
    unit: 'fps',
    better: 'higher',
    pick: (r) => r.command?.fps,
  },
  {
    key: 'encodeSpeed',
    label: 'Speed',
    unit: '×',
    better: 'higher',
    pick: (r) => r.command?.speed,
  },
  {
    key: 'firstFrame',
    label: 'Time to first progress with a frame',
    unit: 'ms',
    better: null,
    pick: (r) => r.command?.firstFrameMs,
  },
  {
    key: 'outputSize',
    label: 'Output size',
    unit: 'MB',
    better: null,
    pick: (r) => (r.command?.outputBytes ? r.command.outputBytes / 1e6 : null),
  },
  {
    key: 'energyPerEncode',
    label: 'Energy per encode, approx.',
    unit: 'J',
    better: 'lower',
    pick: (r) => r.telemetry?.energy.energyJ,
  },
  {
    key: 'agentCpuPower',
    label: 'Mean CPU power, agent, approx.',
    unit: 'W',
    better: null,
    pick: (r) => r.command?.agentTelemetry?.meanCpuPowerW,
  },
  {
    key: 'agentGpuPower',
    label: 'Mean GPU power, agent, approx.',
    unit: 'W',
    better: null,
    pick: (r) => r.command?.agentTelemetry?.meanGpuPowerW,
  },
  {
    key: 'encoderUse',
    label: 'Peak video encoder use',
    unit: '%',
    better: null,
    pick: (r) => r.command?.agentTelemetry?.peakEncoderPct,
  },
  {
    key: 'peakGpu',
    label: 'Peak GPU',
    unit: '%',
    better: null,
    pick: (r) => r.telemetry?.energy.peakGpuPct,
  },
];

/** Which set of metrics and round cells a session uses. */
export type MetricKind = 'text' | 'throughput' | 'transcribe' | 'image' | 'command';

export function metricKind(session: {
  workload: 'text' | 'transcribe' | 'image' | 'command';
  config: unknown;
}): MetricKind {
  if (session.workload !== 'text') return session.workload;
  return (session.config as { mode?: string }).mode === 'throughput' ? 'throughput' : 'text';
}

export function metricsFor(kind: MetricKind): readonly MetricSpec[] {
  return kind === 'transcribe'
    ? TRANSCRIBE_METRICS
    : kind === 'image'
      ? IMAGE_METRICS
      : kind === 'throughput'
        ? THROUGHPUT_METRICS
        : kind === 'command'
          ? COMMAND_METRICS
          : METRICS;
}
