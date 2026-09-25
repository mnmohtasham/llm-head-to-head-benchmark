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
}

/**
 * Posts the audio as multipart form data, streaming the body so the moment its last byte leaves
 * can be stamped. Upload time runs to that moment; processing time from it to the answer.
 */
export async function transcribe(
  machine: StoredMachine,
  audio: Audio,
  fields: Record<string, string>,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<TranscribeOutcome> {
  const boundary = `----modelduel${Math.random().toString(16).slice(2)}`;
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${audio.name.replace(/"/g, '')}"\r\nContent-Type: ${audio.contentType}\r\n\r\n`,
    ),
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const length = parts.reduce((sum, p) => sum + p.length, 0) + audio.bytes.length + tail.length;
  let bodySentAt: number | null = null;
  const chunkSize = 64 * 1024;
  async function* body() {
    for (const part of parts) yield part;
    for (let at = 0; at < audio.bytes.length; at += chunkSize) {
      yield audio.bytes.subarray(at, at + chunkSize);
    }
    yield tail;
    bodySentAt = performance.now();
  }
  const agent = new Agent({ connect: { timeout: 10_000 } });
  const total = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, total]);
  const headers: Record<string, string> = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(length),
  };
  if (machine.apiKey) headers.authorization = `Bearer ${machine.apiKey}`;
  const requestAt = performance.now();
  try {
    const response = await request(`${machine.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers,
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
