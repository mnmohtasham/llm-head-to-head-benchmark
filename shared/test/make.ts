import type { ClientMetrics, RunView } from '../src/chat';
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
  };
}

export function makeRound(index: number, runs: RunView[]): RoundView {
  return {
    index,
    startedAt: null,
    finishedAt: null,
    sendSkewMs: 0,
    order: runs.map((run) => run.machineId),
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
    schemaVersion: 2,
    id: '11111111-1111-4111-8111-111111111111',
    workload: 'text',
    createdAt: '2026-09-25T00:00:00.000Z',
    finishedAt: '2026-09-25T00:00:05.000Z',
    state: 'done',
    error: null,
    config: { prompt: 'Hi', maxTokens: 64, thinking: true, reasoningEffort: null, sampling: {} },
    plan: { rounds: rounds.length, warmup: warmup !== null, settleMs: 0, sequencing: 'concurrent' },
    machines: ids.map((id) => ({ id, name: id, color: '#fff', baseUrl: 'http://x', notes: '' })),
    warmup: warmup ? makeRound(-1, warmup) : null,
    rounds: rounds.map((runs, i) => makeRound(i, runs)),
    progress: { phase: 'finished', round: null },
    provenance: [],
    loopLagMs: null,
  };
}

export type { StoredSession };
