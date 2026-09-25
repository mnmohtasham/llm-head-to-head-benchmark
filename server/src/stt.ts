import { Readable } from 'node:stream';
import { normalizeSttStatus, type SttStatus, type TranscribeConfig } from '@duel/shared';
import { Agent, request } from 'undici';
import type { Audio } from './audio';
import type { StoredMachine } from './store';
import { toNetworkError, UnslothClient } from './unsloth';

const client = (machine: StoredMachine) =>
  new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 3000 });

export async function readSttStatus(
  machine: StoredMachine,
): Promise<{ status: SttStatus | null; error: string | null }> {
  const c = client(machine);
  try {
    const answer = await c.getJson('/api/inference/audio/stt/status', { timeoutMs: 10_000 });
    if (answer.status === 200) return { status: normalizeSttStatus(answer.body), error: null };
    return {
      status: null,
      error:
        answer.status === 404
          ? 'This Unsloth has no speech-to-text.'
          : (answer.error?.message ??
            `The STT status answered HTTP ${answer.status ?? 'nothing'}.`),
    };
  } finally {
    await c.close();
  }
}

/** The engine a load would really use: gguf falls back to transformers without whisper.cpp. */
export function servedEngine(
  status: SttStatus,
  engine: TranscribeConfig['engine'],
): TranscribeConfig['engine'] {
  return engine === 'gguf' && !status.engines.gguf.available ? 'transformers' : engine;
}

/** Loads the model unless it is already in memory with the engine it would get; times the load. */
export async function ensureSttModel(
  machine: StoredMachine,
  config: Pick<TranscribeConfig, 'model' | 'engine' | 'device'>,
): Promise<{ loadMs: number | null; error: string | null }> {
  const before = await readSttStatus(machine);
  if (!before.status) return { loadMs: null, error: before.error };
  const engine = servedEngine(before.status, config.engine);
  if (before.status.loadedModel === config.model && before.status.loadedEngine === engine) {
    return { loadMs: null, error: null };
  }
  const c = client(machine);
  try {
    const started = performance.now();
    const answer = await c.postJson(
      '/api/inference/audio/stt/load',
      { model: config.model, engine: config.engine, device: config.device },
      { timeoutMs: 15 * 60_000 },
    );
    const loadMs = performance.now() - started;
    if (answer.status !== 200) {
      const detail = (answer.body as { detail?: unknown } | null)?.detail;
      return {
        loadMs: null,
        error:
          typeof detail === 'string'
            ? detail
            : `Loading ${config.model} failed with HTTP ${answer.status ?? 'nothing'}.`,
      };
    }
    return { loadMs, error: null };
  } finally {
    await c.close();
  }
}

/** Empties the caller's monitor rows, so the next transcription row is easy to find. */
export async function clearMonitor(machine: StoredMachine): Promise<void> {
  const c = client(machine);
  try {
    await c.deleteJson('/api/inference/monitor', { timeoutMs: 5000 });
  } finally {
    await c.close();
  }
}

/** Unsloth's own processing time for the newest transcription, from its monitor. */
export async function readTranscriptionMonitor(machine: StoredMachine): Promise<number | null> {
  const c = client(machine);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await c.getJson('/api/inference/monitor', { timeoutMs: 5000 });
      const entries = (answer.body as { entries?: Array<Record<string, unknown>> } | null)?.entries;
      const row = (entries ?? []).find((e) =>
        String(e.endpoint ?? '').includes('audio/transcriptions'),
      );
      if (row && row.status !== 'streaming' && typeof row.duration_ms === 'number')
        return row.duration_ms;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  } finally {
    await c.close();
  }
}

export interface TranscribeOutcome {
  requestAt: number;
  /** When the last byte of the body was handed to the network. */
  bodySentAt: number | null;
  /** When the answer's headers arrived: processing is done for a non-streaming answer. */
  headersAt: number | null;
  endAt: number;
  status: number | null;
  body: unknown;
  error: string | null;
  cancelled: boolean;
  /**
   * `raw` is Unsloth's own route, which honours the engine and device; `openai` is the multipart
   * route, used only when the other is missing, which serves Whisper models with Unsloth's default
   * engine whatever was loaded, and is the only one that leaves a monitor row.
   */
  route: 'raw' | 'openai';
}

export interface TranscribeRequest {
  model: string;
  language: string;
  engine: string;
  device: string;
}

/**
 * Streams a body made of a head, the audio and a tail, stamping the moment its last byte is handed
 * to the network. Upload time runs to that moment; processing time from it to the answer.
 */
async function postStreamed(
  url: string,
  headers: Record<string, string>,
  head: Uint8Array[],
  audio: Uint8Array,
  tail: Uint8Array | null,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<Omit<TranscribeOutcome, 'route'>> {
  const length = head.reduce((sum, p) => sum + p.length, 0) + audio.length + (tail?.length ?? 0);
  let bodySentAt: number | null = null;
  const chunkSize = 64 * 1024;
  async function* body() {
    for (const part of head) yield part;
    for (let at = 0; at < audio.length; at += chunkSize) yield audio.subarray(at, at + chunkSize);
    if (tail) yield tail;
    bodySentAt = performance.now();
  }
  const agent = new Agent({ connect: { timeout: 10_000 } });
  const total = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, total]);
  const requestAt = performance.now();
  try {
    const response = await request(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(length) },
      body: Readable.from(body()),
      dispatcher: agent,
      signal,
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
    });
    const headersAt = performance.now();
    const text = await response.body.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Not JSON: keep the text for the error.
    }
    return {
      requestAt,
      bodySentAt: bodySentAt ?? headersAt,
      headersAt,
      endAt: performance.now(),
      status: response.statusCode,
      body: parsed,
      error: null,
      cancelled: false,
    };
  } catch (error) {
    return {
      requestAt,
      bodySentAt,
      headersAt: null,
      endAt: performance.now(),
      status: null,
      body: null,
      error: options.signal.aborted
        ? null
        : total.aborted
          ? 'The transcription took too long and was stopped.'
          : toNetworkError(error).message,
      cancelled: options.signal.aborted,
    };
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}

/**
 * Sends the audio to Unsloth's raw transcription route, which takes the engine and device. Unsloth
 * versions without it get the OpenAI-shaped multipart route instead, which ignores the engine.
 */
export async function transcribe(
  machine: StoredMachine,
  audio: Audio,
  fields: TranscribeRequest,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<TranscribeOutcome> {
  const auth: Record<string, string> = machine.apiKey
    ? { authorization: `Bearer ${machine.apiKey}` }
    : {};
  const query = new URLSearchParams({
    model: fields.model,
    language: fields.language,
    engine: fields.engine,
    device: fields.device,
  });
  const raw = await postStreamed(
    `${machine.baseUrl}/api/inference/audio/transcribe/raw?${query.toString()}`,
    { ...auth, 'content-type': 'application/octet-stream' },
    [],
    audio.bytes,
    null,
    options,
  );
  if (raw.status !== 404 && raw.status !== 405) return { ...raw, route: 'raw' };

  const boundary = `----modelduel${Math.random().toString(16).slice(2)}`;
  const encoder = new TextEncoder();
  const form = { model: fields.model, language: fields.language, response_format: 'verbose_json' };
  const head = Object.entries(form).map(([name, value]) =>
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  head.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${audio.name.replace(/"/g, '')}"\r\nContent-Type: ${audio.contentType}\r\n\r\n`,
    ),
  );
  const openai = await postStreamed(
    `${machine.baseUrl}/v1/audio/transcriptions`,
    { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
    head,
    audio.bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
    options,
  );
  return { ...openai, route: 'openai' };
}
