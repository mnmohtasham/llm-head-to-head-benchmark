import type { NetworkError, RouteResult } from '@duel/shared';
import { Agent, request } from 'undici';

const MAX_TEXT_BODY = 2000;

export interface RequestOptions {
  auth?: boolean;
  /** Overall limit for the request, body included. */
  timeoutMs: number;
  /** Limit for the status line and headers; defaults to timeoutMs. */
  headersTimeoutMs?: number;
  /** Limit for a silence between body chunks; defaults to timeoutMs. */
  bodyTimeoutMs?: number;
}

/**
 * Talks to one Unsloth Studio instance over one keep-alive connection pool. The API key goes
 * into the Authorization header only; it is never logged or returned.
 */
export class UnslothClient {
  private readonly agent: Agent;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    options: { connectTimeoutMs: number },
  ) {
    this.agent = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 16,
      connect: { timeout: options.connectTimeoutMs },
    });
  }

  getJson(path: string, options: RequestOptions): Promise<RouteResult> {
    return this.send('GET', path, undefined, options);
  }

  postJson(path: string, body: unknown, options: RequestOptions): Promise<RouteResult> {
    return this.send('POST', path, body, options);
  }

  deleteJson(path: string, options: RequestOptions): Promise<RouteResult> {
    return this.send('DELETE', path, undefined, options);
  }

  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<RouteResult> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.auth !== false && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const signal = AbortSignal.timeout(options.timeoutMs);
    const started = performance.now();
    try {
      const response = await request(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        dispatcher: this.agent,
        signal,
        headersTimeout: options.headersTimeoutMs ?? options.timeoutMs,
        bodyTimeout: options.bodyTimeoutMs ?? options.timeoutMs,
      });
      const text = await response.body.text();
      const ms = performance.now() - started;
      const header = response.headers['content-type'];
      const contentType = (Array.isArray(header) ? header[0] : header) ?? null;
      return {
        path,
        status: response.statusCode,
        ms: round2(ms),
        contentType,
        body: parseBody(text),
        error: null,
      };
    } catch (error) {
      return {
        path,
        status: null,
        ms: round2(performance.now() - started),
        contentType: null,
        body: null,
        error: toNetworkError(error, signal),
      };
    }
  }

  async close(): Promise<void> {
    await this.agent.destroy();
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseBody(text: string): unknown {
  // Unsloth pads slow load and unload answers with spaces before the JSON.
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > MAX_TEXT_BODY ? `${text.slice(0, MAX_TEXT_BODY)}…` : text;
  }
}

/** Reduces whatever undici or the socket threw to a stable code and a message. */
export function toNetworkError(error: unknown, signal?: AbortSignal): NetworkError {
  const e = (error ?? {}) as { name?: unknown; message?: unknown };
  if (signal?.aborted || e.name === 'TimeoutError') {
    return { code: 'TIMEOUT', message: 'No answer before the timeout.' };
  }
  // undici wraps socket and parser errors; the code can sit a few causes deep.
  let code: string | null = null;
  let message: string | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const layer = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (!code && typeof layer.code === 'string') code = layer.code;
    if (!message && typeof layer.message === 'string' && layer.message) message = layer.message;
    current = layer.cause;
  }
  message ??= String(error);
  if (!code && /Invalid EOF state|other side closed|socket hang up/i.test(message))
    code = 'ECONNRESET';
  return { code: code ?? 'UNKNOWN', message };
}
