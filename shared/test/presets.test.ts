import { describe, expect, it } from 'vitest';
import { chatRequestBody, DEFAULT_SAMPLING, textConfigSchema, type TextConfig } from '../src/chat';
import { preflightIssues, type PreflightMachine } from '../src/preflight';
import {
  firstWords,
  FIXED_LENGTH_PROMPT,
  LONG_INSTRUCTION,
  newNonce,
  nonceLine,
  presetPrompt,
  withNonce,
} from '../src/presets';
import { roundFlags } from '../src/stats';
import { makeRun, makeStatus } from './make';

const config = (over: Partial<TextConfig> = {}): TextConfig =>
  textConfigSchema.parse({
    preset: 'custom',
    prompt: 'Why is the sky blue?',
    maxTokens: 256,
    thinking: false,
    reasoningEffort: null,
    ...over,
  });

describe('nonces', () => {
  it('are twelve hex characters and never repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newNonce()));
    expect(seen.size).toBe(2000);
    for (const nonce of [...seen].slice(0, 20)) expect(nonce).toMatch(/^[0-9a-f]{12}$/);
  });

  it('start the prompt on their own line, and only when given', () => {
    expect(withNonce('Hi', 'abc123')).toBe(`${nonceLine('abc123')}\n\nHi`);
    expect(withNonce('Hi', null)).toBe('Hi');
  });
});

describe('request bodies', () => {
  it('are identical across machines except the model, and send every sampling field', () => {
    const cold = config();
    const a = chatRequestBody(cold, 'model-a', 'cancel-1', 'n0nce');
    const b = chatRequestBody(cold, 'model-b', 'cancel-1', 'n0nce');
    expect({ ...a, model: '' }).toEqual({ ...b, model: '' });
    expect(a).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      repetition_penalty: 1,
      seed: 42,
      max_tokens: 256,
      enable_thinking: false,
      stream_options: { include_usage: true },
    });
    expect((a.messages as Array<{ content: string }>)[0]?.content).toBe(
      `${nonceLine('n0nce')}\n\nWhy is the sky blue?`,
    );
  });

  it('leave out the nonce and the seed with warm prefill', () => {
    const body = chatRequestBody(config({ prefill: 'warm' }), 'm', 'c', 'n0nce');
    expect(body.seed).toBeUndefined();
    expect((body.messages as Array<{ content: string }>)[0]?.content).toBe('Why is the sky blue?');
  });

  it('default to cold prefill and the standard sampling', () => {
    expect(config()).toMatchObject({ prefill: 'cold', sampling: DEFAULT_SAMPLING });
    expect(textConfigSchema.safeParse({ ...config(), prompt: ' ' }).error?.issues[0]?.message).toBe(
      'Write a prompt.',
    );
    expect(textConfigSchema.safeParse({ ...config(), preset: 'short', prompt: '' }).success).toBe(
      true,
    );
  });
});

describe('presets', () => {
  const source = Array.from({ length: 50 }, (_, i) => `Sentence ${i} has four words.`).join(' ');

  it('cut long texts after a whole sentence and add the instruction', () => {
    expect(firstWords('One two three. Four five six. Seven.', 4)).toBe(
      'One two three. Four five six.',
    );
    const prompt = presetPrompt('long-8k', source, '');
    expect(prompt.endsWith(`\n\n${LONG_INSTRUCTION}`)).toBe(true);
    expect(presetPrompt('fixed-length', source, '')).toBe(FIXED_LENGTH_PROMPT);
    expect(presetPrompt('custom', source, 'Mine')).toBe('Mine');
  });
});

const machine = (over: Partial<PreflightMachine> & { id: string }): PreflightMachine => ({
  name: over.id,
  status: makeStatus(),
  error: null,
  loading: false,
  promptTokens: 1000,
  tokenError: null,
  ...over,
});

describe('pre-flight', () => {
  const codes = (issues: ReturnType<typeof preflightIssues>) =>
    issues.map((issue) => `${issue.level}:${issue.code}`);

  it('passes matching machines whose prompt fits', () => {
    expect(preflightIssues([machine({ id: 'a' }), machine({ id: 'b' })], config())).toEqual([]);
  });

  it('stops a machine that cannot race, or whose prompt does not fit', () => {
    const issues = preflightIssues(
      [
        machine({ id: 'down', error: 'Nothing is listening.' }),
        machine({ id: 'busy', loading: true }),
        machine({ id: 'empty', status: makeStatus({ activeModel: null }) }),
        machine({ id: 'short', status: makeStatus({ contextLength: 16384 }), promptTokens: 30000 }),
        machine({ id: 'tight', status: makeStatus({ contextLength: 8192 }), promptTokens: 8000 }),
        machine({ id: 'swap', status: makeStatus({ memoryWarning: 'Does not fit' }) }),
      ],
      config({ maxTokens: 512 }),
    );
    expect(codes(issues).filter((c) => c.startsWith('error'))).toEqual([
      'error:unreachable',
      'error:loading',
      'error:no-model',
      'error:no-fit',
      'error:no-fit',
      'error:memory',
    ]);
    expect(issues.find((i) => i.machineId === 'tight')?.text).toContain('Lower Max tokens to 192');
  });

  it('stops thinking on a model that cannot think', () => {
    const issues = preflightIssues(
      [machine({ id: 'a', status: makeStatus({ supportsReasoning: false }) })],
      config({ thinking: true }),
    );
    expect(codes(issues)).toEqual(['error:no-thinking']);
  });

  it('warns about every difference between the machines', () => {
    const issues = preflightIssues(
      [
        machine({ id: 'a' }),
        machine({
          id: 'b',
          status: makeStatus({
            quant: 'Q8_0',
            backend: 'mlx',
            contextLength: 16384,
            speculativeType: 'auto',
            specDrafterKind: 'mtp',
            cacheTypeKv: 'q4_0',
            gpuMemoryMode: 'split',
          }),
        }),
      ],
      config(),
    );
    expect(codes(issues)).toEqual([
      'warning:quant',
      'warning:backend',
      'warning:context',
      'warning:speculative',
      'warning:kv-cache',
      'warning:gpu-memory',
    ]);
    expect(issues[0]?.text).toBe('The machines run different quants: a has Q4_K_M, b has Q8_0.');
  });

  it('says so when a machine could not count the prompt', () => {
    const issues = preflightIssues(
      [machine({ id: 'a', promptTokens: null, tokenError: 'it is busy generating' })],
      config(),
    );
    expect(codes(issues)).toEqual(['warning:tokens']);
  });
});

describe('round flags for prefill and length', () => {
  const names = new Map([
    ['a', 'Alpha'],
    ['b', 'Beta'],
  ]);

  it('flag a cache hit above 64 tokens, never the chat template below it', () => {
    const flags = roundFlags(
      [makeRun('a', { cachedTokens: 30 }), makeRun('b', { cachedTokens: 7000 })],
      names,
      null,
    );
    expect(flags.map((f) => [f.kind, f.machineId])).toEqual([['cache', 'b']]);
  });

  it('flag a stop on length, and in fixed-length mode a stop before it', () => {
    const normal = roundFlags([makeRun('a', { finishReason: 'length' })], names, null);
    expect(normal.map((f) => f.kind)).toEqual(['length']);
    const fixed = roundFlags(
      [makeRun('a', { finishReason: 'length' }), makeRun('b', { finishReason: 'stop' })],
      names,
      null,
      { fixedLength: true },
    );
    expect(fixed.map((f) => [f.kind, f.machineId])).toEqual([['length', 'b']]);
  });

  it('flag a prompt Unsloth cut to fit', () => {
    const flags = roundFlags([makeRun('a', { truncated: true })], names, null);
    expect(flags.map((f) => f.kind)).toEqual(['truncated']);
  });
});
