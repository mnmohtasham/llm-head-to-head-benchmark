import { describe, expect, it } from 'vitest';
import {
  anthropicModel,
  cloudErrorMessage,
  cloudHeaders,
  cloudRequest,
  CloudStreamReader,
  effortFor,
  geminiModel,
  openaiModel,
  parseModelList,
  type CloudModel,
  type CloudProvider,
} from '../src/cloud';
import type { ChatEvent, TextConfig } from '../src/chat';

const CONFIG: Pick<
  TextConfig,
  'maxTokens' | 'thinking' | 'reasoningEffort' | 'sampling' | 'prefill'
> = {
  maxTokens: 2048,
  thinking: true,
  reasoningEffort: null,
  sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, repetitionPenalty: 1, seed: 42 },
  prefill: 'cold',
};

const model = (m: CloudModel | null): CloudModel => {
  if (!m) throw new Error('the model was filtered out');
  return m;
};

/** Feeds a provider's events, as their data lines, and collects what the reader makes of them. */
function read(provider: CloudProvider, events: unknown[], end = true): ChatEvent[] {
  const reader = new CloudStreamReader(provider);
  const out = events.flatMap((e) =>
    reader.push({ kind: 'data', data: JSON.stringify(e), t: 0, read: 0 }),
  );
  return end ? [...out, ...reader.end()] : out;
}
const texts = (events: ChatEvent[], type: 'reasoning' | 'content') =>
  events
    .filter((e): e is Extract<ChatEvent, { type: typeof type }> => e.type === type)
    .map((e) => e.text)
    .join('');
const usageOf = (events: ChatEvent[]) =>
  events.find((e): e is Extract<ChatEvent, { type: 'usage' }> => e.type === 'usage')?.usage;
const finishOf = (events: ChatEvent[]) =>
  events.find((e): e is Extract<ChatEvent, { type: 'finish' }> => e.type === 'finish')?.reason;

describe('model lists', () => {
  it('keeps OpenAI’s text models and knows each family’s efforts', () => {
    const ids = parseModelList('openai', {
      data: [
        'gpt-6-astra',
        'gpt-5.4-nano',
        'gpt-5-mini',
        'o4-mini',
        'gpt-4.1',
        'gpt-5-pro',
        'text-embedding-3-large',
        'gpt-image-2',
        'whisper-1',
        'gpt-realtime',
        'gpt-4o-mini-tts',
        'gpt-4o-transcribe',
        'omni-moderation-latest',
        'davinci-002',
        'sora-2',
      ].map((id) => ({ id, object: 'model' })),
    }).map((m) => m.id);
    expect(ids).toEqual([
      'gpt-4.1',
      'gpt-5-mini',
      'gpt-5-pro',
      'gpt-5.4-nano',
      'gpt-6-astra',
      'o4-mini',
    ]);

    expect(model(openaiModel({ id: 'gpt-6-astra' }))).toMatchObject({
      thinking: 'always',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(model(openaiModel({ id: 'gpt-5.4-nano' }))).toMatchObject({
      thinking: 'optional',
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    });
    expect(model(openaiModel({ id: 'gpt-5-mini' })).efforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(model(openaiModel({ id: 'gpt-5-pro' })).efforts).toEqual(['high']);
    expect(model(openaiModel({ id: 'gpt-4.1' }))).toMatchObject({
      thinking: 'none',
      thinkingStyle: null,
      sampling: { temperature: true, topP: true, topK: false, seed: false },
    });
  });

  it('reads Anthropic’s capabilities', () => {
    const fable = model(
      anthropicModel({
        id: 'claude-fable-5-1',
        display_name: 'Claude Fable 5.1',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          effort: { supported: true, low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
          thinking: {
            supported: true,
            types: { adaptive: { supported: true }, enabled: { supported: false } },
          },
        },
      }),
    );
    expect(fable).toMatchObject({
      label: 'Claude Fable 5.1',
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      thinking: 'always',
      thinkingStyle: 'anthropic-adaptive',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      sampling: { temperature: false, topP: false, topK: false, seed: false },
    });
    const haiku = model(
      anthropicModel({
        id: 'claude-haiku-4-5',
        capabilities: {
          effort: { supported: false },
          thinking: { supported: true, types: { enabled: { supported: true } } },
        },
      }),
    );
    expect(haiku).toMatchObject({
      label: 'claude-haiku-4-5',
      thinking: 'optional',
      thinkingStyle: 'anthropic-enabled',
      efforts: [],
    });
  });

  it('keeps Gemini’s text models and knows which cannot stop thinking', () => {
    const ids = parseModelList('gemini', {
      models: [
        {
          name: 'models/gemini-3.8-flash',
          supportedGenerationMethods: ['generateContent'],
          thinking: true,
        },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-embedding-002', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/veo-4', supportedGenerationMethods: ['predictLongRunning'] },
      ],
    }).map((m) => m.id);
    expect(ids).toEqual(['gemini-2.5-flash', 'gemini-3.8-flash']);
    expect(
      model(
        geminiModel({
          name: 'models/gemini-3.8-flash',
          supportedGenerationMethods: ['generateContent'],
        }),
      ),
    ).toMatchObject({
      thinking: 'always',
      thinkingStyle: 'gemini-level',
      efforts: ['low', 'medium', 'high'],
      sampling: { temperature: false, topP: false, topK: false, seed: true },
    });
    expect(
      model(
        geminiModel({
          name: 'models/gemini-2.5-flash',
          supportedGenerationMethods: ['generateContent'],
        }),
      ),
    ).toMatchObject({
      thinking: 'optional',
      thinkingStyle: 'gemini-budget',
    });
  });
});

describe('efforts', () => {
  const gpt = model(openaiModel({ id: 'gpt-5.4-nano' }));
  const astra = model(openaiModel({ id: 'gpt-6-astra' }));
  it('sends the level asked for, the nearest one, or the least with thinking off', () => {
    expect(effortFor(gpt, true, 'high')).toBe('high');
    expect(effortFor(gpt, true, 'max')).toBe('xhigh');
    expect(effortFor(gpt, true, null)).toBeNull();
    expect(effortFor(gpt, false, 'high')).toBe('none');
    expect(effortFor(astra, false, null)).toBe('low');
    expect(effortFor(model(openaiModel({ id: 'gpt-4.1' })), true, 'high')).toBeNull();
  });
});

describe('requests', () => {
  it('asks OpenAI’s Responses API for a summary of the reasoning, with sampling only without it', () => {
    const gpt = model(openaiModel({ id: 'gpt-5.4-nano' }));
    const thinking = cloudRequest('openai', gpt, { ...CONFIG, reasoningEffort: 'low' }, 'Hi');
    expect(thinking).toEqual({
      path: '/v1/responses',
      body: {
        model: 'gpt-5.4-nano',
        input: 'Hi',
        stream: true,
        store: false,
        max_output_tokens: 2048,
        stream_options: { include_obfuscation: false },
        reasoning: { effort: 'low', summary: 'auto' },
      },
    });
    const plain = cloudRequest('openai', gpt, { ...CONFIG, thinking: false }, 'Hi').body;
    expect(plain).toMatchObject({ reasoning: { effort: 'none' }, temperature: 0.6, top_p: 0.95 });
    expect(plain.seed).toBeUndefined();
  });

  it('asks Anthropic for summarised adaptive thinking, and sends no sampling', () => {
    const sonnet = model(
      anthropicModel({
        id: 'claude-sonnet-5',
        capabilities: {
          effort: { supported: true, low: {}, high: {} },
          thinking: { supported: true, types: { adaptive: { supported: true } } },
        },
      }),
    );
    expect(cloudRequest('anthropic', sonnet, { ...CONFIG, reasoningEffort: 'high' }, 'Hi')).toEqual(
      {
        path: '/v1/messages',
        body: {
          model: 'claude-sonnet-5',
          max_tokens: 2048,
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
        },
      },
    );
    expect(
      cloudRequest('anthropic', sonnet, { ...CONFIG, thinking: false }, 'Hi').body.thinking,
    ).toEqual({
      type: 'disabled',
    });
    const haiku = model(
      anthropicModel({
        id: 'claude-haiku-4-5',
        capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } } },
      }),
    );
    expect(cloudRequest('anthropic', haiku, CONFIG, 'Hi').body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 1228,
    });
    // A budget needs at least 1024 tokens under Max tokens, so a small race runs without one.
    expect(
      cloudRequest('anthropic', haiku, { ...CONFIG, maxTokens: 1000 }, 'Hi').body.thinking,
    ).toBeUndefined();
  });

  it('asks Gemini to include its thoughts, with a seed only for cold prompts', () => {
    const flash = model(
      geminiModel({
        name: 'models/gemini-3.8-flash',
        supportedGenerationMethods: ['generateContent'],
      }),
    );
    expect(cloudRequest('gemini', flash, { ...CONFIG, reasoningEffort: 'medium' }, 'Hi')).toEqual({
      path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        generationConfig: {
          maxOutputTokens: 2048,
          seed: 42,
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'MEDIUM' },
        },
      },
    });
    expect(
      cloudRequest('gemini', flash, { ...CONFIG, prefill: 'warm' }, 'Hi').body.generationConfig,
    ).not.toHaveProperty('seed');
    const old = model(
      geminiModel({
        name: 'models/gemini-2.5-flash',
        supportedGenerationMethods: ['generateContent'],
      }),
    );
    expect(
      cloudRequest('gemini', old, { ...CONFIG, thinking: false }, 'Hi').body.generationConfig,
    ).toMatchObject({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('puts each provider’s key in its own header', () => {
    expect(cloudHeaders('openai', 'k')).toEqual({ authorization: 'Bearer k' });
    expect(cloudHeaders('anthropic', 'k')).toEqual({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
    expect(cloudHeaders('gemini', 'k')).toEqual({ 'x-goog-api-key': 'k' });
    expect(cloudHeaders('gemini', null)).toEqual({});
  });

  it('reads all three error shapes', () => {
    expect(cloudErrorMessage({ error: { message: 'Incorrect API key' } })).toBe(
      'Incorrect API key',
    );
    expect(cloudErrorMessage({ type: 'error', error: { type: 'x', message: 'overloaded' } })).toBe(
      'overloaded',
    );
    expect(cloudErrorMessage({ error: { code: 400, message: 'API key not valid' } })).toBe(
      'API key not valid',
    );
    expect(cloudErrorMessage('<html>')).toBe('<html>');
  });
});

describe('stream readers', () => {
  it('reads OpenAI’s events, leaving hidden reasoning out of the tokens that streamed', () => {
    const usage = {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 90,
      output_tokens_details: { reasoning_tokens: 60 },
    };
    const events = read('openai', [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' there' },
      { type: 'response.completed', response: { status: 'completed', usage } },
    ]);
    expect(texts(events, 'content')).toBe('Hello there');
    expect(finishOf(events)).toBe('stop');
    expect(usageOf(events)).toEqual({ promptTokens: 12, completionTokens: 30, cachedTokens: 4 });
    expect(events.at(-1)).toEqual({ type: 'done' });

    // With a summary shown, reasoning counts, as it does for Unsloth's thinking.
    const shown = read('openai', [
      { type: 'response.reasoning_summary_text.delta', delta: 'Thinking.' },
      { type: 'response.output_text.delta', delta: 'Hi' },
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' }, usage },
      },
    ]);
    expect(texts(shown, 'reasoning')).toBe('Thinking.');
    expect(finishOf(shown)).toBe('length');
    expect(usageOf(shown)?.completionTokens).toBe(90);
  });

  it('reads Anthropic’s content blocks and its usage', () => {
    const events = read('anthropic', [
      {
        type: 'message_start',
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Hmm.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'abc' },
      },
      { type: 'ping' },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Blue.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
      { type: 'message_stop' },
    ]);
    expect(texts(events, 'reasoning')).toBe('Hmm.');
    expect(texts(events, 'content')).toBe('Blue.');
    expect(events.filter((e) => e.type === 'keepalive')).toHaveLength(1);
    expect(finishOf(events)).toBe('stop');
    expect(usageOf(events)).toEqual({ promptTokens: 15, completionTokens: 40, cachedTokens: 5 });

    const failed = read('anthropic', [
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]);
    expect(failed).toEqual([{ type: 'error', message: 'Overloaded', code: 'overloaded_error' }]);
  });

  it('reads Gemini’s chunks, adding the thoughts it showed to its output count', () => {
    const events = read('gemini', [
      { candidates: [{ content: { parts: [{ text: 'Let me see.', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Rayleigh' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: ' scattering.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
      },
    ]);
    expect(texts(events, 'reasoning')).toBe('Let me see.');
    expect(texts(events, 'content')).toBe('Rayleigh scattering.');
    expect(finishOf(events)).toBe('stop');
    expect(usageOf(events)).toEqual({ promptTokens: 8, completionTokens: 50, cachedTokens: null });

    // Nothing finishes a Gemini stream but its end, and a stream that stops early has no finish.
    const cut = read('gemini', [{ candidates: [{ content: { parts: [{ text: 'Ray' }] } }] }]);
    expect(finishOf(cut)).toBeUndefined();
    expect(
      read('gemini', [{ error: { code: 503, message: 'Busy', status: 'UNAVAILABLE' } }]),
    ).toEqual([{ type: 'error', message: 'Busy', code: 'UNAVAILABLE' }]);
  });
});
