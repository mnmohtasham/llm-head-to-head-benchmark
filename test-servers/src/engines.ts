import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * Stand-ins for the tests: an Ollama server (its version, loaded and downloaded models, load and
 * unload through /api/generate, and the /api/chat stream of JSON lines ending with Ollama's
 * timings in nanoseconds), and an OpenAI-compatible server that answers as llama.cpp's
 * llama-server (with /props and llama.cpp timings) or as vLLM (with /version and token counts
 * only). Shapes from Ollama's docs/api.md and llama.cpp's tools/server/README.md.
 */

export interface EngineMockConfig {
  /** Before the first token. */
  startupMs: number;
  /** Per streamed token. */
  tokenMs: number;
  reasoningTokens: number;
  answerTokens: number;
  /** How long a load takes, by request or on demand (Ollama). */
  loadMs: number;
  /** Answer every chat with this HTTP status. */
  failWith: number | null;
}

export const DEFAULT_ENGINE_CONFIG: EngineMockConfig = {
  startupMs: 120,
  tokenMs: 10,
  reasoningTokens: 10,
  answerTokens: 30,
  loadMs: 300,
  failWith: null,
};

export interface RunningEngineMock {
  url: string;
  port: number;
  app: FastifyInstance;
  /** Every chat body received, newest last. */
  bodies: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const WORDS = 'the local model streams its answer one token at a time over the network'.split(' ');

function denier(token: string | null | undefined) {
  return (request: FastifyRequest, reply: FastifyReply) => {
    if (!token || request.headers.authorization === `Bearer ${token}`) return null;
    return reply.code(401).send({ error: { message: 'Invalid or missing API key.' } });
  };
}

async function listen(app: FastifyInstance, port: number | undefined, host: string | undefined) {
  const h = host ?? '127.0.0.1';
  await app.listen({ port: port ?? 0, host: h });
  const address = app.server.address();
  const p = typeof address === 'object' && address ? address.port : (port ?? 0);
  return { url: `http://${h}:${p}`, port: p };
}

// ---- Ollama ------------------------------------------------------------------------------------

export interface OllamaMockModel {
  name: string;
  family: string;
  params: string;
  quant: string;
  sizeBytes: number;
  /** Capabilities as /api/show lists them; "thinking" makes it think. */
  capabilities: string[];
  contextLength: number;
}

export const DEFAULT_OLLAMA_MODELS: OllamaMockModel[] = [
  {
    name: 'qwen3:8b',
    family: 'qwen3',
    params: '8.2B',
    quant: 'Q4_K_M',
    sizeBytes: 5_200_000_000,
    capabilities: ['completion', 'tools', 'thinking'],
    contextLength: 40_960,
  },
  {
    name: 'gemma3:4b',
    family: 'gemma3',
    params: '4.3B',
    quant: 'Q4_K_M',
    sizeBytes: 3_300_000_000,
    capabilities: ['completion', 'vision'],
    contextLength: 131_072,
  },
];

export async function startOllamaMock(
  options: {
    port?: number;
    host?: string;
    /** When set, every route needs `Authorization: Bearer <token>`, as a proxy in front would. */
    token?: string | null;
    models?: OllamaMockModel[];
    /** Models loaded at start, by name. */
    loaded?: string[];
    config?: Partial<EngineMockConfig>;
  } = {},
): Promise<RunningEngineMock> {
  const models = options.models ?? DEFAULT_OLLAMA_MODELS;
  const initial = () => new Set(options.loaded ?? ['qwen3:8b']);
  let loaded = initial();
  let config: EngineMockConfig = { ...DEFAULT_ENGINE_CONFIG, ...options.config };
  const bodies: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const denied = denier(options.token);
  const find = (name: unknown) => models.find((m) => m.name === name);
  const details = (m: OllamaMockModel) => ({
    parent_model: '',
    format: 'gguf',
    family: m.family,
    families: [m.family],
    parameter_size: m.params,
    quantization_level: m.quant,
  });

  app.get('/', async () => 'Ollama is running');
  app.get(
    '/api/version',
    async (request, reply) => denied(request, reply) ?? { version: '0.12.6' },
  );
  app.get(
    '/api/tags',
    async (request, reply) =>
      denied(request, reply) ?? {
        models: models.map((m) => ({
          name: m.name,
          model: m.name,
          modified_at: '2026-10-01T10:00:00Z',
          size: m.sizeBytes,
          digest: 'sha256:0000',
          details: details(m),
        })),
      },
  );
  app.get(
    '/api/ps',
    async (request, reply) =>
      denied(request, reply) ?? {
        models: models
          .filter((m) => loaded.has(m.name))
          .map((m) => ({
            name: m.name,
            model: m.name,
            size: m.sizeBytes,
            digest: 'sha256:0000',
            details: details(m),
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            size_vram: m.sizeBytes,
            context_length: 4096,
          })),
      },
  );
  app.post('/api/show', async (request, reply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const model = find((request.body as { model?: unknown } | null)?.model);
    if (!model) return reply.code(404).send({ error: 'model not found' });
    return {
      details: details(model),
      model_info: {
        'general.architecture': model.family,
        [`${model.family}.context_length`]: model.contextLength,
      },
      capabilities: model.capabilities,
    };
  });
  app.post('/api/generate', async (request, reply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const model = find(body.model);
    if (!model) return reply.code(404).send({ error: `model "${String(body.model)}" not found` });
    if (body.keep_alive === 0) {
      loaded.delete(model.name);
      return {
        model: model.name,
        created_at: new Date().toISOString(),
        response: '',
        done: true,
        done_reason: 'unload',
      };
    }
    const wasLoaded = loaded.has(model.name);
    if (!wasLoaded) await sleep(config.loadMs);
    loaded.add(model.name);
    return {
      model: model.name,
      created_at: new Date().toISOString(),
      response: '',
      done: true,
      done_reason: 'load',
      load_duration: (wasLoaded ? 5 : config.loadMs) * 1e6,
    };
  });

  const stream = async (
    raw: ServerResponse,
    body: Record<string, unknown>,
    model: OllamaMockModel,
  ) => {
    let stopped = false;
    raw.on('close', () => {
      stopped = true;
    });
    raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const send = (data: Record<string, unknown>) => {
      if (!raw.writableEnded) raw.write(`${JSON.stringify(data)}\n`);
    };
    const started = performance.now();
    let loadMs = 4;
    if (!loaded.has(model.name)) {
      // Ollama loads a model a request names, and the run then includes the load.
      await sleep(config.loadMs);
      loaded.add(model.name);
      loadMs = config.loadMs;
    }
    await sleep(config.startupMs);
    const promptDone = performance.now();
    const options = (body.options ?? {}) as Record<string, unknown>;
    const max = Number(options.num_predict) || 4096;
    const thinks = model.capabilities.includes('thinking') && body.think !== false;
    const reasoning = thinks ? Math.min(config.reasoningTokens, max) : 0;
    const answer = Math.max(0, Math.min(config.answerTokens, max - reasoning));
    const base = { model: model.name, created_at: new Date().toISOString() };
    let firstAt: number | null = null;
    for (let i = 0; i < reasoning && !stopped; i += 1) {
      firstAt ??= performance.now();
      send({
        ...base,
        message: { role: 'assistant', content: '', thinking: `step${i} ` },
        done: false,
      });
      await sleep(config.tokenMs);
    }
    for (let i = 0; i < answer && !stopped; i += 1) {
      firstAt ??= performance.now();
      send({
        ...base,
        message: { role: 'assistant', content: `${WORDS[i % WORDS.length]} ` },
        done: false,
      });
      await sleep(config.tokenMs);
    }
    if (stopped) return;
    const end = performance.now();
    const messages = (body.messages ?? []) as Array<{ content?: string }>;
    const words = String(messages[0]?.content ?? '')
      .split(/\s+/)
      .filter(Boolean).length;
    send({
      ...base,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: reasoning + answer >= max ? 'length' : 'stop',
      total_duration: Math.round((end - started + loadMs) * 1e6),
      load_duration: Math.round(loadMs * 1e6),
      prompt_eval_count: words + 9,
      prompt_eval_duration: Math.round((promptDone - started) * 1e6),
      eval_count: reasoning + answer,
      eval_duration: Math.round((end - (firstAt ?? end)) * 1e6),
    });
    raw.end();
  };

  app.post('/api/chat', async (request, reply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const body = (request.body ?? {}) as Record<string, unknown>;
    bodies.push(body);
    if (config.failWith !== null) {
      return reply.code(config.failWith).send({ error: 'the mock was told to fail' });
    }
    const model = find(body.model);
    if (!model)
      return reply
        .code(404)
        .send({ error: `model "${String(body.model)}" not found, try pulling it first` });
    if (body.think !== undefined && !model.capabilities.includes('thinking')) {
      return reply.code(400).send({ error: `"${model.name}" does not support thinking` });
    }
    reply.hijack();
    await stream(reply.raw, body, model);
    return reply;
  });

  app.post('/__mock/config', async (request) => {
    config = { ...config, ...((request.body ?? {}) as Partial<EngineMockConfig>) };
    return config;
  });
  app.post('/__mock/load', async (request) => {
    loaded = new Set(((request.body ?? {}) as { names?: string[] }).names ?? []);
    return { loaded: [...loaded] };
  });
  app.post('/__mock/reset', async () => {
    config = { ...DEFAULT_ENGINE_CONFIG, ...options.config };
    loaded = initial();
    bodies.length = 0;
    return config;
  });

  const { url, port } = await listen(app, options.port, options.host);
  return { url, port, app, bodies: () => [...bodies], close: () => app.close() };
}

// ---- OpenAI-compatible -------------------------------------------------------------------------

export async function startCompatMock(
  options: {
    port?: number;
    host?: string;
    /** llama-server adds /props and llama.cpp timings; vLLM answers /version and counts only. */
    flavor?: 'llama.cpp' | 'vllm';
    token?: string | null;
    model?: string;
    slots?: number;
    config?: Partial<EngineMockConfig>;
  } = {},
): Promise<RunningEngineMock> {
  const flavor = options.flavor ?? 'llama.cpp';
  const modelId = options.model ?? (flavor === 'vllm' ? 'Qwen/Qwen3-8B' : 'qwen3-8b-q4_k_m.gguf');
  const slots = options.slots ?? 4;
  let config: EngineMockConfig = { ...DEFAULT_ENGINE_CONFIG, ...options.config };
  const bodies: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const denied = denier(options.token);
  let active = 0;

  app.get('/health', async () => ({ status: 'ok' }));
  app.get(
    '/v1/models',
    async (request, reply) =>
      denied(request, reply) ?? {
        object: 'list',
        data: [
          flavor === 'vllm'
            ? { id: modelId, object: 'model', owned_by: 'vllm', max_model_len: 32_768 }
            : {
                id: modelId,
                object: 'model',
                owned_by: 'llamacpp',
                meta: { n_ctx_train: 40_960, n_params: 8_190_000_000, size: 5_000_000_000 },
              },
        ],
      },
  );
  if (flavor === 'llama.cpp') {
    app.get('/props', async () => ({
      default_generation_settings: { n_ctx: 8192 },
      total_slots: slots,
      model_path: `/models/${modelId}`,
      build_info: 'b6800-0123abcd',
    }));
  } else {
    app.get('/version', async () => ({ version: '0.11.0' }));
  }

  const stream = async (raw: ServerResponse, body: Record<string, unknown>) => {
    let stopped = false;
    raw.on('close', () => {
      stopped = true;
    });
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (data: unknown) => {
      if (!raw.writableEnded)
        raw.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id,
      object: 'chat.completion.chunk',
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const started = performance.now();
    await sleep(config.startupMs);
    const promptDone = performance.now();
    const max = Number(body.max_tokens) || 4096;
    const kwargs = (body.chat_template_kwargs ?? {}) as Record<string, unknown>;
    const thinks = kwargs.enable_thinking !== false;
    const reasoning = thinks ? Math.min(config.reasoningTokens, max) : 0;
    const answer = Math.max(0, Math.min(config.answerTokens, max - reasoning));
    send(chunk({ role: 'assistant', content: null }));
    let firstAt: number | null = null;
    for (let i = 0; i < reasoning && !stopped; i += 1) {
      firstAt ??= performance.now();
      send(chunk({ reasoning_content: `step${i} ` }));
      await sleep(config.tokenMs);
    }
    for (let i = 0; i < answer && !stopped; i += 1) {
      firstAt ??= performance.now();
      send(chunk({ content: `${WORDS[i % WORDS.length]} ` }));
      await sleep(config.tokenMs);
    }
    if (stopped) return;
    const end = performance.now();
    const output = reasoning + answer;
    send(chunk({}, output >= max ? 'length' : 'stop'));
    const messages = (body.messages ?? []) as Array<{ content?: string }>;
    const promptTokens =
      String(messages[0]?.content ?? '')
        .split(/\s+/)
        .filter(Boolean).length + 9;
    const decodeMs = end - (firstAt ?? end);
    send({
      id,
      object: 'chat.completion.chunk',
      model: modelId,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: output,
        total_tokens: promptTokens + output,
      },
      ...(flavor === 'llama.cpp'
        ? {
            timings: {
              cache_n: 0,
              prompt_n: promptTokens,
              prompt_ms: promptDone - started,
              prompt_per_second: promptTokens / ((promptDone - started) / 1000),
              predicted_n: output,
              predicted_ms: decodeMs,
              predicted_per_second: decodeMs > 0 ? output / (decodeMs / 1000) : 0,
            },
          }
        : {}),
    });
    send('[DONE]');
    raw.end();
  };

  app.post('/v1/chat/completions', async (request, reply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const body = (request.body ?? {}) as Record<string, unknown>;
    bodies.push(body);
    if (config.failWith !== null) {
      return reply
        .code(config.failWith)
        .send({ error: { message: 'The mock was told to fail.', code: config.failWith } });
    }
    if (body.model !== modelId) {
      return reply
        .code(404)
        .send({ error: { message: `The model ${String(body.model)} does not exist.` } });
    }
    // Requests beyond the slots wait their turn, as llama-server queues them.
    while (active >= slots) await sleep(5);
    active += 1;
    reply.hijack();
    try {
      await stream(reply.raw, body);
    } finally {
      active -= 1;
    }
    return reply;
  });

  app.post('/__mock/config', async (request) => {
    config = { ...config, ...((request.body ?? {}) as Partial<EngineMockConfig>) };
    return config;
  });
  app.post('/__mock/reset', async () => {
    config = { ...DEFAULT_ENGINE_CONFIG, ...options.config };
    bodies.length = 0;
    return config;
  });

  const { url, port } = await listen(app, options.port, options.host);
  return { url, port, app, bodies: () => [...bodies], close: () => app.close() };
}
