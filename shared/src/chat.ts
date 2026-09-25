import { z } from 'zod';
import { PRESET_IDS, withNonce } from './presets';
import type { RunEnergy, TelemetrySample } from './telemetry';
import { detailOf } from './probe';
import type { SseMessage } from './sse';

/**
 * Streaming chat against Unsloth's `/v1/chat/completions`, as verified in its source: a role
 * chunk, thinking as `delta.reasoning_content` (with an empty `content` beside it), the answer as
 * `delta.content`, a final chunk with `finish_reason`, a chunk with `choices: []`, `usage` and
 * llama.cpp `timings` when `stream_options.include_usage` is set, then `data: [DONE]`. Quiet
 * gaps carry `: keep-alive` comments. A failure after the headers arrives as
 * `data: {"error": {...}}` followed by `[DONE]`.
 */

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
}

/** llama.cpp's own measurements, relayed by Unsloth in the usage chunk. */
export interface Timings {
  promptN: number | null;
  promptMs: number | null;
  promptPerSecond: number | null;
  predictedN: number | null;
  predictedMs: number | null;
  predictedPerSecond: number | null;
  /** Prompt tokens taken from the prompt cache; `promptN` counts only the new ones. */
  cacheN: number | null;
  /** Tokens drafted by speculative decoding, and how many of them were kept. */
  draftN: number | null;
  draftAccepted: number | null;
}

export type ChatEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'finish'; reason: string }
  | { type: 'usage'; usage: Usage; timings: Timings | null }
  | { type: 'truncated'; info: Record<string, unknown> }
  | { type: 'error'; message: string; code: string | null }
  | { type: 'done' }
  | { type: 'keepalive' }
  | { type: 'ignored'; why: string };

export interface TimedEvent {
  t: number;
  read: number;
  event: ChatEvent;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Frames Unsloth paints its own UI with. They never carry model output. */
const UI_FRAME_TYPES = new Set([
  'tool_start',
  'tool_end',
  'tool_output',
  'tool_args',
  'tool_status',
  'diffusion_frame',
  'reasoning_summary',
]);

function readUsage(value: unknown): Usage {
  const u = obj(value) ?? {};
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cachedTokens: num(obj(u.prompt_tokens_details)?.cached_tokens),
  };
}

function readTimings(value: unknown): Timings | null {
  const t = obj(value);
  if (!t) return null;
  return {
    promptN: num(t.prompt_n),
    promptMs: num(t.prompt_ms),
    promptPerSecond: num(t.prompt_per_second),
    predictedN: num(t.predicted_n),
    predictedMs: num(t.predicted_ms),
    predictedPerSecond: num(t.predicted_per_second),
    cacheN: num(t.cache_n),
    draftN: num(t.draft_n),
    draftAccepted: num(t.draft_n_accepted),
  };
}

/** Turns one SSE message into what it means for a chat run. A chunk can mean several things. */
export function interpretMessage(message: SseMessage): ChatEvent[] {
  if (message.kind === 'comment') return [{ type: 'keepalive' }];
  const raw = message.data.trim();
  if (raw === '[DONE]') return [{ type: 'done' }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ type: 'ignored', why: 'not JSON' }];
  }
  const chunk = obj(parsed);
  if (!chunk) return [{ type: 'ignored', why: 'not an object' }];
  if (typeof chunk.type === 'string' && UI_FRAME_TYPES.has(chunk.type)) {
    return [{ type: 'ignored', why: chunk.type }];
  }
  if ('_toolEvent' in chunk || '_toolStatus' in chunk)
    return [{ type: 'ignored', why: 'tool event' }];
  const error = obj(chunk.error);
  if (error || typeof chunk.error === 'string') {
    return [
      {
        type: 'error',
        message: detailOf(chunk) || 'Unsloth reported an error without a message.',
        code: text(error?.code),
      },
    ];
  }

  const events: ChatEvent[] = [];
  const truncated = obj(chunk.context_truncated);
  if (truncated) events.push({ type: 'truncated', info: truncated });
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choice of choices.map(obj)) {
    if (!choice) continue;
    const delta = obj(choice.delta) ?? {};
    // Unsloth renames vLLM's and Ollama's `reasoning` to `reasoning_content`; accept both.
    const reasoning = text(delta.reasoning_content) ?? text(delta.reasoning);
    if (reasoning) events.push({ type: 'reasoning', text: reasoning });
    const content = text(delta.content);
    if (content) events.push({ type: 'content', text: content });
    const reason = text(choice.finish_reason);
    if (reason) events.push({ type: 'finish', reason });
  }
  if (obj(chunk.usage) || obj(chunk.timings)) {
    events.push({
      type: 'usage',
      usage: readUsage(chunk.usage),
      timings: readTimings(chunk.timings),
    });
  }
  return events.length > 0 ? events : [{ type: 'ignored', why: 'no output' }];
}

export function isTokenEvent(
  event: ChatEvent,
): event is { type: 'reasoning' | 'content'; text: string } {
  return event.type === 'reasoning' || event.type === 'content';
}

/** Counts user-perceived characters, so an emoji counts once however it is encoded. */
export function countChars(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

export interface GapStats {
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

export function gapStats(gaps: readonly number[]): GapStats | null {
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return {
    meanMs: gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length,
    medianMs: median,
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Everything the controller saw of one streamed request, on one monotonic clock. */
export interface RunTimeline {
  /** When the request was handed to the network, connection setup included. */
  requestAt: number;
  headersAt: number | null;
  endAt: number;
  events: TimedEvent[];
}

export interface ClientMetrics {
  /** Headers arrived. Diagnostic only: servers flush headers at different moments. */
  ttfbMs: number | null;
  /** First token of any kind, thinking included. */
  ttftMs: number | null;
  firstReasoningMs: number | null;
  /** First answer token: what a person waits for. */
  firstAnswerMs: number | null;
  thinkingMs: number | null;
  totalMs: number;
  /** From the first token to the last. */
  decodeMs: number | null;
  promptTokens: number | null;
  /** From usage; null when the server sent none. */
  outputTokens: number | null;
  cachedTokens: number | null;
  /** (output tokens - 1) / decode time. Uses the chunk count when usage is missing. */
  decodeTokPerSec: number | null;
  tokensEstimated: boolean;
  /** Output tokens / total time. */
  endToEndTokPerSec: number | null;
  charsPerSec: number | null;
  reasoningChars: number;
  answerChars: number;
  /** Chunks carrying thinking or answer text. */
  chunks: number;
  /** Chunks that arrived in the same network read as the chunk before them. */
  coalescedChunks: number;
  interChunk: GapStats | null;
  finishReason: string | null;
  truncated: boolean;
  keepalives: number;
  sawDone: boolean;
}

const perSecond = (count: number, ms: number): number | null =>
  ms > 0 ? (count * 1000) / ms : null;

export function computeClientMetrics(timeline: RunTimeline): ClientMetrics {
  const { requestAt, headersAt, endAt, events } = timeline;
  const tokens = events.filter((e) => isTokenEvent(e.event));
  const since = (t: number | undefined) => (t === undefined ? null : t - requestAt);
  const firstReasoning = events.find((e) => e.event.type === 'reasoning');
  const firstAnswer = events.find((e) => e.event.type === 'content');
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const usageEvent = [...events].reverse().find((e) => e.event.type === 'usage')?.event;
  const usage = usageEvent?.type === 'usage' ? usageEvent.usage : null;
  const finish = [...events].reverse().find((e) => e.event.type === 'finish')?.event;
  const done = events.find((e) => e.event.type === 'done');
  const endOfOutput = done ? done.t : endAt;

  let reasoningChars = 0;
  let answerChars = 0;
  for (const { event } of tokens) {
    if (event.type === 'reasoning') reasoningChars += countChars(event.text);
    if (event.type === 'content') answerChars += countChars(event.text);
  }

  const gaps: number[] = [];
  let coalesced = 0;
  for (let i = 1; i < tokens.length; i += 1) {
    const current = tokens[i];
    const previous = tokens[i - 1];
    if (!current || !previous) continue;
    gaps.push(current.t - previous.t);
    if (current.read === previous.read) coalesced += 1;
  }

  const decodeMs = first && last ? last.t - first.t : null;
  const outputTokens = usage?.completionTokens ?? null;
  const counted = outputTokens ?? tokens.length;
  const totalMs = endOfOutput - requestAt;
  const firstReasoningMs = since(firstReasoning?.t);
  const firstAnswerMs = since(firstAnswer?.t);

  return {
    ttfbMs: headersAt === null ? null : headersAt - requestAt,
    ttftMs: since(first?.t),
    firstReasoningMs,
    firstAnswerMs,
    thinkingMs:
      firstReasoningMs !== null && firstAnswerMs !== null ? firstAnswerMs - firstReasoningMs : null,
    totalMs,
    decodeMs,
    promptTokens: usage?.promptTokens ?? null,
    outputTokens,
    cachedTokens: usage?.cachedTokens ?? null,
    decodeTokPerSec: decodeMs !== null && counted > 1 ? perSecond(counted - 1, decodeMs) : null,
    tokensEstimated: outputTokens === null,
    endToEndTokPerSec: counted > 0 ? perSecond(counted, totalMs) : null,
    charsPerSec: decodeMs !== null ? perSecond(reasoningChars + answerChars, decodeMs) : null,
    reasoningChars,
    answerChars,
    chunks: tokens.length,
    coalescedChunks: coalesced,
    interChunk: gapStats(gaps),
    finishReason: finish?.type === 'finish' ? finish.reason : null,
    truncated: events.some((e) => e.event.type === 'truncated'),
    keepalives: events.filter((e) => e.event.type === 'keepalive').length,
    sawDone: done !== undefined,
  };
}

/** Unsloth's API monitor row for the request, when it could be found. */
export interface MonitorRow {
  ttftMs: number | null;
  tokPerSec: number | null;
  promptTokPerSec: number | null;
  durationMs: number | null;
  decodeMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  stopReason: string | null;
  status: string | null;
}

/**
 * Finds this run's row among the monitor entries without clearing anyone's history: a chat
 * completion whose recorded prompt starts with ours, finished within `withinSec` of the
 * monitor's own clock, newest first.
 */
export function findMonitorRow(body: unknown, prompt: string, withinSec = 60): MonitorRow | null {
  const b = obj(body);
  if (!b) return null;
  const serverTime = num(b.server_time);
  const expected = `user: ${prompt}`.slice(0, 200);
  const entries = (Array.isArray(b.entries) ? b.entries : [])
    .map(obj)
    .filter((e): e is Json => e !== null)
    .filter((e) => String(e.endpoint ?? '').includes('chat/completions'))
    .filter((e) => String(e.prompt_preview ?? '').startsWith(expected))
    .filter((e) => {
      const finished = num(e.finished_at) ?? num(e.updated_at);
      return serverTime === null || finished === null || serverTime - finished <= withinSec;
    })
    .sort((a, c) => (num(c.started_at) ?? 0) - (num(a.started_at) ?? 0));
  const row = entries[0];
  if (!row) return null;
  return {
    ttftMs: num(row.ttft_ms),
    tokPerSec: num(row.tok_per_sec),
    promptTokPerSec: num(row.prompt_tok_per_sec),
    durationMs: num(row.duration_ms),
    decodeMs: num(row.decode_ms),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    stopReason: typeof row.stop_reason === 'string' ? row.stop_reason : null,
    status: typeof row.status === 'string' ? row.status : null,
  };
}

/** What Unsloth measured, next to what Model Duel measured. */
export interface ServerMetrics {
  timings: Timings | null;
  monitor: MonitorRow | null;
}

/** The thinking block is open while the model thinks and folds away at the first answer token. */
export type ThinkingState = 'waiting' | 'thinking' | 'answering';

export function nextThinkingState(state: ThinkingState, event: ChatEvent): ThinkingState {
  if (event.type === 'content') return 'answering';
  if (event.type === 'reasoning' && state === 'waiting') return 'thinking';
  return state;
}

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
  'xhigh',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * True when thinking was asked for but no thinking text arrived on its own. A model that skips its
 * thinking block writes its reasoning into the answer, which makes the first answer token early.
 */
export function thinkingMissing(thinkingRequested: boolean, metrics: ClientMetrics): boolean {
  return thinkingRequested && metrics.reasoningChars === 0 && metrics.answerChars > 0;
}

/** Every sampling field, always sent, so server defaults can never differ between machines. */
export const samplingSchema = z.object({
  temperature: z
    .number()
    .min(0, 'Temperature starts at 0.')
    .max(2, 'Keep temperature at 2 or less.')
    .default(0.6),
  topP: z.number().gt(0, 'Top-p must be above 0.').max(1, 'Top-p is at most 1.').default(0.95),
  topK: z.number().int('Top-k is a whole number.').min(0).max(1000).default(20),
  minP: z.number().min(0).max(1, 'Min-p is at most 1.').default(0),
  repetitionPenalty: z
    .number()
    .min(0.5)
    .max(2, 'Keep the repetition penalty at 2 or less.')
    .default(1),
  /** Sent only with cold prefill, where it also turns llama.cpp's prompt cache off. */
  seed: z.number().int('The seed is a whole number.').min(0).max(2_147_483_647).default(42),
});
export type Sampling = z.infer<typeof samplingSchema>;
export const DEFAULT_SAMPLING: Sampling = samplingSchema.parse({});

/**
 * Cold prefill puts a fresh nonce at the start of every round's prompt and sends a fixed seed, so
 * no machine can reuse a cached prompt. Warm sends the same prompt every round and no seed.
 */
export const PREFILL_MODES = ['cold', 'warm'] as const;
export type PrefillMode = (typeof PREFILL_MODES)[number];

/** What a text run asks every machine for. */
export const textConfigSchema = z
  .object({
    preset: z.enum(PRESET_IDS).default('custom'),
    /** The prompt for `custom`; the server fills in the preset's prompt for the others. */
    prompt: z.string().trim().max(200_000, 'That prompt is too long.').default(''),
    maxTokens: z
      .number()
      .int('Use a whole number of tokens.')
      .min(1, 'Allow at least 1 token.')
      .max(131_072, 'Use at most 131,072 tokens.'),
    thinking: z.boolean(),
    reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
    prefill: z.enum(PREFILL_MODES).default('cold'),
    sampling: samplingSchema.prefault({}),
  })
  .refine((config) => config.preset !== 'custom' || config.prompt.length > 0, {
    message: 'Write a prompt.',
    path: ['prompt'],
  });
export type TextConfig = z.infer<typeof textConfigSchema>;

/** `queued` waits for its turn when machines run one after another. */
export type RunState = 'starting' | 'queued' | 'streaming' | 'done' | 'failed' | 'cancelled';

/** Round trips to a machine's health route on an open connection, before a round. */
export interface RttResult {
  samplesMs: number[];
  medianMs: number | null;
}

/** Numbers the pane shows while tokens arrive. */
export interface LiveMetrics {
  elapsedMs: number;
  ttftMs: number | null;
  firstAnswerMs: number | null;
  chunks: number;
  /** From the chunk count, until the final usage arrives. */
  decodeTokPerSec: number | null;
}

export interface RunView {
  id: string;
  machineId: string;
  machineName: string;
  prompt: string;
  maxTokens: number;
  thinking: boolean;
  reasoningEffort: string | null;
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  modelBefore: string | null;
  modelAfter: string | null;
  reasoning: string;
  answer: string;
  live: LiveMetrics;
  client: ClientMetrics | null;
  server: ServerMetrics | null;
  error: string | null;
  /** Controller event-loop delay during the run: large values mean the timings are suspect. */
  loopLagMs: { max: number; p99: number } | null;
  /** How long after the first machine's request this machine's request left, in a race. */
  sendOffsetMs: number | null;
  /** Measured just before the round; null when not measured. */
  rtt: RttResult | null;
  /** Hardware samples around the run and what they add up to; null with telemetry off. */
  telemetry: RunTelemetry | null;
  /**
   * Tokens against time for the race chart: `[ms since the request, tokens so far, 1 while
   * thinking]`, thinned to a few hundred points.
   */
  timeline: Array<[number, number, 0 | 1]> | null;
  /** When the request left, epoch ms on the controller's clock, to line up telemetry. */
  requestedAtMs: number | null;
}

export interface RunTelemetry {
  /** From five seconds before the request to five seconds after the end. */
  samples: TelemetrySample[];
  energy: RunEnergy;
}

/**
 * The request body for one run. Every sampling field is sent. With cold prefill the round's nonce
 * starts the message and the seed is sent; with warm prefill neither is. Machines in a round get
 * the same body apart from `model`.
 */
export function chatRequestBody(
  config: Pick<
    TextConfig,
    'prompt' | 'maxTokens' | 'thinking' | 'reasoningEffort' | 'prefill' | 'sampling'
  >,
  model: string,
  cancelId: string,
  nonce: string | null = null,
): Record<string, unknown> {
  const s = config.sampling;
  const cold = config.prefill === 'cold';
  return {
    model,
    messages: [{ role: 'user', content: withNonce(config.prompt, cold ? nonce : null) }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: config.maxTokens,
    enable_thinking: config.thinking,
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
    temperature: s.temperature,
    top_p: s.topP,
    top_k: s.topK,
    min_p: s.minP,
    repetition_penalty: s.repetitionPenalty,
    ...(cold ? { seed: s.seed } : {}),
    cancel_id: cancelId,
  };
}
