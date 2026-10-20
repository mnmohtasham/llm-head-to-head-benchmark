import {
  classifyCompatProbe,
  classifyOllamaProbe,
  compatErrorMessage,
  compatModelStatus,
  describeAddress,
  NdjsonParser,
  ollamaErrorMessage,
  ollamaModelStatus,
  OllamaStreamReader,
  OLLAMA_KEEP_ALIVE,
  parseCompatModels,
  parseCompatProps,
  parseOllamaPs,
  parseOllamaShow,
  parseOllamaTags,
  PROBE_ROUTES,
  PROBE_SCHEMA_VERSION,
  type ModelStatus,
  type OllamaLoaded,
  type OllamaModel,
  type OllamaStats,
  type ProbeRaw,
  type RouteResult,
} from '@duel/shared';
import {
  streamChatCompletion,
  streamSse,
  type StreamOptions,
  type StreamOutcome,
} from './chat-stream';
import type { ProbeTimeouts } from './probe';
import type { StoredMachine } from './store';
import { UnslothClient } from './unsloth';

/**
 * Ollama and OpenAI-compatible servers (llama.cpp's llama-server, vLLM, SGLang): probing them,
 * reading their model into the common status shape, and streaming races. Both answer JSON with an
 * optional bearer token, so the same client as for Unsloth serves.
 */
type Address = Pick<StoredMachine, 'baseUrl' | 'apiKey'>;

function clientFor(machine: Address, connectTimeoutMs = 5000) {
  return new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs });
}

const RTT_SAMPLES = 5;

function probeRecord(
  baseUrl: string,
  apiKey: string | null,
  startedAt: Date,
  started: number,
  routes: ProbeRaw['routes'],
  rttMs: number[],
): ProbeRaw {
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

// ---- Ollama ------------------------------------------------------------------------------------

/** A failed Ollama request in words. */
export function ollamaFailure(route: RouteResult, baseUrl: string): string {
  const address = describeAddress(baseUrl);
  if (route.error) {
    return `Ollama at ${address} did not answer (${route.error.message}). Check that it is running with OLLAMA_HOST=0.0.0.0.`;
  }
  if (route.status === 401 || route.status === 403) {
    return `The server in front of Ollama at ${address} refused the request: add the key it expects with Edit on the Machines screen.`;
  }
  const said = ollamaErrorMessage(route.body);
  return `Ollama at ${address} answered HTTP ${route.status}${said ? `: ${said}` : '.'}`;
}

/** Probes Ollama: its version, which needs no key, then what is loaded and downloaded. */
export async function runOllamaProbe(
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
    routes.ollamaVersion = await client.getJson(PROBE_ROUTES.ollamaVersion, {
      timeoutMs: timeouts.requestMs,
    });
    if (routes.ollamaVersion.status !== null && !routes.ollamaVersion.error) {
      const [ps, tags] = await Promise.all([
        client.getJson(PROBE_ROUTES.ollamaPs, { timeoutMs: timeouts.requestMs }),
        client.getJson(PROBE_ROUTES.ollamaTags, { timeoutMs: timeouts.slowRequestMs }),
      ]);
      routes.ollamaPs = ps;
      routes.ollamaTags = tags;
      for (let i = 0; i < RTT_SAMPLES; i += 1) {
        const ping = await client.getJson(PROBE_ROUTES.ollamaVersion, {
          auth: false,
          timeoutMs: timeouts.requestMs,
        });
        if (ping.status === 200 && ping.ms !== null) rttMs.push(ping.ms);
      }
    }
  } finally {
    await client.close();
  }
  return probeRecord(baseUrl, apiKey, startedAt, started, routes, rttMs);
}

export { classifyOllamaProbe };

/** Every downloaded model, with what is loaded. */
export async function readOllamaModels(machine: Address): Promise<{
  downloaded: OllamaModel[] | null;
  loaded: OllamaLoaded[] | null;
  error: string | null;
}> {
  const client = clientFor(machine);
  try {
    const [tags, ps] = await Promise.all([
      client.getJson(PROBE_ROUTES.ollamaTags, { timeoutMs: 20_000 }),
      client.getJson(PROBE_ROUTES.ollamaPs, { timeoutMs: 10_000 }),
    ]);
    if (ps.status !== 200)
      return { downloaded: null, loaded: null, error: ollamaFailure(ps, machine.baseUrl) };
    if (tags.status !== 200) {
      return { downloaded: null, loaded: null, error: ollamaFailure(tags, machine.baseUrl) };
    }
    return { downloaded: parseOllamaTags(tags.body), loaded: parseOllamaPs(ps.body), error: null };
  } finally {
    await client.close();
  }
}

/** Ollama's loaded model in the common status shape, with what `/api/show` says it can do. */
export async function readOllamaStatus(
  machine: Address,
): Promise<{ status: ModelStatus | null; error: string | null }> {
  const client = clientFor(machine);
  try {
    const [ps, version] = await Promise.all([
      client.getJson(PROBE_ROUTES.ollamaPs, { timeoutMs: 10_000 }),
      client.getJson(PROBE_ROUTES.ollamaVersion, { timeoutMs: 10_000 }),
    ]);
    if (ps.status !== 200) return { status: null, error: ollamaFailure(ps, machine.baseUrl) };
    const loaded = parseOllamaPs(ps.body);
    const first = loaded[0];
    const show = first
      ? await client.postJson('/api/show', { model: first.name }, { timeoutMs: 10_000 })
      : null;
    const v = (version.body as { version?: unknown } | null)?.version;
    return {
      status: ollamaModelStatus(
        loaded,
        show?.status === 200 ? parseOllamaShow(show.body) : null,
        typeof v === 'string' ? v : null,
      ),
      error: null,
    };
  } finally {
    await client.close();
  }
}

/** Streams one run from Ollama's native chat, read into the same events as Unsloth's. */
export async function streamOllamaChat(
  machine: Address,
  body: Record<string, unknown>,
  options: StreamOptions,
): Promise<StreamOutcome & { ollama: OllamaStats | null }> {
  const reader = new OllamaStreamReader();
  const outcome = await streamSse(
    {
      url: `${machine.baseUrl}/api/chat`,
      headers: {
        accept: 'application/x-ndjson',
        ...(machine.apiKey ? { authorization: `Bearer ${machine.apiKey}` } : {}),
      },
      parser: () => new NdjsonParser(),
      interpret: (message) => reader.push(message),
    },
    body,
    options,
  );
  return { ...outcome, ollama: reader.stats };
}

/**
 * Loads a model into Ollama and keeps it there for a while: a request without a prompt loads it
 * and answers when it is ready, which for a large model takes minutes.
 */
export async function ollamaLoad(
  machine: Address,
  model: string,
  timeoutMs: number,
): Promise<{ ok: true; seconds: number | null } | { ok: false; error: string }> {
  const client = clientFor(machine);
  try {
    const answer = await client.postJson(
      '/api/generate',
      { model, keep_alive: OLLAMA_KEEP_ALIVE, stream: false },
      { timeoutMs, headersTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs },
    );
    if (answer.status === 200) {
      const load = (answer.body as { load_duration?: unknown } | null)?.load_duration;
      return { ok: true, seconds: typeof load === 'number' ? load / 1e9 : null };
    }
    return { ok: false, error: ollamaFailure(answer, machine.baseUrl) };
  } finally {
    await client.close();
  }
}

/** Unloads a model at once: a request without a prompt and a keep-alive of zero. */
export async function ollamaUnload(
  machine: Address,
  model: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = clientFor(machine);
  try {
    const answer = await client.postJson(
      '/api/generate',
      { model, keep_alive: 0, stream: false },
      { timeoutMs: 60_000 },
    );
    return answer.status === 200
      ? { ok: true }
      : { ok: false, error: ollamaFailure(answer, machine.baseUrl) };
  } finally {
    await client.close();
  }
}

// ---- OpenAI-compatible servers ------------------------------------------------------------------

/** A failed request to an OpenAI-compatible server in words. */
export function compatFailure(route: RouteResult, baseUrl: string): string {
  const address = describeAddress(baseUrl);
  if (route.error) {
    return `The server at ${address} did not answer (${route.error.message}). Check that it is running and listens on the network.`;
  }
  if (route.status === 401 || route.status === 403) {
    return `The server at ${address} refused the request: it needs the API key it was started with. Add it with Edit on the Machines screen.`;
  }
  const said = compatErrorMessage(route.body);
  return `The server at ${address} answered HTTP ${route.status}${said ? `: ${said}` : '.'}`;
}

/** The routes both the probe and a status read take: the models, and the server's extras. */
async function readCompatRoutes(client: UnslothClient, timeoutMs: number) {
  const [models, props, version] = await Promise.all([
    client.getJson(PROBE_ROUTES.compatModels, { timeoutMs }),
    client.getJson(PROBE_ROUTES.compatProps, { timeoutMs }),
    client.getJson(PROBE_ROUTES.compatVersion, { timeoutMs }),
  ]);
  return { models, props, version };
}

/** Probes an OpenAI-compatible server: its model list, llama-server's props and vLLM's version. */
export async function runCompatProbe(
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
    const read = await readCompatRoutes(client, timeouts.requestMs);
    routes.compatModels = read.models;
    routes.compatProps = read.props;
    routes.compatVersion = read.version;
    if (read.models.status === 200) {
      for (let i = 0; i < RTT_SAMPLES; i += 1) {
        const ping = await client.getJson(PROBE_ROUTES.compatModels, {
          timeoutMs: timeouts.requestMs,
        });
        if (ping.status === 200 && ping.ms !== null) rttMs.push(ping.ms);
      }
    }
  } finally {
    await client.close();
  }
  return probeRecord(baseUrl, apiKey, startedAt, started, routes, rttMs);
}

export { classifyCompatProbe };

/** The model an OpenAI-compatible server serves, in the common status shape. */
export async function readCompatStatus(
  machine: Address,
): Promise<{ status: ModelStatus | null; error: string | null }> {
  const client = clientFor(machine);
  try {
    const read = await readCompatRoutes(client, 10_000);
    if (read.models.status !== 200) {
      return { status: null, error: compatFailure(read.models, machine.baseUrl) };
    }
    const version = (read.version.body as { version?: unknown } | null)?.version;
    return {
      status: compatModelStatus(
        parseCompatModels(read.models.body),
        read.props.status === 200 ? parseCompatProps(read.props.body) : null,
        read.version.status === 200 && typeof version === 'string' ? version : null,
      ),
      error: null,
    };
  } finally {
    await client.close();
  }
}

/** Streams one run from an OpenAI-compatible server: the same stream Unsloth sends. */
export function streamCompatChat(
  machine: Address,
  body: Record<string, unknown>,
  options: StreamOptions,
): Promise<StreamOutcome> {
  return streamChatCompletion(machine.baseUrl, machine.apiKey, body, options);
}
