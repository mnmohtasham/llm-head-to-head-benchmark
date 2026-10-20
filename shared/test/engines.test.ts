import { describe, expect, it } from 'vitest';
import {
  compatChatBody,
  compatModelStatus,
  NdjsonParser,
  ollamaChatBody,
  ollamaModelStatus,
  OllamaStreamReader,
  parseCompatModels,
  parseCompatProps,
  parseOllamaPs,
  parseOllamaShow,
  quantFromName,
  type SseMessage,
  type TextConfig,
} from '../src';
import { DEFAULT_SAMPLING } from '../src/chat';

const enc = new TextEncoder();
const config: Pick<
  TextConfig,
  'prompt' | 'maxTokens' | 'thinking' | 'reasoningEffort' | 'prefill' | 'sampling'
> = {
  prompt: 'Why is the sky blue?',
  maxTokens: 256,
  thinking: true,
  reasoningEffort: null,
  prefill: 'cold',
  sampling: DEFAULT_SAMPLING,
};

const data = (value: unknown): SseMessage => ({
  kind: 'data',
  data: JSON.stringify(value),
  t: 0,
  read: 0,
});

describe('reading JSON lines', () => {
  it('stamps each line with the read that ended it, across split reads', () => {
    const parser = new NdjsonParser();
    expect(parser.push(enc.encode('{"a":1}\n{"b"'), 10).map((m) => m.t)).toEqual([10]);
    const second = parser.push(enc.encode(':2}\n\n'), 20);
    expect(second).toEqual([{ kind: 'data', data: '{"b":2}', t: 20, read: 1 }]);
  });

  it('keeps a last line without a line end', () => {
    const parser = new NdjsonParser();
    parser.push(enc.encode('{"a":1}\n{"done":true}'), 5);
    expect(parser.end(9)).toEqual([{ kind: 'data', data: '{"done":true}', t: 9, read: 1 }]);
  });
});

describe('Ollama', () => {
  const ps = {
    models: [
      {
        name: 'qwen3:8b',
        size: 6_000,
        size_vram: 3_000,
        context_length: 8192,
        expires_at: '2026-10-21T10:00:00Z',
        details: {
          format: 'gguf',
          family: 'qwen3',
          parameter_size: '8.2B',
          quantization_level: 'Q4_K_M',
        },
      },
      { name: 'llama3.2:3b', details: {} },
    ],
  };

  it('reads what is loaded, and which model is raced', () => {
    const loaded = parseOllamaPs(ps);
    const show = parseOllamaShow({
      capabilities: ['completion', 'thinking'],
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40_960 },
    });
    const status = ollamaModelStatus(loaded, show, '0.12.6');
    expect(status).toMatchObject({
      server: 'ollama',
      activeModel: 'qwen3:8b',
      quant: 'Q4_K_M',
      backend: 'gguf',
      contextLength: 8192,
      nativeContextLength: 40_960,
      supportsReasoning: true,
      reasoningAlwaysOn: false,
      engine: {
        name: 'Ollama',
        version: '0.12.6',
        otherLoaded: ['llama3.2:3b'],
        sizeVramBytes: 3_000,
      },
    });
    // A tag names its quant when the details do not.
    expect(parseOllamaPs({ models: [{ name: 'phi4:14b-q8_0' }] })[0]?.quant).toBe('Q8_0');
  });

  it('asks gpt-oss for a level and leaves the context alone', () => {
    const status = ollamaModelStatus(
      parseOllamaPs({ models: [{ name: 'gpt-oss:20b', details: { family: 'gptoss' } }] }),
      { capabilities: ['completion', 'thinking'], nativeContext: null },
      null,
    );
    expect(status.reasoningEffortLevels).toEqual(['low', 'medium', 'high']);
    const body = ollamaChatBody({ ...config, reasoningEffort: 'high' }, status, 'n0nce');
    expect(body).toMatchObject({
      model: 'gpt-oss:20b',
      think: 'high',
      stream: true,
      keep_alive: '30m',
    });
    expect(body.options).toMatchObject({ num_predict: 256, seed: DEFAULT_SAMPLING.seed });
    expect(body.options).not.toHaveProperty('num_ctx');
    expect(JSON.stringify(body.messages)).toContain('n0nce');
  });

  it('reads thinking, the answer, and Ollama’s timings in nanoseconds', () => {
    const reader = new OllamaStreamReader();
    expect(reader.push(data({ message: { content: '', thinking: 'Hmm' }, done: false }))).toEqual([
      { type: 'reasoning', text: 'Hmm' },
    ]);
    expect(reader.push(data({ message: { content: 'Blue' }, done: false }))).toEqual([
      { type: 'content', text: 'Blue' },
    ]);
    const end = reader.push(
      data({
        message: { content: '' },
        done: true,
        done_reason: 'length',
        load_duration: 12_000_000,
        prompt_eval_count: 20,
        prompt_eval_duration: 100_000_000,
        eval_count: 50,
        eval_duration: 1_000_000_000,
      }),
    );
    expect(end.map((e) => e.type)).toEqual(['finish', 'usage', 'done']);
    const usage = end[1];
    expect(usage?.type === 'usage' ? usage.timings : null).toMatchObject({
      promptPerSecond: 200,
      predictedPerSecond: 50,
      predictedMs: 1000,
    });
    expect(end[0]).toEqual({ type: 'finish', reason: 'length' });
  });

  it('fails a run that made Ollama load the model', () => {
    const reader = new OllamaStreamReader();
    const end = reader.push(
      data({ model: 'qwen3:8b', done: true, load_duration: 4_200_000_000, eval_count: 3 }),
    );
    expect(end[0]).toMatchObject({ type: 'error', code: 'model_load' });
    expect(end[0]?.type === 'error' ? end[0].message : '').toMatch(
      /loaded qwen3:8b for this run \(4\.2 s\)/,
    );
  });

  it('turns an in-band error into an error event', () => {
    expect(new OllamaStreamReader().push(data({ error: 'out of memory' }))).toEqual([
      { type: 'error', message: 'out of memory', code: null },
    ]);
  });
});

describe('OpenAI-compatible servers', () => {
  it('knows llama-server by its props, and vLLM by its owner', () => {
    const llama = compatModelStatus(
      parseCompatModels({
        data: [
          { id: 'model.gguf', owned_by: 'llamacpp', meta: { n_ctx_train: 32_768, n_params: 8e9 } },
        ],
      }),
      parseCompatProps({
        default_generation_settings: { n_ctx: 4096 },
        total_slots: 2,
        build_info: 'b6800-abc',
        model_path: '/m/Qwen3-8B-UD-Q5_K_XL.gguf',
      }),
      null,
    );
    expect(llama).toMatchObject({
      server: 'openai-compatible',
      backend: 'gguf',
      contextLength: 4096,
      parallelSlots: 2,
      quant: 'Q5_K_XL',
      engine: { name: 'llama.cpp', version: 'b6800-abc', params: '8B' },
    });
    const vllm = compatModelStatus(
      parseCompatModels({
        data: [{ id: 'Qwen/Qwen3-8B-FP8', owned_by: 'vllm', max_model_len: 16_384 }],
      }),
      null,
      '0.11.0',
    );
    expect(vllm).toMatchObject({
      backend: 'other',
      contextLength: 16_384,
      quant: 'FP8',
      engine: { name: 'vLLM', version: '0.11.0' },
    });
  });

  it('sends standard fields and turns thinking off through the chat template', () => {
    const body = compatChatBody(
      { ...config, thinking: false, prefill: 'warm' },
      { activeModel: 'm', reasoningEffortLevels: [] },
      'n',
    );
    expect(body).toMatchObject({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 256,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(body).not.toHaveProperty('seed');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(JSON.stringify(body.messages)).not.toContain('"n"');
  });
});

describe('quants in names', () => {
  it.each([
    ['Qwen3-8B-Q4_K_M.gguf', 'Q4_K_M'],
    ['gemma-3-27b-it-IQ3_XS.gguf', 'IQ3_XS'],
    ['llama3.1:8b-instruct-q8_0', 'Q8_0'],
    ['model-bf16.gguf', 'BF16'],
    ['Qwen/Qwen3-8B', null],
  ])('%s → %s', (name, quant) => {
    expect(quantFromName(name)).toBe(quant);
  });
});
