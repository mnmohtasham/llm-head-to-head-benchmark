import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SAMPLING, type ChatEvent } from '../src/chat';
import {
  classifyLmProbe,
  lmChatBody,
  lmModelStatus,
  lmReasoning,
  LmStreamReader,
  parseLmModels,
} from '../src/lmstudio';
import type { ProbeRaw, RouteResult } from '../src/probe';

const real = JSON.parse(
  readFileSync(new URL('../../fixtures/lmstudio/models-0.4.25.json', import.meta.url), 'utf8'),
) as { body: unknown };

/** The real list, with one model loaded as LM Studio shows it. */
function withLoaded(key: string, config: Record<string, unknown>) {
  const body = structuredClone(real.body) as { models: Array<Record<string, unknown>> };
  for (const model of body.models) {
    if (model.key === key) model.loaded_instances = [{ id: key, config }];
  }
  return body;
}

const route = (
  status: number | null,
  body: unknown,
  error: RouteResult['error'] = null,
): RouteResult => ({
  path: '/',
  status,
  ms: 3,
  contentType: 'application/json',
  body,
  error,
});

function raw(routes: ProbeRaw['routes'], keyConfigured = false): ProbeRaw {
  return {
    schemaVersion: 1,
    baseUrl: 'http://192.168.99.240:1234',
    keyConfigured,
    startedAt: '2026-09-26T10:00:00.000Z',
    finishedAt: '2026-09-26T10:00:01.000Z',
    durationMs: 1000,
    routes,
    rttMs: [2, 3, 4],
  };
}

describe('the model list', () => {
  it('reads every model LM Studio 0.4.25 listed, with its reasoning options', () => {
    const models = parseLmModels(real.body);
    expect(models).toHaveLength(10);
    const qwen = models.find((m) => m.key === 'qwen/qwen3.8-27b');
    expect(qwen).toMatchObject({
      displayName: 'Qwen3.8 27B',
      format: 'gguf',
      quant: 'Q4_K_M',
      params: '27B',
      maxContextLength: 262144,
      reasoningOptions: ['off', 'low', 'medium', 'xhigh', 'on'],
      loaded: [],
    });
    expect(models.find((m) => m.key.startsWith('text-embedding'))?.type).toBe('embedding');
  });

  it('turns the loaded chat model into Unsloth’s status shape', () => {
    expect(lmModelStatus(parseLmModels(real.body)).activeModel).toBeNull();
    const status = lmModelStatus(
      parseLmModels(
        withLoaded('qwen/qwen3.8-27b', {
          context_length: 32768,
          parallel: 4,
          flash_attention: true,
          offload_kv_cache_to_gpu: true,
        }),
      ),
    );
    expect(status).toMatchObject({
      server: 'lmstudio',
      activeModel: 'qwen/qwen3.8-27b',
      backend: 'gguf',
      quant: 'Q4_K_M',
      contextLength: 32768,
      parallelSlots: 4,
      supportsReasoning: true,
      reasoningAlwaysOn: false,
      reasoningEffortLevels: ['low', 'medium', 'xhigh'],
      cacheTypeKv: null,
      gpuLayers: null,
      lmstudio: { instanceId: 'qwen/qwen3.8-27b', flashAttention: true, otherLoaded: [] },
    });
    // A model that cannot think, and a model that always does.
    const plain = lmModelStatus(
      parseLmModels(withLoaded('qwen2.5-7b-instruct-jailbroken', { context_length: 4096 })),
    );
    expect(plain).toMatchObject({ supportsReasoning: false, reasoningAlwaysOn: false });
  });
});

describe('the request', () => {
  it('maps Thinking and effort onto the options the model takes', () => {
    const qwen = ['off', 'low', 'medium', 'xhigh', 'on'];
    expect(lmReasoning(qwen, false, null)).toBe('off');
    expect(lmReasoning(qwen, true, null)).toBe('on');
    expect(lmReasoning(qwen, true, 'low')).toBe('low');
    expect(lmReasoning(qwen, true, 'high')).toBe('on');
    expect(lmReasoning(['on'], false, null)).toBeNull();
    expect(lmReasoning([], true, 'low')).toBeNull();
  });

  it('asks for the loaded copy, unsaved, with LM Studio’s own sampling names', () => {
    const status = lmModelStatus(
      parseLmModels(withLoaded('google/gemma-4-12b', { context_length: 8192 })),
    );
    const body = lmChatBody(
      {
        prompt: 'Why is the sky blue?',
        maxTokens: 256,
        thinking: false,
        reasoningEffort: null,
        prefill: 'cold',
        sampling: DEFAULT_SAMPLING,
      },
      status,
      'nonce-123',
    );
    expect(body).toMatchObject({
      model: 'google/gemma-4-12b',
      stream: true,
      store: false,
      max_output_tokens: 256,
      reasoning: 'off',
      repeat_penalty: DEFAULT_SAMPLING.repetitionPenalty,
    });
    expect(String(body.input)).toContain('nonce-123');
    expect(body).not.toHaveProperty('seed');
    expect(body).not.toHaveProperty('context_length');
  });
});

describe('the stream', () => {
  const message = (data: unknown) => ({
    kind: 'data' as const,
    data: JSON.stringify(data),
    t: 0,
    read: 0,
  });
  const read = (maxTokens: number, events: unknown[]): ChatEvent[] => {
    const reader = new LmStreamReader(maxTokens);
    return events.flatMap((e) => reader.push(message(e)));
  };

  it('reads thinking, answer and LM Studio’s closing stats', () => {
    const events = read(512, [
      { type: 'chat.start', model_instance_id: 'qwen/qwen3.8-27b' },
      { type: 'prompt_processing.start' },
      { type: 'prompt_processing.end' },
      { type: 'reasoning.delta', content: 'Rayleigh.' },
      { type: 'message.delta', content: 'Blue ' },
      { type: 'message.delta', content: 'light.' },
      {
        type: 'chat.end',
        result: {
          stats: {
            input_tokens: 21,
            total_output_tokens: 60,
            reasoning_output_tokens: 20,
            tokens_per_second: 18.7,
            time_to_first_token_seconds: 0.25,
          },
        },
      },
    ]);
    const tokens = events.filter((e) => e.type === 'reasoning' || e.type === 'content');
    expect(tokens).toEqual([
      { type: 'reasoning', text: 'Rayleigh.' },
      { type: 'content', text: 'Blue ' },
      { type: 'content', text: 'light.' },
    ]);
    expect(events.slice(-3)).toEqual([
      { type: 'finish', reason: 'stop' },
      {
        type: 'usage',
        usage: { promptTokens: 21, completionTokens: 60, cachedTokens: null },
        timings: null,
      },
      { type: 'done' },
    ]);
  });

  it('infers a stop at Max tokens, which LM Studio does not report', () => {
    const events = read(60, [{ type: 'chat.end', result: { stats: { total_output_tokens: 60 } } }]);
    expect(events[0]).toEqual({ type: 'finish', reason: 'length' });
  });

  it('refuses to time a model LM Studio has to load first, and reads its errors', () => {
    expect(
      read(64, [{ type: 'model_load.start', model_instance_id: 'google/gemma-4-12b' }])[0],
    ).toMatchObject({
      type: 'error',
      code: 'model_load',
    });
    expect(
      read(64, [
        {
          type: 'error',
          error: {
            type: 'invalid_request',
            message: '"model" is required',
            code: 'missing_required_parameter',
          },
        },
      ]),
    ).toEqual([
      { type: 'error', message: '"model" is required', code: 'missing_required_parameter' },
    ]);
  });
});

describe('the probe', () => {
  it('tells LM Studio from something else, and reads its models', () => {
    const ok = classifyLmProbe(
      raw({
        lmGreeting: route(200, { lmstudio: true }),
        lmModels: route(200, withLoaded('qwen/qwen3.8-27b', { context_length: 8192, parallel: 4 })),
      }),
    );
    expect(ok.overall).toBe('ok');
    expect(ok.capabilities.text.summary).toBe('qwen/qwen3.8-27b Q4_K_M loaded · 9 downloaded');
    expect(ok.rtt.medianMs).toBe(3);

    const other = classifyLmProbe(raw({ lmGreeting: route(404, { error: 'no_route' }) }));
    expect(other.capabilities.reachable).toEqual({ status: 'error', summary: 'Not LM Studio' });

    const off = classifyLmProbe(
      raw({
        lmGreeting: route(null, null, { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }),
      }),
    );
    expect(off.issues[0]?.hint).toMatch(/Serve on Local Network/);
    expect(off.issues[0]?.hint).not.toMatch(/Docker/);
    const local = classifyLmProbe({
      ...raw({
        lmGreeting: route(null, null, { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }),
      }),
      baseUrl: 'http://127.0.0.1:1234',
    });
    expect(local.issues[0]?.hint).toMatch(/localhost is the container itself/);

    const old = classifyLmProbe(
      raw({
        lmGreeting: route(200, { lmstudio: true }),
        lmModels: route(404, { error: 'Unexpected endpoint' }),
      }),
    );
    expect(old.capabilities.text).toEqual({ status: 'error', summary: 'Needs LM Studio 0.4+' });
  });
});
