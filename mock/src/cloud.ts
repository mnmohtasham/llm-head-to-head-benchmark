import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * Fake cloud providers for tests and the demo: OpenAI's Responses API, Anthropic's Messages API and
 * Gemini's streamGenerateContent, with their model lists, stream events and error shapes as the
 * providers documented them on 2026-09-25.
 */
export type CloudMockProvider = 'openai' | 'anthropic' | 'gemini';

export interface CloudMockConfig {
  /** Before the first token. */
  startupMs: number;
  /** Per streamed token. */
  tokenMs: number;
  thinkingTokens: number;
  answerTokens: number;
  /** Answer every request with this HTTP status and the provider's error body. */
  failWith: number | null;
}

export const DEFAULT_CLOUD: CloudMockConfig = {
  startupMs: 250,
  tokenMs: 8,
  thinkingTokens: 20,
  answerTokens: 40,
  failWith: null,
};

export interface RunningCloudMock {
  url: string;
  port: number;
  provider: CloudMockProvider;
  apiKey: string;
  app: FastifyInstance;
  /** Every request body the mock received, newest last. */
  bodies: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const WORDS =
  'the model answers the question with care and a little detail about bandwidth and memory'.split(
    ' ',
  );
const word = (i: number) => `${WORDS[i % WORDS.length] ?? 'word'} `;

/** The models each fake provider lists, including ones Model Duel must leave out. */
function modelList(provider: CloudMockProvider): unknown {
  if (provider === 'openai') {
    return {
      object: 'list',
      data: [
        'gpt-6-luna',
        'gpt-5.4-nano',
        'gpt-4.1-mini',
        'text-embedding-3-small',
        'gpt-image-2',
        'whisper-1',
      ].map((id) => ({
        id,
        object: 'model',
        created: 1_780_000_000,
        owned_by: 'openai',
        shutdown_date: null,
      })),
    };
  }
  if (provider === 'anthropic') {
    const effort = { supported: true, low: {}, medium: {}, high: {}, xhigh: {}, max: {} };
    return {
      data: [
        {
          type: 'model',
          id: 'claude-sonnet-5',
          display_name: 'Claude Sonnet 5',
          created_at: '2026-06-01T00:00:00Z',
          max_input_tokens: 1_000_000,
          max_tokens: 128_000,
          capabilities: {
            effort,
            thinking: {
              supported: true,
              types: { adaptive: { supported: true }, enabled: { supported: false } },
            },
          },
        },
        {
          type: 'model',
          id: 'claude-haiku-4-5',
          display_name: 'Claude Haiku 4.5',
          created_at: '2025-10-01T00:00:00Z',
          max_input_tokens: 200_000,
          max_tokens: 64_000,
          capabilities: {
            effort: { supported: false },
            thinking: {
              supported: true,
              types: { adaptive: { supported: false }, enabled: { supported: true } },
            },
          },
        },
      ],
      has_more: false,
      first_id: 'claude-sonnet-5',
      last_id: 'claude-haiku-4-5',
    };
  }
  return {
    models: [
      {
        name: 'models/gemini-3.5-flash-lite',
        displayName: 'Gemini 3.5 Flash-Lite',
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
        thinking: true,
      },
      {
        name: 'models/gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
        thinking: true,
      },
      {
        name: 'models/gemini-3.5-flash-tts',
        displayName: 'TTS',
        supportedGenerationMethods: ['generateContent'],
      },
      { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
    ],
  };
}

function errorBody(provider: CloudMockProvider, status: number, message: string): unknown {
  if (provider === 'anthropic') {
    const type =
      status === 401
        ? 'authentication_error'
        : status === 429
          ? 'rate_limit_error'
          : status === 529
            ? 'overloaded_error'
            : 'invalid_request_error';
    return { type: 'error', error: { type, message }, request_id: 'req_mock' };
  }
  if (provider === 'gemini') {
    return {
      error: { code: status, message, status: status === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE' },
    };
  }
  return {
    error: {
      message,
      type: 'invalid_request_error',
      param: null,
      code: status === 401 ? 'invalid_api_key' : null,
    },
  };
}

function keyOf(provider: CloudMockProvider, request: FastifyRequest): string | null {
  const h = request.headers;
  if (provider === 'anthropic') return typeof h['x-api-key'] === 'string' ? h['x-api-key'] : null;
  if (provider === 'gemini')
    return typeof h['x-goog-api-key'] === 'string' ? h['x-goog-api-key'] : null;
  const auth = h.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

export async function startCloudMock(options: {
  provider: CloudMockProvider;
  apiKey: string;
  port?: number;
  host?: string;
  config?: Partial<CloudMockConfig>;
}): Promise<RunningCloudMock> {
  const { provider, apiKey } = options;
  let config: CloudMockConfig = { ...DEFAULT_CLOUD, ...options.config };
  const bodies: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: false, forceCloseConnections: true });

  const denied = (request: FastifyRequest, reply: FastifyReply) => {
    if (keyOf(provider, request) === apiKey) return null;
    // Gemini says a bad key is a bad argument.
    const status = provider === 'gemini' ? 400 : 401;
    const message =
      provider === 'gemini'
        ? 'API key not valid. Please pass a valid API key.'
        : provider === 'anthropic'
          ? 'invalid x-api-key'
          : 'Incorrect API key provided: sk-mock...0000.';
    return reply.code(status).send(errorBody(provider, status, message));
  };

  const listPath = provider === 'gemini' ? '/v1beta/models' : '/v1/models';
  app.get(listPath, async (request, reply) => denied(request, reply) ?? modelList(provider));

  /** Streams thinking then answer tokens in the provider's own events. */
  const stream = async (raw: ServerResponse, body: Record<string, unknown>) => {
    let stopped = false;
    // The response's close: the request's fires as soon as its body has been read.
    raw.on('close', () => {
      stopped = true;
    });
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      ...(provider === 'openai'
        ? { 'openai-processing-ms': '12', 'x-request-id': 'req_mock_openai' }
        : {}),
      ...(provider === 'anthropic' ? { 'request-id': 'req_mock_anthropic' } : {}),
    });
    const send = (event: string | null, data: unknown) => {
      if (raw.writableEnded) return;
      raw.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    };
    const maxTokens =
      Number(
        provider === 'openai'
          ? body.max_output_tokens
          : provider === 'anthropic'
            ? body.max_tokens
            : (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens,
      ) || 4096;
    const wantsThinking =
      provider === 'openai'
        ? (body.reasoning as { effort?: unknown } | undefined)?.effort !== 'none' &&
          body.reasoning !== undefined
        : provider === 'anthropic'
          ? ['adaptive', 'enabled'].includes(
              String((body.thinking as { type?: unknown } | undefined)?.type),
            )
          : (
              (body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig as
                { includeThoughts?: unknown } | undefined
            )?.includeThoughts === true;
    const thinking = wantsThinking ? Math.min(config.thinkingTokens, maxTokens) : 0;
    const answer = Math.max(0, Math.min(config.answerTokens, maxTokens - thinking));
    const cut = config.thinkingTokens * (wantsThinking ? 1 : 0) + config.answerTokens > maxTokens;

    if (provider === 'openai')
      send('response.created', { type: 'response.created', response: { status: 'in_progress' } });
    if (provider === 'anthropic') {
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_mock',
          usage: { input_tokens: 20, cache_read_input_tokens: 0, output_tokens: 1 },
        },
      });
    }
    await sleep(config.startupMs);
    if (provider === 'anthropic' && thinking > 0) {
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      });
    }
    for (let i = 0; i < thinking && !stopped; i += 1) {
      const text = `think${i} `;
      if (provider === 'openai')
        send('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          delta: text,
        });
      else if (provider === 'anthropic')
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: text },
        });
      else
        send(null, {
          candidates: [{ content: { parts: [{ text, thought: true }], role: 'model' }, index: 0 }],
        });
      await sleep(config.tokenMs);
    }
    if (provider === 'anthropic') {
      send('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      });
    }
    for (let i = 0; i < answer && !stopped; i += 1) {
      const text = word(i);
      if (provider === 'openai')
        send('response.output_text.delta', { type: 'response.output_text.delta', delta: text });
      else if (provider === 'anthropic')
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text },
        });
      else
        send(null, { candidates: [{ content: { parts: [{ text }], role: 'model' }, index: 0 }] });
      await sleep(config.tokenMs);
    }
    if (stopped) return;
    if (provider === 'openai') {
      const usage = {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: thinking + answer,
        output_tokens_details: { reasoning_tokens: thinking },
      };
      if (cut) {
        send('response.incomplete', {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage,
          },
        });
      } else {
        send('response.completed', {
          type: 'response.completed',
          response: { status: 'completed', usage },
        });
      }
    } else if (provider === 'anthropic') {
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: cut ? 'max_tokens' : 'end_turn' },
        usage: {
          output_tokens: thinking + answer,
          output_tokens_details: { thinking_tokens: thinking },
        },
      });
      send('message_stop', { type: 'message_stop' });
    } else {
      send(null, {
        candidates: [
          {
            content: { parts: [{ text: '' }], role: 'model' },
            finishReason: cut ? 'MAX_TOKENS' : 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: answer,
          thoughtsTokenCount: thinking,
          totalTokenCount: 20 + answer + thinking,
        },
      });
    }
    raw.end();
  };

  const generate = async (request: FastifyRequest, reply: FastifyReply) => {
    const refused = denied(request, reply);
    if (refused) return refused;
    const body = (request.body ?? {}) as Record<string, unknown>;
    bodies.push(body);
    if (config.failWith !== null) {
      return reply
        .code(config.failWith)
        .send(errorBody(provider, config.failWith, 'The mock was told to fail.'));
    }
    // Like the providers, parameters a model does not take are refused.
    if (provider === 'openai' && body.cancel_id !== undefined) {
      return reply.code(400).send(errorBody(provider, 400, "Unknown parameter: 'cancel_id'."));
    }
    if (provider === 'anthropic' && (body.temperature !== undefined || body.top_k !== undefined)) {
      return reply
        .code(400)
        .send(errorBody(provider, 400, 'temperature and top_k are not supported for this model.'));
    }
    reply.hijack();
    await stream(reply.raw, body);
    return reply;
  };

  if (provider === 'openai') app.post('/v1/responses', generate);
  else if (provider === 'anthropic') app.post('/v1/messages', generate);
  else app.post('/v1beta/models/:call', generate);

  app.post('/__mock/config', async (request) => {
    config = { ...config, ...((request.body ?? {}) as Partial<CloudMockConfig>) };
    return config;
  });
  app.post('/__mock/reset', async () => {
    config = { ...DEFAULT_CLOUD, ...options.config };
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
    provider,
    apiKey,
    app,
    bodies: () => [...bodies],
    close: () => app.close(),
  };
}
