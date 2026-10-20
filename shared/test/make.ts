import { DEFAULT_SAMPLING, type ClientMetrics, type RunView } from '../src/chat';
import type { ModelStatus } from '../src/models';
import type { DeviceRun } from '../src/runs';
import type { RoundView, SessionView, StoredSession } from '../src/session';

/** A finished run with plausible numbers; override what a test cares about. */
export function makeRun(
  machineId: string,
  over: Partial<ClientMetrics> = {},
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
    coalescedChunks: 0,
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
    rtt: null,
    telemetry: null,
    timeline: null,
    requestedAtMs: null,
    transcription: null,
    image: null,
    throughput: null,
  };
}

export function makeRound(index: number, runs: RunView[]): RoundView {
  return {
    index,
    startedAt: null,
    finishedAt: null,
    sendSkewMs: 0,
    order: runs.map((run) => run.machineId),
    nonce: null,
    runs,
    loopLagMs: null,
    flags: [],
  };
}

/** A session over the given machine ids, with one round per entry of `rounds`. */
export function makeSession(
  ids: string[],
  rounds: RunView[][],
  warmup: RunView[] | null = null,
): SessionView {
  return {
    schemaVersion: 9,
    id: '11111111-1111-4111-8111-111111111111',
    workload: 'text',
    createdAt: '2026-09-25T00:00:00.000Z',
    finishedAt: '2026-09-25T00:00:05.000Z',
    state: 'done',
    error: null,
    config: {
      preset: 'custom',
      prompt: 'Hi',
      maxTokens: 64,
      thinking: true,
      reasoningEffort: null,
      prefill: 'cold',
      sampling: DEFAULT_SAMPLING,
      mode: 'latency',
      concurrency: 1,
    },
    plan: { rounds: rounds.length, warmup: warmup !== null, settleMs: 0, sequencing: 'concurrent' },
    machines: ids.map((id) => ({ id, name: id, color: '#fff', baseUrl: 'http://x', notes: '' })),
    warmup: warmup ? makeRound(-1, warmup) : null,
    rounds: rounds.map((runs, i) => makeRound(i, runs)),
    progress: { phase: 'finished', round: null },
    telemetry: { enabled: false },
    votes: [],
    provenance: [],
    loopLagMs: null,
  };
}

export type { StoredSession };

/** A loaded GGUF model with every field filled in; override what a test cares about. */
export function makeStatus(over: Partial<ModelStatus> = {}): ModelStatus {
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

/** A Results row of a finished text race on an RTX 3060; override what a test cares about. */
export function makeDeviceRun(over: Partial<DeviceRun> = {}): DeviceRun {
  const sessionId = over.sessionId ?? '11111111-1111-4111-8111-111111111111';
  const machineId = over.machineId ?? 'rtx';
  return {
    key: `${sessionId}/${machineId}`,
    sessionId,
    machineId,
    workload: 'text',
    kind: 'text',
    createdAt: '2026-10-01T12:00:00.000Z',
    state: 'done',
    error: null,
    rounds: 3,
    roundsDone: 3,
    machine: 'test',
    color: '#ef8fb0',
    cloud: null,
    server: 'unsloth',
    others: [],
    gpu: 'NVIDIA GeForce RTX 3060',
    gpuMemoryGb: 12,
    memoryGb: 30.24,
    platform: 'CUDA',
    os: 'Linux-6.17.0-41-generic-x86_64',
    studio: '0.1.815-beta',
    llamaCpp: 'b9601',
    model: 'unsloth/Qwen3.8-27B-GGUF',
    quant: 'Q4_K_M',
    engine: 'GGUF',
    contextLength: 32768,
    kvCache: null,
    gpuLayers: -1,
    totalLayers: 34,
    slots: 4,
    speculative: 'off',
    gpuMemoryMode: null,
    chatModel: true,
    prompt: 'Short',
    promptText: 'Explain the difference between latency and throughput.',
    promptTokens: 42,
    prefill: 'cold',
    thinking: 'off',
    maxTokens: 512,
    concurrency: null,
    settings: null,
    metrics: { decode: 55, decodeServer: 57, ttft: 160, ttftServer: 150, finish: 'stop ×3' },
    means: { decode: 54, decodeServer: 56, ttft: 170, ttftServer: 155, finish: 'stop ×3' },
    wins: [],
    ...over,
  };
}
