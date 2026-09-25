import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { DEFAULT_STREAM, streamChat, type MonitorEntry, type StreamConfig } from './chat';
import {
  findEntry,
  healthBody,
  hardwareBody,
  imageStatusBody,
  initialLoaded,
  loadResponseBody,
  localModelsBody,
  modelsBody,
  PROFILE_NAMES,
  PROFILES,
  propsBody,
  statusBody,
  systemBody,
  telemetryBody,
  variantsBody,
  type LoadedModel,
  type ProfileName,
  type ProfileState,
} from './profiles';
import {
  DEFAULT_STT,
  expireIdle,
  newSttState,
  parseMultipart,
  processingMs,
  servedEngine,
  STT_DOWNLOADED,
  STT_ENGINES,
  sttBody,
  sttLoadMs,
  transcriptFor,
  type SttEngine,
  type SttMockConfig,
} from './stt';

/** Changes one route's behaviour, for tests. Keyed by path without the query string. */
export interface RouteOverride {
  /** Answer 404 as if this Unsloth version had no such route. */
  missing?: boolean;
  /** Accept the connection and never answer. */
  hang?: boolean;
  delayMs?: number;
  /** Answer with this status and body instead of the normal response, skipping the key check. */
  status?: number;
  body?: unknown;
}

export interface MockConfig {
  profile: ProfileName;
  /** null means keyless access: every request is accepted. */
  apiKey: string | null;
  /** Reject every key, as after the key was deleted in Unsloth. */
  rejectKey: boolean;
  /** null uses the profile's latency. */
  latencyMs: number | null;
  routes: Record<string, RouteOverride>;
  /** How long a load takes; null uses the profile's time. */
  loadMs: number | null;
  /** Like Unsloth, a load running longer than this answers 200 at once and pads the body with spaces. */
  padAfterMs: number;
  padEveryMs: number;
  /** The next load fails halfway with this message. */
  failNextLoad: string | null;
  /** Loads succeed with this memory warning. */
  memoryWarning: string | null;
  /** Loads are refused because another account holds the GPU. */
  gpuBusy: boolean;
  /** How chat completions stream. */
  stream: StreamConfig;
  /** How speech-to-text loads and transcribes. */
  stt: SttMockConfig;
}

export interface MockOptions {
  port?: number;
  host?: string;
  profile?: ProfileName;
  apiKey?: string | null;
  name?: string;
}

export interface MockRequestRecord {
  method: string;
  path: string;
  auth: 'none' | 'valid' | 'invalid' | 'keyless';
  at: string;
}

export interface RunningMock {
  url: string;
  port: number;
  name: string;
  app: FastifyInstance;
  config(): MockConfig;
  requests(): MockRequestRecord[];
  close(): Promise<void>;
}

const NOT_FOUND = { detail: 'API endpoint not found' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AuthResult = MockRequestRecord['auth'];
type Outcome = { kind: 'done' } | { kind: 'cancelled' } | { kind: 'failed'; message: string };

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ', 2);
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) ? v : fallback;

export async function startMockServer(options: MockOptions = {}): Promise<RunningMock> {
  const initial: MockConfig = {
    profile: options.profile ?? 'linux-cuda',
    apiKey: options.apiKey === undefined ? 'sk-unsloth-mock-key-0000000000000000' : options.apiKey,
    rejectKey: false,
    latencyMs: null,
    routes: {},
    loadMs: null,
    padAfterMs: 15_000,
    padEveryMs: 1_000,
    failNextLoad: null,
    memoryWarning: null,
    gpuBusy: false,
    stream: { ...DEFAULT_STREAM },
    stt: { ...DEFAULT_STT },
  };
  let config: MockConfig = structuredClone(initial);
  /** Chat requests served since the last reset, for `stream.speedFactors`. */
  let chatRequests = 0;
  /** Recent prompts, for the prefix cache; a reset or a new model empties it. */
  const cachedPrompts: string[][] = [];
  const state: ProfileState = {
    studioRootId: randomBytes(32).toString('hex'),
    port: 0,
    telemetryReads: 0,
    activeStreams: 0,
    activity: 0,
    loaded: initialLoaded(PROFILES[initial.profile]),
    pending: null,
  };
  let settlePending: ((outcome: Outcome) => void) | null = null;
  const log: MockRequestRecord[] = [];
  const monitor: MonitorEntry[] = [];
  const cancels = new Map<string, () => void>();
  let stt = newSttState();

  const app = Fastify({ logger: false, forceCloseConnections: true, bodyLimit: 1024 * 1024 });
  app.addContentTypeParser(
    /^multipart\/form-data/,
    { parseAs: 'buffer', bodyLimit: 512 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  const profile = () => PROFILES[config.profile];

  const authOf = (request: FastifyRequest): AuthResult => {
    if (config.apiKey === null) return 'keyless';
    const token = bearerOf(request);
    if (token === null) return 'none';
    return !config.rejectKey && token === config.apiKey ? 'valid' : 'invalid';
  };

  const deny = (reply: FastifyReply, path: string, auth: AuthResult) => {
    const message = auth === 'none' ? 'Not authenticated' : 'Invalid or expired API key';
    const body = path.startsWith('/v1/')
      ? { error: { message, type: 'authentication_error', param: null, code: null } }
      : { detail: message };
    return reply.code(401).send(body);
  };

  /** Registers an Unsloth route with overrides, latency and (optionally) the key check. */
  const route = (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    protectedRoute: boolean,
    handler: (request: FastifyRequest, reply: FastifyReply, auth: AuthResult) => unknown,
  ) => {
    app.route({
      method,
      url: path,
      handler: async (request, reply) => {
        const auth = authOf(request);
        log.push({ method, path, auth, at: new Date().toISOString() });
        if (log.length > 500) log.shift();
        await sleep(config.latencyMs ?? profile().latencyMs);
        const override = config.routes[path];
        if (override?.missing) return reply.code(404).send(NOT_FOUND);
        if (override?.hang) return new Promise(() => undefined);
        if (override?.delayMs) await sleep(override.delayMs);
        if (override && (override.status !== undefined || override.body !== undefined)) {
          return reply.code(override.status ?? 200).send(override.body ?? {});
        }
        if (protectedRoute && auth !== 'valid' && auth !== 'keyless')
          return deny(reply, path, auth);
        return handler(request, reply, auth);
      },
    });
  };

  const resetModels = () => {
    settlePending?.({ kind: 'cancelled' });
    state.loaded = initialLoaded(profile());
    state.pending = null;
    state.telemetryReads = 0;
    state.activity = 0;
    stt = newSttState();
  };

  route('GET', '/api/health', false, (_request, _reply, auth) =>
    healthBody(profile(), state, auth === 'valid' || auth === 'keyless'),
  );
  route('GET', '/api/system', true, () => systemBody(profile(), state));
  route('GET', '/api/system/hardware', true, (request) => {
    const query = request.query as Record<string, string | undefined>;
    return hardwareBody(profile(), query.include_details === 'true');
  });
  route('GET', '/api/inference/status', true, () => statusBody(profile(), state));
  route('GET', '/v1/models', true, () => modelsBody(profile(), state));
  route('GET', '/v1/props', true, () => propsBody(profile(), state));
  route('GET', '/api/inference/audio/stt/status', true, () => {
    expireIdle(stt, config.stt);
    return sttBody(profile(), stt);
  });
  route('GET', '/api/inference/images/status', true, () => imageStatusBody());
  route('GET', '/api/train/hardware', true, () => telemetryBody(profile(), state));
  route('GET', '/api/models/local', true, () => localModelsBody(profile()));
  route('GET', '/api/models/gguf-variants', true, (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const answer = variantsBody(profile(), query.repo_id ?? '');
    if (!answer) {
      return reply.code(404).send({ detail: 'No cached GGUF variants available while offline.' });
    }
    return answer;
  });

  route('GET', '/api/inference/load-progress', true, () => {
    const pending = state.pending;
    if (!pending || pending.entry.format !== 'gguf') {
      return { phase: null, bytes_loaded: 0, bytes_total: 0, fraction: 0 };
    }
    const fraction = Math.min(1, (Date.now() - pending.startedAt) / pending.durationMs);
    return {
      phase: fraction < 0.9 ? 'mmap' : 'ready',
      bytes_loaded: Math.round(pending.bytesTotal * fraction),
      bytes_total: pending.bytesTotal,
      fraction: Number(fraction.toFixed(3)),
    };
  });

  route('POST', '/api/inference/load', true, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const modelPath = text(body.model_path) ?? '';
    const entry = findEntry(profile(), modelPath);
    if (!entry) return reply.code(400).send({ detail: `Invalid model identifier: ${modelPath}` });
    if ((entry.task !== null && entry.task !== 'text-generation') || entry.nLayers === 0) {
      return reply.code(400).send({
        detail: `${entry.displayName} is an image generation model, not a chat model.`,
      });
    }
    const wanted = text(body.gguf_variant);
    let quant: string | null = null;
    let sizeGb = entry.sizeGb;
    if (entry.format === 'gguf') {
      const match = entry.quants.find(
        (q) => q.quant.toLowerCase() === wanted?.toLowerCase() && q.downloaded && !q.partial,
      );
      if (!match) {
        return reply.code(400).send({
          detail: `${wanted ?? 'No quant'} of ${entry.displayName} is not on disk, and the mock does not download.`,
        });
      }
      quant = match.quant;
      sizeGb = match.sizeGb;
    }
    if (config.gpuBusy) {
      return reply
        .code(409)
        .send({ detail: { error: 'gpu_busy', message: 'Another account is using the GPU.' } });
    }
    if (state.pending) {
      return reply
        .code(409)
        .send({ detail: 'Another model is loading. The mock does not queue loads.' });
    }

    const gguf = entry.format === 'gguf';
    const requested = int(body.max_seq_length, 0);
    const next: LoadedModel = {
      entry,
      quant,
      requestedContextLength: requested,
      contextLength: requested > 0 ? requested : Math.min(entry.nativeContext, 32768),
      speculativeType: gguf ? (text(body.speculative_type) ?? 'auto') : null,
      cacheTypeKv: gguf ? (text(body.cache_type_kv) ?? 'f16') : null,
      parallelSlots: gguf ? int(body.n_parallel, 1) : null,
      reasoningBudget: int(body.reasoning_budget, -1),
      memoryWarning: config.memoryWarning,
    };
    const current = state.loaded;
    if (
      current &&
      body.force_reload !== true &&
      current.entry === entry &&
      current.quant === quant &&
      current.requestedContextLength === next.requestedContextLength &&
      current.speculativeType === next.speculativeType &&
      current.cacheTypeKv === next.cacheTypeKv &&
      current.parallelSlots === next.parallelSlots &&
      current.reasoningBudget === next.reasoningBudget
    ) {
      return loadResponseBody(current, 'already_loaded');
    }

    // Like Unsloth, the previous model leaves memory before the new one loads.
    state.loaded = null;
    const durationMs = config.loadMs ?? profile().loadMs;
    const failure = config.failNextLoad;
    config.failNextLoad = null;
    const outcome = new Promise<Outcome>((resolve) => {
      const timer = setTimeout(
        () => resolve(failure ? { kind: 'failed', message: failure } : { kind: 'done' }),
        failure ? durationMs / 2 : durationMs,
      );
      settlePending = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
    state.pending = {
      requestId: text(body.load_request_id),
      entry,
      quant,
      startedAt: Date.now(),
      durationMs,
      bytesTotal: Math.round(sizeGb * 1e9),
    };
    const settled = outcome.then((result) => {
      state.pending = null;
      settlePending = null;
      if (result.kind === 'done') {
        state.loaded = next;
        cachedPrompts.length = 0;
      }
      return result;
    });
    const answer = (result: Outcome): { status: number; body: unknown } =>
      result.kind === 'done'
        ? { status: 200, body: loadResponseBody(next, 'loaded') }
        : result.kind === 'cancelled'
          ? { status: 409, body: { detail: 'Model load cancelled' } }
          : { status: 500, body: { detail: result.message } };

    const early = await Promise.race([settled, sleep(config.padAfterMs).then(() => null)]);
    if (early) {
      const { status, body: payload } = answer(early);
      return reply.code(status).send(payload);
    }
    // Past the tunnel timer: commit to 200 and pad, reporting a late failure in the body.
    const stream = new PassThrough();
    const ticker = setInterval(() => stream.write(' '), config.padEveryMs);
    void settled.then((result) => {
      clearInterval(ticker);
      const { status, body: payload } = answer(result);
      const detail = (payload as { detail?: unknown }).detail;
      stream.end(
        JSON.stringify(
          status === 200 ? payload : { _deferred_error: { status_code: status, detail } },
        ),
      );
    });
    return reply
      .code(200)
      .type('application/json')
      .header('cache-control', 'no-cache')
      .send(stream);
  });

  route('POST', '/api/inference/unload', true, (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const modelPath = text(body.model_path) ?? '';
    const cancelId = text(body.cancel_load_request_id);
    const pending = state.pending;
    if (cancelId !== null) {
      if (pending && pending.requestId === cancelId) settlePending?.({ kind: 'cancelled' });
      return { status: 'unloaded', model: modelPath };
    }
    if (pending && pending.entry.loadId.toLowerCase() === modelPath.toLowerCase()) {
      settlePending?.({ kind: 'cancelled' });
      return { status: 'unloaded', model: modelPath };
    }
    state.loaded = null;
    return { status: 'unloaded', model: modelPath };
  });

  const openAiError = (reply: FastifyReply, status: number, message: string) =>
    reply
      .code(status)
      .send({ error: { message, type: 'invalid_request_error', param: null, code: null } });

  route('POST', '/v1/chat/completions', true, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const model = state.loaded;
    if (state.pending)
      return openAiError(reply, 409, 'A model is loading. Try again when it is ready.');
    if (!model) return openAiError(reply, 400, 'No model loaded. Call POST /inference/load first.');
    const factors = config.stream.speedFactors ?? [];
    const factor = factors.length > 0 ? (factors[chatRequests % factors.length] ?? 1) : 1;
    chatRequests += 1;
    const deps = {
      model,
      stream: config.stream,
      startupMs: (config.stream.startupMs ?? profile().startupMs) * factor,
      tokenMs: (config.stream.tokenMs ?? profile().tokenMs) * factor,
      monitor,
      cache: { prompts: cachedPrompts, keepsSeeded: profile().backend === 'mlx' },
      onCancelId: (id: string, cancel: () => void) => {
        cancels.set(id, cancel);
        return () => cancels.delete(id);
      },
    };
    if (body.stream !== true) {
      // Non-streaming answers are only needed for warm-ups; keep them simple.
      const count = deps.stream.answerTokens;
      await sleep(deps.startupMs + count * deps.tokenMs);
      return {
        id: 'chatcmpl-plain',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.entry.modelId,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: count, total_tokens: 5 + count },
      };
    }
    reply.hijack();
    state.activeStreams += 1;
    try {
      await streamChat(request.raw, reply.raw, body, deps);
    } finally {
      state.activeStreams -= 1;
    }
    return reply;
  });

  /** The loaded tokenizer's count, here one token per word plus four for the chat template. */
  route('POST', '/v1/chat/count_tokens', true, (request, reply) => {
    const model = state.loaded;
    if (!model) return openAiError(reply, 400, 'No model loaded. Call POST /inference/load first.');
    const body = (request.body ?? {}) as { messages?: Array<{ content?: unknown }> };
    const words = (body.messages ?? [])
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    return { input_tokens: words + 4, model: model.entry.modelId };
  });

  /** Loads a speech model, as Unsloth's STT sidecar does; the mock never downloads. */
  const loadSpeechModel = async (
    model: string,
    wanted: SttEngine,
    device: string,
  ): Promise<{ status: number; detail: string } | null> => {
    const engine = servedEngine(profile(), wanted);
    if (!engine) return { status: 400, detail: `The ${wanted} engine is not available here.` };
    if (!STT_DOWNLOADED[engine].includes(model)) {
      return {
        status: 400,
        detail: `${model} is not downloaded for ${engine}, and the mock does not download.`,
      };
    }
    if (stt.loading) return { status: 409, detail: 'A speech model is already loading.' };
    if (stt.loaded?.model === model && stt.loaded.engine === engine) return null;
    stt.loaded = null;
    stt.loading = { model, engine, device };
    await sleep(sttLoadMs(profile(), config.stt));
    stt.loaded = stt.loading;
    stt.loading = null;
    stt.lastUsedAt = Date.now();
    return null;
  };

  route('POST', '/api/inference/audio/stt/load', true, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const model = text(body.model) ?? 'small';
    const engine = (STT_ENGINES as readonly string[]).includes(String(body.engine))
      ? (body.engine as SttEngine)
      : 'transformers';
    const device = text(body.device) ?? 'auto';
    const failed = await loadSpeechModel(model, engine, device);
    if (failed) return reply.code(failed.status).send({ detail: failed.detail });
    return { status: 'loaded', model, engine: stt.loaded?.engine ?? engine, device };
  });

  route('POST', '/api/inference/audio/stt/unload', true, () => {
    stt.loaded = null;
    return { status: 'unloaded' };
  });

  route('POST', '/v1/audio/transcriptions', true, async (request, reply) => {
    const body = request.body;
    const parts = Buffer.isBuffer(body)
      ? parseMultipart(body, String(request.headers['content-type'] ?? ''))
      : null;
    const file = parts?.find((part) => part.name === 'file');
    if (!parts || !file)
      return openAiError(reply, 400, 'Send the audio as the multipart field "file".');
    const field = (name: string) => parts.find((part) => part.name === name)?.data.toString('utf8');
    expireIdle(stt, config.stt);
    const model = field('model') ?? stt.loaded?.model ?? 'small';
    if (!stt.loaded || stt.loaded.model !== model) {
      const failed = await loadSpeechModel(model, stt.loaded?.engine ?? 'transformers', 'auto');
      if (failed) return openAiError(reply, failed.status, failed.detail);
    }
    const loaded = stt.loaded;
    if (!loaded) return openAiError(reply, 409, 'The speech model is not loaded.');
    const heard = transcriptFor(profile(), loaded.engine, file.data);
    const ms = processingMs(profile(), loaded.engine, heard.seconds, config.stt);
    const started = Date.now();
    const entry: MonitorEntry = {
      id: randomBytes(8).toString('hex'),
      endpoint: '/v1/audio/transcriptions',
      method: 'POST',
      model: loaded.model,
      via_api_key: true,
      prompt_preview: file.filename ?? 'audio',
      reply_preview: '',
      status: 'streaming',
      started_at: started / 1000,
      updated_at: started / 1000,
      finished_at: null,
      duration_ms: null,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      ttft_ms: null,
      tok_per_sec: null,
      prompt_tok_per_sec: null,
      decode_ms: null,
      stop_reason: null,
    } as MonitorEntry;
    monitor.unshift(entry);
    if (monitor.length > 100) monitor.pop();
    state.activeStreams += 1;
    try {
      await sleep(ms);
    } finally {
      state.activeStreams -= 1;
    }
    const finished = Date.now();
    Object.assign(entry, {
      status: 'done',
      reply_preview: heard.text.slice(0, 120),
      updated_at: finished / 1000,
      finished_at: finished / 1000,
      duration_ms: finished - started,
    });
    stt.lastUsedAt = finished;
    const language = field('language') ?? 'en';
    const format = field('response_format') ?? 'json';
    if (format === 'text') return reply.type('text/plain').send(heard.text);
    if (format === 'verbose_json') {
      return {
        task: 'transcribe',
        language,
        duration: Number(heard.seconds.toFixed(3)),
        text: heard.text,
        segments: [],
      };
    }
    return { text: heard.text };
  });

  /** Unsloth clears the caller's own rows; the mock has only one caller. */
  route('DELETE', '/api/inference/monitor', true, () => {
    const cleared = monitor.length;
    monitor.length = 0;
    return { cleared };
  });

  route('GET', '/api/inference/monitor', true, () => {
    const active = monitor.filter((m) => m.status === 'streaming').length;
    return {
      status: state.pending ? 'loading' : state.loaded ? 'ready' : 'idle',
      server_time: Date.now() / 1000,
      active_model: state.loaded?.entry.modelId ?? null,
      context_length: state.loaded?.contextLength ?? null,
      active_requests: active,
      // Unsloth 2026.9 reports its request slots like this.
      queue: { capacity: 4, active, queued: 0, free: Math.max(0, 4 - active) },
      logging_enabled: true,
      entries: monitor,
    };
  });

  route('POST', '/api/inference/cancel', true, (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const cancel = typeof body.cancel_id === 'string' ? cancels.get(body.cancel_id) : undefined;
    cancel?.();
    return { cancelled: cancel ? 1 : 0 };
  });

  // Control routes for tests and manual poking. Not part of Unsloth.
  app.get('/__mock/config', async () => config);
  app.post('/__mock/config', async (request, reply) => {
    const patch = (request.body ?? {}) as Partial<Omit<MockConfig, 'routes' | 'stream' | 'stt'>> & {
      routes?: Record<string, RouteOverride | null>;
      stream?: Partial<StreamConfig>;
      stt?: Partial<SttMockConfig>;
    };
    if (patch.profile !== undefined && !PROFILE_NAMES.includes(patch.profile)) {
      return reply
        .code(400)
        .send({ detail: `Unknown profile. Use one of: ${PROFILE_NAMES.join(', ')}.` });
    }
    const routes = { ...config.routes };
    for (const [path, override] of Object.entries(patch.routes ?? {})) {
      if (override === null) delete routes[path];
      else routes[path] = override;
    }
    const { routes: _ignored, stream, stt: speech, ...rest } = patch;
    config = {
      ...config,
      ...rest,
      routes,
      stream: { ...config.stream, ...stream },
      stt: { ...config.stt, ...speech },
    } as MockConfig;
    if (patch.profile !== undefined) resetModels();
    return config;
  });
  app.post('/__mock/reset', async () => {
    config = structuredClone(initial);
    chatRequests = 0;
    cachedPrompts.length = 0;
    resetModels();
    log.length = 0;
    monitor.length = 0;
    for (const cancel of cancels.values()) cancel();
    cancels.clear();
    return config;
  });
  app.get('/__mock/requests', async () => log);

  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND));

  const host = options.host ?? '127.0.0.1';
  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  state.port = port;
  const urlHost = host.includes(':') ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${port}`,
    port,
    name: options.name ?? `mock-${config.profile}`,
    app,
    config: () => structuredClone(config),
    requests: () => [...log],
    close: async () => {
      settlePending?.({ kind: 'cancelled' });
      await app.close();
    },
  };
}
