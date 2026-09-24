import {
  interpretMessage,
  SseParser,
  type NetworkError,
  type RunTimeline,
  type SseMessage,
  type TimedEvent,
} from '@duel/shared';
import { Agent, request } from 'undici';
import { toNetworkError } from './unsloth';

export type StreamFailure = 'cancelled' | 'idle-timeout' | 'total-timeout' | 'network' | 'http';

export interface StreamOutcome {
  timeline: RunTimeline;
  /** HTTP status of the answer, or null when none arrived. */
  status: number | null;
  /** The body of a non-200 answer. */
  errorBody: unknown;
  failure: StreamFailure | null;
  networkError: NetworkError | null;
}

export interface StreamOptions {
  signal: AbortSignal;
  /** Longest silence allowed, keep-alive comments included. */
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  onEvent?: (event: TimedEvent) => void;
  /** Every network read with its arrival time, for the recorder. */
  onRead?: (bytes: Uint8Array, t: number) => void;
}

const IDLE_CODES = new Set(['UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/**
 * Posts a streaming chat completion and stamps each network read the moment it arrives, before
 * any parsing. Unsloth answers streams with `Connection: close`, so every run opens its own
 * connection and the handshake is part of the measured wait.
 */
export async function streamChatCompletion(
  baseUrl: string,
  apiKey: string | null,
  body: Record<string, unknown>,
  options: StreamOptions,
): Promise<StreamOutcome> {
  const agent = new Agent({ connect: { timeout: 10_000 }, keepAliveTimeout: 1000 });
  const total = AbortSignal.timeout(options.totalTimeoutMs);
  const signal = AbortSignal.any([options.signal, total]);
  const parser = new SseParser();
  const events: TimedEvent[] = [];
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const take = (messages: SseMessage[]) => {
    for (const message of messages) {
      for (const event of interpretMessage(message)) {
        const timed: TimedEvent = { t: message.t, read: message.read, event };
        events.push(timed);
        options.onEvent?.(timed);
      }
    }
  };

  let status: number | null = null;
  let errorBody: unknown = null;
  let failure: StreamFailure | null = null;
  let networkError: NetworkError | null = null;
  let headersAt: number | null = null;
  const requestAt = performance.now();
  try {
    const response = await request(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher: agent,
      signal,
      headersTimeout: options.idleTimeoutMs,
      bodyTimeout: options.idleTimeoutMs,
    });
    headersAt = performance.now();
    status = response.statusCode;
    if (status !== 200) {
      const text = await response.body.text();
      try {
        errorBody = JSON.parse(text) as unknown;
      } catch {
        errorBody = text.slice(0, 2000);
      }
      failure = 'http';
    } else {
      for await (const chunk of response.body) {
        const t = performance.now();
        const bytes = chunk as Uint8Array;
        options.onRead?.(bytes, t);
        take(parser.push(bytes, t));
      }
      take(parser.end(performance.now()));
    }
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (options.signal.aborted) failure = 'cancelled';
    else if (total.aborted) failure = 'total-timeout';
    else if (IDLE_CODES.has(code)) failure = 'idle-timeout';
    else {
      failure = 'network';
      networkError = toNetworkError(error);
    }
  } finally {
    await agent.destroy().catch(() => undefined);
  }
  return {
    timeline: { requestAt, headersAt, endAt: performance.now(), events },
    status,
    errorBody,
    failure,
    networkError,
  };
}
