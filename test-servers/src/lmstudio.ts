import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * A stand-in LM Studio 0.4 server for the tests: its greeting, model list, load and unload,
 * and the native chat stream with its named events and closing stats, as documented at
 * lmstudio.ai/docs/developer/rest and read from a real LM Studio 0.4.25.
 */
export interface LmMockModel {
  key: string;
  displayName: string;
  format: 'gguf' | 'mlx';
  quant: string;
  params: string;
  maxContext: number;
  /** LM Studio's reasoning options; empty for a model that does not think. */
  reasoning: string[];
  type?: 'llm' | 'embedding';
}

export interface LmMockConfig {
  /** Before the first token. */
  startupMs: number;
  /** Per streamed token. */
  tokenMs: number;
  reasoningTokens: number;
  answerTokens: number;
  /** How long a load takes, by request or on demand. */
  loadMs: number;
  /** Answer every chat with this HTTP status. */
  failWith: number | null;
}

export const DEFAULT_LM_CONFIG: LmMockConfig = {
  startupMs: 180,
  tokenMs: 14,
  reasoningTokens: 12,
  answerTokens: 40,
  loadMs: 300,
  failWith: null,
};

export const DEFAULT_LM_MODELS: LmMockModel[] = [
  {
    key: 'qwen/qwen3.8-27b',
    displayName: 'Qwen3.8 27B',
    format: 'gguf',
    quant: 'Q4_K_M',
    params: '27B',
    maxContext: 262_144,
    reasoning: ['off', 'low', 'medium', 'xhigh', 'on'],
  },
  {
    key: 'google/gemma-4-12b',
    displayName: 'Gemma 4 12B',
    format: 'gguf',
    quant: 'Q4_K_M',
    params: '12B',
    maxContext: 131_072,
    reasoning: ['off', 'on'],
  },
  {
    key: 'qwen2.5-7b-instruct',
    displayName: 'Qwen2.5 7B Instruct',
    format: 'gguf',
    quant: 'Q8_0',
    params: '7B',
    maxContext: 32_768,
    reasoning: [],
  },
  {
    key: 'text-embedding-nomic-embed-text-v1.5',
    displayName: 'Nomic Embed Text v1.5',
    format: 'gguf',
    quant: 'Q4_K_M',
    params: '137M',
    maxContext: 2048,
    reasoning: [],
    type: 'embedding',
  },
];

interface Loaded {
  contextLength: number;
  parallel: number;
  flashAttention: boolean;
}

export interface RunningLmMock {
  url: string;
  port: number;
  app: FastifyInstance;
  /** Every chat body received, newest last. */
  bodies: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const WORDS = 'the local model streams its answer one token at a time over the network'.split(' ');

export async function startLmStudioMock(
  options: {
    port?: number;
    host?: string;
    /** When set, every route but the greeting needs `Authorization: Bearer <token>`. */
    token?: string | null;
    models?: LmMockModel[];
    /** Models loaded at start, by key. */
    loaded?: string[];
    config?: Partial<LmMockConfig>;
  } = {},
): Promise<RunningLmMock> {
  const models = options.models ?? DEFAULT_LM_MODELS;
  const initial = () =>
    new Map<string, Loaded>(
      (options.loaded ?? ['qwen/qwen3.8-27b']).map((key) => [
        key,
        { contextLength: 8192, parallel: 4, flashAttention: true },
      ]),
    );
  let loaded = initial();
  let config: LmMockConfig = { ...DEFAULT_LM_CONFIG, ...options.config };
  const bodies: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: false, forceCloseConnections: true });
  let active = 0;

  const denied = (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.token || request.headers.authorization === `Bearer ${options.token}`) return null;
    return reply.code(401).send({
      error: {
        type: 'invalid_request',
        message: 'Invalid or missing API token.',
        code: 'unauthorized',
      },
    });
  };

  const listing = () => ({
    models: models.map((m) => {
      const instance = loaded.get(m.key);
      return {
        type: m.type ?? 'llm',
        publisher: m.key.split('/')[0],
        key: m.key,
        display_name: m.displayName,
        architecture: 'qwen35',
        quantization: { name: m.quant, bits_per_weight: 4 },
        size_bytes: 5_000_000_000,
        params_string: m.params,
        loaded_instances: instance
          ? [
              {
                id: m.key,
                config: {
                  context_length: instance.contextLength,
                  eval_batch_size: 512,
                  parallel: instance.parallel,
                  flash_attention: instance.flashAttention,
                  offload_kv_cache_to_gpu: true,
                },
              },
            ]
          : [],
        max_context_length: m.maxContext,
        format: m.format,
        capabilities: {
          vision: false,
          trained_for_tool_use: true,
          ...(m.reasoning.length > 0
            ? { reasoning: { allowed_options: m.reasoning, default: 'on' } }
            : {}),
        },
        description: null,
      };
    }),
  });

  app.get('/lmstudio-greeting', async () => ({ lmstudio: true }));
  app.get('/api/v1/models', async (request, reply) => denied(request, reply) ?? listing());
  app.get(
    '/v1/models',
    async (request, reply) =>
      denied(request, reply) ?? {
        object: 'list',
        data: models.map((m) => ({ id: m.key, object: 'model', owned_by: 'organization_owner' })),
      },
  );

  app.post('/api/v1/models/load', async (request, reply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const model = models.find((m) => m.key === body.model);
    if (!model) {
      return reply.code(404).send({ error: { message: `Model not found: ${String(body.model)}` } });
    }
    await sleep(config.loadMs);
    loaded.set(model.key, {
      contextLength: typeof body.context_length === 'number' ? body.context_length : 4096,
      parallel: typeof body.parallel === 'number' ? body.parallel : 4,
      flashAttention: body.flash_attention !== false,
    });
    return {
      type: model.type ?? 'llm',
      instance_id: model.key,
      load_time_seconds: config.loadMs / 1000,
      status: 'loaded',
      load_config: { context_length: loaded.get(model.key)?.contextLength },
    };
  });

  app.post('/api/v1/models/unload', async (request, reply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const id = String(((request.body ?? {}) as Record<string, unknown>).instance_id ?? '');
    if (!loaded.delete(id)) {
      return reply.code(404).send({ error: { message: `No loaded model with id ${id}` } });
    }
    return { instance_id: id };
  });

  const stream = async (raw: ServerResponse, body: Record<string, unknown>) => {
    let stopped = false;
    raw.on('close', () => {
      stopped = true;
    });
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (data: Record<string, unknown>) => {
      if (!raw.writableEnded)
        raw.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const key = String(body.model);
    const model = models.find((m) => m.key === key);
    send({ type: 'chat.start', model_instance_id: key });
    let loadSeconds: number | null = null;
    if (!loaded.has(key)) {
      // Just-in-time loading, as LM Studio does for a model that is not loaded.
      send({ type: 'model_load.start', model_instance_id: key });
      await sleep(config.loadMs / 2);
      send({ type: 'model_load.progress', model_instance_id: key, progress: 0.5 });
      await sleep(config.loadMs / 2);
      loaded.set(key, { contextLength: 4096, parallel: 4, flashAttention: true });
      loadSeconds = config.loadMs / 1000;
      send({ type: 'model_load.end', model_instance_id: key, load_time_seconds: loadSeconds });
    }
    const started = performance.now();
    send({ type: 'prompt_processing.start' });
    await sleep(config.startupMs);
    send({ type: 'prompt_processing.end' });
    const max = Number(body.max_output_tokens) || 4096;
    const thinks = (model?.reasoning.length ?? 0) > 0 && body.reasoning !== 'off';
    const reasoning = thinks ? Math.min(config.reasoningTokens, max) : 0;
    const answer = Math.max(0, Math.min(config.answerTokens, max - reasoning));
    let firstAt: number | null = null;
    if (reasoning > 0) {
      send({ type: 'reasoning.start' });
      for (let i = 0; i < reasoning && !stopped; i += 1) {
        firstAt ??= performance.now();
        send({ type: 'reasoning.delta', content: `step${i} ` });
        await sleep(config.tokenMs);
      }
      send({ type: 'reasoning.end' });
    }
    send({ type: 'message.start' });
    for (let i = 0; i < answer && !stopped; i += 1) {
      firstAt ??= performance.now();
      send({ type: 'message.delta', content: `${WORDS[i % WORDS.length]} ` });
      await sleep(config.tokenMs);
    }
    if (stopped) return;
    send({ type: 'message.end' });
    const end = performance.now();
    const output = reasoning + answer;
    const ttft = ((firstAt ?? end) - started) / 1000;
    send({
      type: 'chat.end',
      result: {
        model_instance_id: key,
        output: [
          ...(reasoning > 0 ? [{ type: 'reasoning', content: '…' }] : []),
          { type: 'message', content: '…' },
        ],
        stats: {
          input_tokens:
            String(body.input ?? '')
              .split(/\s+/)
              .filter(Boolean).length + 8,
          total_output_tokens: output,
          reasoning_output_tokens: reasoning,
          tokens_per_second:
            output > 1 && firstAt !== null ? (output - 1) / ((end - firstAt) / 1000) : 0,
          time_to_first_token_seconds: ttft,
          ...(loadSeconds !== null ? { model_load_time_seconds: loadSeconds } : {}),
        },
      },
    });
    raw.end();
  };

  app.post('/api/v1/chat', async (request, reply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const body = (request.body ?? {}) as Record<string, unknown>;
    bodies.push(body);
    if (config.failWith !== null) {
      return reply.code(config.failWith).send({ error: { message: 'The mock was told to fail.' } });
    }
    const model = models.find((m) => m.key === body.model);
    if (!model) {
      return reply.code(404).send({
        error: { type: 'invalid_request', message: `Model not found: ${String(body.model)}` },
      });
    }
    if (typeof body.reasoning === 'string' && !model.reasoning.includes(body.reasoning)) {
      return reply.code(400).send({
        error: {
          type: 'invalid_request',
          message: `The model does not support reasoning setting '${body.reasoning}'.`,
        },
      });
    }
    // Requests beyond the loaded model's parallel setting wait their turn.
    const parallel = loaded.get(model.key)?.parallel ?? 4;
    while (active >= parallel) await sleep(5);
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
    config = { ...config, ...((request.body ?? {}) as Partial<LmMockConfig>) };
    return config;
  });
  app.post('/__mock/load', async (request) => {
    const body = (request.body ?? {}) as { keys?: string[] };
    loaded = new Map(
      (body.keys ?? []).map((key) => [
        key,
        { contextLength: 8192, parallel: 4, flashAttention: true },
      ]),
    );
    return { loaded: [...loaded.keys()] };
  });
  app.post('/__mock/reset', async () => {
    config = { ...DEFAULT_LM_CONFIG, ...options.config };
    loaded = initial();
    bodies.length = 0;
    return config;
  });

  const host = options.host ?? '127.0.0.1';
  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  return {
    url: `http://${host}:${port}`,
    port,
    app,
    bodies: () => [...bodies],
    close: () => app.close(),
  };
}
