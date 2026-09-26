import {
  classifyLmProbe,
  describeAddress,
  lmErrorMessage,
  lmModelStatus,
  LmStreamReader,
  parseLmModels,
  PROBE_ROUTES,
  PROBE_SCHEMA_VERSION,
  type LmModel,
  type LmStats,
  type ModelStatus,
  type ProbeRaw,
  type RouteResult,
} from '@duel/shared';
import { streamSse, type StreamOptions, type StreamOutcome } from './chat-stream';
import type { ProbeTimeouts } from './probe';
import type { StoredMachine } from './store';
import { UnslothClient } from './unsloth';

/** LM Studio's routes answer like Unsloth's, JSON with a bearer token, so the same client serves. */
function clientFor(machine: Pick<StoredMachine, 'baseUrl' | 'apiKey'>, connectTimeoutMs = 5000) {
  return new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs });
}

/** A failed LM Studio request in words. */
export function lmFailure(route: RouteResult, baseUrl: string): string {
  const address = describeAddress(baseUrl);
  if (route.error) {
    return `LM Studio at ${address} did not answer (${route.error.message}). Check that its server is running with Serve on Local Network on.`;
  }
  if (route.status === 401 || route.status === 403) {
    return `LM Studio at ${address} refused the request: it needs a valid API token. Add one with Edit on the Machines screen.`;
  }
  if (route.status === 404) {
    return `LM Studio at ${address} has no /api/v1/models: Model Duel needs LM Studio 0.4 or newer.`;
  }
  const said = lmErrorMessage(route.body);
  return `LM Studio at ${address} answered HTTP ${route.status}${said ? `: ${said}` : '.'}`;
}

/** Every downloaded model, with what is loaded. */
export async function readLmModels(
  machine: Pick<StoredMachine, 'baseUrl' | 'apiKey'>,
): Promise<{ models: LmModel[] | null; error: string | null }> {
  const client = clientFor(machine);
  try {
    const answer = await client.getJson(PROBE_ROUTES.lmModels, { timeoutMs: 10_000 });
    if (answer.status === 200) return { models: parseLmModels(answer.body), error: null };
    return { models: null, error: lmFailure(answer, machine.baseUrl) };
  } finally {
    await client.close();
  }
}

/** LM Studio's loaded chat model in Unsloth's status shape. */
export async function readLmStatus(
  machine: Pick<StoredMachine, 'baseUrl' | 'apiKey'>,
): Promise<{ status: ModelStatus | null; error: string | null }> {
  const { models, error } = await readLmModels(machine);
  return models ? { status: lmModelStatus(models), error: null } : { status: null, error };
}

const RTT_SAMPLES = 5;

/** Probes an LM Studio server: its greeting, which needs no token, then its model list. */
export async function runLmProbe(
  baseUrl: string,
  apiKey: string | null,
  timeouts: ProbeTimeouts,
): Promise<ProbeRaw> {
  const client = clientFor({ baseUrl, apiKey }, timeouts.connectMs);
  const startedAt = new Date();
  const started = performance.now();
  const routes: ProbeRaw['routes'] = {};
  const rttMs: number[] = [];
  try {
    routes.lmGreeting = await client.getJson(PROBE_ROUTES.lmGreeting, {
      auth: false,
      timeoutMs: timeouts.requestMs,
    });
    if (routes.lmGreeting.status === 200) {
      routes.lmModels = await client.getJson(PROBE_ROUTES.lmModels, {
        timeoutMs: timeouts.requestMs,
      });
      for (let i = 0; i < RTT_SAMPLES; i += 1) {
        const ping = await client.getJson(PROBE_ROUTES.lmGreeting, {
          auth: false,
          timeoutMs: timeouts.requestMs,
        });
        if (ping.status === 200 && ping.ms !== null) rttMs.push(ping.ms);
      }
    }
  } finally {
    await client.close();
  }
  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    baseUrl,
    keyConfigured: Boolean(apiKey),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    routes,
    rttMs,
  };
}

export { classifyLmProbe };

/** Streams one run from LM Studio's native chat, read into the same events as Unsloth's. */
export async function streamLmChat(
  machine: Pick<StoredMachine, 'baseUrl' | 'apiKey'>,
  body: Record<string, unknown>,
  options: StreamOptions,
): Promise<StreamOutcome & { lmstudio: LmStats | null }> {
  const reader = new LmStreamReader(Number(body.max_output_tokens) || Number.MAX_SAFE_INTEGER);
  const outcome = await streamSse(
    {
      url: `${machine.baseUrl}/api/v1/chat`,
      headers: machine.apiKey ? { authorization: `Bearer ${machine.apiKey}` } : {},
      interpret: (message) => reader.push(message),
    },
    body,
    options,
  );
  return { ...outcome, lmstudio: reader.stats };
}

/** What a load asks of LM Studio; left out, LM Studio uses its own defaults. */
export interface LmLoadRequest {
  model: string;
  contextLength?: number;
  flashAttention?: boolean;
  /** Requests served at once. LM Studio added it to loads in 0.4.7 without documenting it. */
  parallel?: number;
}

/**
 * Loads a model in LM Studio and waits until it is ready. LM Studio answers only when the load is
 * done, which for a large model takes minutes.
 */
export async function lmLoad(
  machine: Pick<StoredMachine, 'baseUrl' | 'apiKey'>,
  load: LmLoadRequest,
  timeoutMs: number,
): Promise<{ ok: true; seconds: number | null } | { ok: false; error: string }> {
  const client = clientFor(machine);
  try {
    const answer = await client.postJson(
      '/api/v1/models/load',
      {
        model: load.model,
        ...(load.contextLength ? { context_length: load.contextLength } : {}),
        ...(load.flashAttention !== undefined ? { flash_attention: load.flashAttention } : {}),
        ...(load.parallel ? { parallel: load.parallel } : {}),
        echo_load_config: true,
      },
      { timeoutMs, headersTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs },
    );
    if (answer.status === 200) {
      const seconds = (answer.body as { load_time_seconds?: unknown } | null)?.load_time_seconds;
      return { ok: true, seconds: typeof seconds === 'number' ? seconds : null };
    }
    return { ok: false, error: lmFailure(answer, machine.baseUrl) };
  } finally {
    await client.close();
  }
}

/** Unloads one loaded copy of a model. */
export async function lmUnload(
  machine: Pick<StoredMachine, 'baseUrl' | 'apiKey'>,
  instanceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = clientFor(machine);
  try {
    const answer = await client.postJson(
      '/api/v1/models/unload',
      { instance_id: instanceId },
      { timeoutMs: 60_000 },
    );
    return answer.status === 200
      ? { ok: true }
      : { ok: false, error: lmFailure(answer, machine.baseUrl) };
  } finally {
    await client.close();
  }
}
