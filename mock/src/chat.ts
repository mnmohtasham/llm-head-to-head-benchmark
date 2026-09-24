import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoadedModel } from './profiles';

/** How the fake Unsloth streams. Every field can be changed through `/__mock/config`. */
export interface StreamConfig {
  /** Prompt processing before the first token; null uses the profile's value. */
  startupMs: number | null;
  /** Time per token; null uses the profile's value. */
  tokenMs: number | null;
  jitterMs: number;
  reasoningTokens: number;
  answerTokens: number;
  tokensPerChunk: number;
  /** Send a `: keep-alive` comment when nothing else was sent for this long. */
  keepaliveEveryMs: number;
  /** Go silent after this many tokens, keeping the connection open. */
  stallAfterTokens: number | null;
  /** Drop the connection after this many tokens. */
  disconnectAfterTokens: number | null;
  /** Send an in-band error frame after this many tokens. */
  errorAfterTokens: number | null;
  errorMessage: string;
  /** Mix in Unsloth UI frames an API client must ignore. */
  toolFrames: boolean;
  /** Report that the prompt was cut to fit the context. */
  truncated: boolean;
  /** Send the thinking as answer text, as a model does when it skips its thinking block. */
  thinkingInAnswer: boolean;
  /** Report this many prompt tokens as served from the prompt cache. */
  cachedPromptTokens: number;
  /** Report speculative decoding with this share of drafts accepted; null reports none. */
  draftAcceptRate: number | null;
  /**
   * Round-to-round variation: each chat request takes the next factor in turn and multiplies its
   * startup and token times by it. Null or empty keeps every request at the same speed.
   */
  speedFactors: number[] | null;
}

export const DEFAULT_STREAM: StreamConfig = {
  startupMs: null,
  tokenMs: null,
  jitterMs: 3,
  reasoningTokens: 40,
  answerTokens: 90,
  tokensPerChunk: 1,
  keepaliveEveryMs: 10_000,
  stallAfterTokens: null,
  disconnectAfterTokens: null,
  errorAfterTokens: null,
  errorMessage: 'Context size has been exceeded.',
  toolFrames: false,
  truncated: false,
  thinkingInAnswer: false,
  cachedPromptTokens: 0,
  draftAcceptRate: null,
  speedFactors: null,
};

// Multibyte words on purpose, so clients meet split UTF-8 sequences.
const WORDS = [
  'the',
  'model',
  'reads',
  'every',
  'layer',
  'of',
  'weights',
  'from',
  'memory',
  'café',
  'naïve',
  'Zürich',
  'déjà',
  'vu',
  'token',
  'cache',
  'speed',
  '日本語',
  '🙂',
  'prompt',
  'answer',
  'quantized',
  'bandwidth',
  'matters',
  'more',
  'than',
  'compute',
  'here',
  'so',
  'the',
  'faster',
  'machine',
  'wins',
];

function words(seed: number, count: number, offset: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => ` ${WORDS[(seed + (i + offset) * 7) % WORDS.length]}`,
  );
}

function seedOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
  return hash;
}

export interface MonitorEntry {
  id: string;
  endpoint: string;
  method: string;
  model: string;
  via_api_key: boolean;
  prompt_preview: string;
  reply_preview: string;
  status: 'streaming' | 'done' | 'cancelled' | 'error';
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  ttft_ms: number | null;
  tok_per_sec: number | null;
  prompt_tok_per_sec: number | null;
  decode_ms: number | null;
  stop_reason: string | null;
  error: string | null;
  kind: 'request';
}

export interface ChatDeps {
  model: LoadedModel;
  stream: StreamConfig;
  startupMs: number;
  tokenMs: number;
  monitor: MonitorEntry[];
  /** Registers a cancel function under the request's cancel_id; returns an unregister function. */
  onCancelId: (id: string, cancel: () => void) => () => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function promptText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .map((m) => {
      const msg = (m ?? {}) as { role?: unknown; content?: unknown };
      return `${typeof msg.role === 'string' ? msg.role : 'message'}: ${typeof msg.content === 'string' ? msg.content : ''}`;
    })
    .join('\n\n');
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1] as { content?: unknown } | undefined;
  return typeof last?.content === 'string' ? last.content : '';
}

/** Streams one chat completion the way Unsloth relays llama-server, onto the raw response. */
export async function streamChat(
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
  deps: ChatDeps,
): Promise<void> {
  const { model, stream: cfg, monitor } = deps;
  const started = performance.now();
  const startedAt = Date.now() / 1000;
  const prompt = lastUserText(body);
  const seed = seedOf(prompt);
  const promptTokens = Math.max(1, prompt.split(/\s+/).filter(Boolean).length + 4);
  const thinking = model.entry.supportsReasoning && body.enable_thinking !== false;
  const maxTokens =
    typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 1_000_000;
  const includeUsage =
    (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
  const planned = [
    ...(thinking
      ? words(seed, cfg.reasoningTokens, 0).map((text) => ({
          kind: cfg.thinkingInAnswer ? ('content' as const) : ('reasoning' as const),
          text,
        }))
      : []),
    ...words(seed, cfg.answerTokens, 1000).map((text) => ({ kind: 'content' as const, text })),
  ];
  const tokens = planned.slice(0, maxTokens);
  const finishReason = planned.length > maxTokens ? 'length' : 'stop';

  const entry: MonitorEntry = {
    id: `mon-${Math.random().toString(16).slice(2, 10)}`,
    endpoint: '/v1/chat/completions',
    method: 'POST',
    model: model.entry.modelId,
    via_api_key: true,
    prompt_preview: promptText(body).slice(0, 360),
    reply_preview: '',
    status: 'streaming',
    started_at: startedAt,
    updated_at: startedAt,
    finished_at: null,
    duration_ms: null,
    prompt_tokens: promptTokens,
    completion_tokens: null,
    total_tokens: null,
    ttft_ms: null,
    tok_per_sec: null,
    prompt_tok_per_sec: null,
    decode_ms: null,
    stop_reason: null,
    error: null,
    kind: 'request',
  };
  monitor.unshift(entry);
  if (monitor.length > 50) monitor.pop();

  let stopped = false;
  let cancelled = false;
  const stop = () => {
    stopped = true;
  };
  request.on('close', () => {
    if (!response.writableEnded) {
      cancelled = true;
      stop();
    }
  });
  const cancelId = typeof body.cancel_id === 'string' ? body.cancel_id : null;
  const unregister = cancelId
    ? deps.onCancelId(cancelId, () => {
        cancelled = true;
        stop();
      })
    : () => undefined;

  const id = `chatcmpl-${seed}`;
  const created = Math.floor(startedAt);
  let lastWrite = performance.now();
  const write = (text: string) => {
    if (response.writableEnded || response.destroyed) return;
    response.write(text);
    lastWrite = performance.now();
  };
  const chunk = (payload: Record<string, unknown>) =>
    write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model.entry.modelId, ...payload })}\n\n`,
    );
  const waitWithKeepalive = async (ms: number) => {
    const until = performance.now() + ms;
    while (!stopped && performance.now() < until) {
      const next = Math.min(until, lastWrite + cfg.keepaliveEveryMs);
      await sleep(next - performance.now());
      if (!stopped && performance.now() - lastWrite >= cfg.keepaliveEveryMs)
        write(': keep-alive\n\n');
    }
  };

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  chunk({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
  if (cfg.truncated)
    chunk({ choices: [], context_truncated: { dropped_messages: 1, kept_tokens: 4096 } });
  if (cfg.toolFrames)
    write(`data: ${JSON.stringify({ type: 'tool_status', content: 'Searching' })}\n\n`);

  await waitWithKeepalive(deps.startupMs);
  let firstTokenAt: number | null = null;
  let lastTokenAt: number | null = null;
  let sent = 0;
  let reply = '';
  let failure: string | null = null;

  for (let i = 0; i < tokens.length && !stopped; i += cfg.tokensPerChunk) {
    if (cfg.disconnectAfterTokens !== null && sent >= cfg.disconnectAfterTokens) {
      response.destroy();
      stopped = true;
      failure = 'disconnected';
      break;
    }
    if (cfg.stallAfterTokens !== null && sent >= cfg.stallAfterTokens) {
      while (!stopped) await sleep(20);
      break;
    }
    if (cfg.errorAfterTokens !== null && sent >= cfg.errorAfterTokens) {
      failure = cfg.errorMessage;
      write(
        `data: ${JSON.stringify({ error: { message: cfg.errorMessage, type: 'invalid_request_error', param: null, code: 'context_length_exceeded' } })}\n\ndata: [DONE]\n\n`,
      );
      break;
    }
    const group = tokens.slice(i, i + cfg.tokensPerChunk);
    const kind = group[0]?.kind ?? 'content';
    const text = group
      .filter((t) => t.kind === kind)
      .map((t) => t.text)
      .join('');
    const rest = group
      .filter((t) => t.kind !== kind)
      .map((t) => t.text)
      .join('');
    if (kind === 'reasoning') {
      chunk({ choices: [{ index: 0, delta: { content: '', reasoning_content: text } }] });
      if (rest) chunk({ choices: [{ index: 0, delta: { content: rest } }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { content: text } }] });
    }
    if (cfg.toolFrames && i === 0) write(`data: ${JSON.stringify({ type: 'tool_end' })}\n\n`);
    for (const token of group) if (token.kind === 'content') reply += token.text;
    firstTokenAt ??= performance.now();
    lastTokenAt = performance.now();
    sent += group.length;
    const tokenMs = deps.tokenMs * group.length + (Math.random() - 0.5) * 2 * cfg.jitterMs;
    if (i + cfg.tokensPerChunk < tokens.length) await sleep(tokenMs);
  }
  unregister();

  const promptMs = deps.startupMs * 0.9;
  const predictedMs =
    firstTokenAt !== null && lastTokenAt !== null ? lastTokenAt - firstTokenAt + deps.tokenMs : 0;
  const finishedAt = Date.now() / 1000;
  Object.assign(entry, {
    reply_preview: reply.slice(0, 360),
    status: failure ? 'error' : cancelled ? 'cancelled' : 'done',
    updated_at: finishedAt,
    finished_at: finishedAt,
    duration_ms: Math.round(performance.now() - started),
    completion_tokens: sent,
    total_tokens: promptTokens + sent,
    ttft_ms: firstTokenAt === null ? null : Math.round(firstTokenAt - started),
    tok_per_sec: predictedMs > 0 ? Number(((sent * 1000) / predictedMs).toFixed(2)) : null,
    prompt_tok_per_sec: Number(((promptTokens * 1000) / promptMs).toFixed(2)),
    decode_ms: Math.round(predictedMs),
    stop_reason: failure ? 'error' : cancelled ? 'cancelled' : finishReason,
    error: failure,
  });
  if (stopped || failure) {
    if (!response.writableEnded && !response.destroyed) response.end();
    return;
  }

  chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  if (includeUsage) {
    // Like llama-server: prompt_n counts only the prompt tokens that were not in the cache.
    const cached = Math.max(0, Math.min(cfg.cachedPromptTokens, promptTokens - 1));
    const fresh = promptTokens - cached;
    const drafts =
      cfg.draftAcceptRate === null
        ? {}
        : { draft_n: sent, draft_n_accepted: Math.round(sent * cfg.draftAcceptRate) };
    chunk({
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: sent,
        total_tokens: promptTokens + sent,
        prompt_tokens_details: { cached_tokens: cached },
      },
      timings: {
        cache_n: cached,
        prompt_n: fresh,
        prompt_ms: promptMs,
        prompt_per_token_ms: promptMs / fresh,
        prompt_per_second: (fresh * 1000) / promptMs,
        predicted_n: sent,
        predicted_ms: predictedMs,
        predicted_per_token_ms: sent > 0 ? predictedMs / sent : 0,
        predicted_per_second: predictedMs > 0 ? (sent * 1000) / predictedMs : 0,
        ...drafts,
      },
    });
  }
  write('data: [DONE]\n\n');
  response.end();
}
