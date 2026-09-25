import type { QueueObservation, RequestResult, ThroughputResult } from './chat';

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The nearest-rank percentile: with four values, p95 is the largest. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/**
 * One machine's batch added up. The aggregate speed divides every finished request's output tokens
 * by the time from the first request sent to the last one done, so the prompt processing and any
 * wait for a slot count against it, as they would for a server.
 */
export function summarizeThroughput(
  requests: readonly RequestResult[],
  concurrency: number,
  queue: QueueObservation | null,
): ThroughputResult {
  const done = requests.filter((r) => r.state === 'done' && r.totalMs !== null);
  const outputTokens = done.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
  const first = requests.length > 0 ? Math.min(...requests.map((r) => r.sendOffsetMs)) : 0;
  const last =
    done.length > 0 ? Math.max(...done.map((r) => r.sendOffsetMs + (r.totalMs ?? 0))) : null;
  const totalMs = last === null ? null : last - first;
  const ttfts = done.map((r) => r.ttftMs).filter((v): v is number => v !== null);
  return {
    concurrency,
    requests: [...requests],
    aggregateTokPerSec: totalMs && totalMs > 0 ? outputTokens / (totalMs / 1000) : null,
    outputTokens,
    totalMs,
    ttftMedianMs: median(ttfts),
    ttftP95Ms: percentile(ttfts, 95),
    perRequestTokPerSec: median(
      done.map((r) => r.decodeTokPerSec).filter((v): v is number => v !== null),
    ),
    queue,
  };
}

/** One reading of Unsloth's admission queue, from the monitor. */
export interface QueueSample {
  at: number;
  capacity: number | null;
  active: number;
  queued: number;
}

/** Adds up the queue readings: the peaks, and how long at least one request was waiting. */
export function observeQueue(samples: readonly QueueSample[]): QueueObservation | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  let queuedMs = 0;
  sorted.forEach((sample, i) => {
    const next = sorted[i + 1];
    if (next && sample.queued > 0) queuedMs += next.at - sample.at;
  });
  return {
    capacity: [...sorted].reverse().find((s) => s.capacity !== null)?.capacity ?? null,
    maxActive: Math.max(...sorted.map((s) => s.active)),
    maxQueued: Math.max(...sorted.map((s) => s.queued)),
    queuedMs: Math.round(queuedMs),
    samples: sorted.length,
  };
}
