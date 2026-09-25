import type { ChatEvent, TextConfig } from './chat';
import type { SseMessage } from './sse';

/**
 * Cloud reference models: OpenAI, Anthropic and Google Gemini, raced on the Text tab next to local
 * machines. Each provider's API differs, so this module turns each one into the same stream
 * events as Unsloth's, and every metric is computed the same way. The contracts follow the
 * providers' documentation as checked on 2026-09-25; see PLAN.md section 2.7.
 */
export const CLOUD_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const CLOUD_INFO: Record<
  CloudProvider,
  { label: string; baseUrl: string; defaultName: string; keyHint: string }
> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    defaultName: 'ChatGPT',
    keyHint: 'Create one at platform.openai.com under API keys.',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultName: 'Claude',
    keyHint: 'Create one in the Claude Console under API keys.',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultName: 'Gemini',
    keyHint: 'Create one in Google AI Studio under Get API key.',
  },
};

/** How a model is asked to think, if it can. */
export type ThinkingStyle =
  'openai-effort' | 'anthropic-adaptive' | 'anthropic-enabled' | 'gemini-level' | 'gemini-budget';

/** A model from a provider's list, with what it accepts. */
export interface CloudModel {
  id: string;
  label: string;
  contextWindow: number | null;
  maxOutput: number | null;
  /** `always` when thinking cannot be turned off, `none` when the model does not think. */
  thinking: 'always' | 'optional' | 'none';
  thinkingStyle: ThinkingStyle | null;
  /** Effort levels it accepts, with Model Duel's names; empty when it has none. */
  efforts: string[];
  /** Sampling fields it accepts; the others are left out of the request. */
  sampling: { temperature: boolean; topP: boolean; topK: boolean; seed: boolean };
}

/** What a cloud participant keeps: the provider and the model picked from its list. */
export interface CloudConfig {
  provider: CloudProvider;
  model: CloudModel | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const NO_SAMPLING = { temperature: false, topP: false, topK: false, seed: false };

const OPENAI_EXCLUDED =
  /(^text-embedding|moderation|^tts-|-tts|^whisper|transcribe|realtime|^gpt-live|^gpt-image|image-latest|^davinci|^babbage|search-preview|audio-preview|^gpt-audio|^dall-e|^computer-use|deep-research|^sora)/i;

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Levels from one to another. Only the first GPT-5 models take `minimal`; later ones refuse it. */
const range = (from: string, to: string) =>
  (
    EFFORTS.slice(EFFORTS.indexOf(from as never), EFFORTS.indexOf(to as never) + 1) as string[]
  ).filter((level) => level !== 'minimal' || from === 'minimal');

/** OpenAI's list says nothing but ids, so what each model accepts comes from its family. */
export function openaiModel(entry: unknown): CloudModel | null {
  const id = str(obj(entry)?.id);
  if (!id || OPENAI_EXCLUDED.test(id)) return null;
  if (!/^(gpt-|o\d|chatgpt-)/i.test(id)) return null;
  const base = { id, label: id, contextWindow: null, maxOutput: null };
  const reasoning = (efforts: string[], thinking: CloudModel['thinking']): CloudModel => ({
    ...base,
    thinking,
    thinkingStyle: 'openai-effort',
    efforts,
    // Reasoning models take temperature and top-p only with effort none; the request decides.
    sampling: {
      temperature: efforts.includes('none'),
      topP: efforts.includes('none'),
      topK: false,
      seed: false,
    },
  });
  if (/-pro(-|$)/.test(id)) return reasoning(['high'], 'always');
  if (/codex/.test(id)) return reasoning(range('low', 'xhigh'), 'always');
  if (/^gpt-6-astra/.test(id)) return reasoning(range('low', 'max'), 'always');
  if (/^(gpt-6|gpt-5\.6)/.test(id)) return reasoning(range('none', 'max'), 'optional');
  if (/^gpt-5\.(2|3|4|5)/.test(id)) return reasoning(range('none', 'xhigh'), 'optional');
  if (/^gpt-5\.1/.test(id)) return reasoning(range('none', 'high'), 'optional');
  if (/^gpt-5/.test(id)) return reasoning(range('minimal', 'high'), 'always');
  if (/^o\d/.test(id)) return reasoning(['low', 'medium', 'high'], 'always');
  return {
    ...base,
    thinking: 'none',
    thinkingStyle: null,
    efforts: [],
    sampling: { temperature: true, topP: true, topK: false, seed: false },
  };
}

/** Anthropic's list says which thinking types and effort levels each model takes. */
export function anthropicModel(entry: unknown): CloudModel | null {
  const e = obj(entry);
  const id = str(e?.id);
  if (!e || !id) return null;
  const caps = obj(e.capabilities);
  const thinking = obj(caps?.thinking);
  const types = obj(thinking?.types);
  const supported = (o: unknown) => obj(o)?.supported === true;
  const adaptive = supported(types?.adaptive);
  const enabled = supported(types?.enabled);
  const effort = obj(caps?.effort);
  const efforts = supported(effort)
    ? ['low', 'medium', 'high', 'xhigh', 'max'].filter((level) => effort?.[level] !== undefined)
    : [];
  // These think on every request; a request that turns thinking off is refused.
  const always = /claude-(fable|mythos)|claude-opus-5-5/.test(id);
  return {
    id,
    label: str(e.display_name) ?? id,
    contextWindow: num(e.max_input_tokens),
    maxOutput: num(e.max_tokens),
    thinking:
      !supported(thinking) && !adaptive && !enabled ? 'none' : always ? 'always' : 'optional',
    thinkingStyle: adaptive ? 'anthropic-adaptive' : enabled ? 'anthropic-enabled' : null,
    efforts,
    // Models after Opus 4.6 refuse every sampling setting but the defaults, so none is sent.
    sampling: NO_SAMPLING,
  };
}

const GEMINI_EXCLUDED =
  /(-tts|-live|native-audio|-image|transcribe|^veo-|^lyria-|^imagen-|^gemini-omni-|embedding|robotics|computer-use|^deep-research-|^antigravity-|^aqa)/i;

/** Gemini's list names the generation methods and whether a model thinks. */
export function geminiModel(entry: unknown): CloudModel | null {
  const e = obj(entry);
  const id = str(e?.name)?.replace(/^models\//, '');
  if (!e || !id || GEMINI_EXCLUDED.test(id)) return null;
  if (!list(e.supportedGenerationMethods).includes('generateContent')) return null;
  const three = /^gemini-3/.test(id);
  const thinks = e.thinking === true || /^gemini-(2\.5|3)/.test(id);
  const noMinimal = /^gemini-3\.(7|8)-flash|^gemini-3\.1-pro/.test(id);
  return {
    id,
    label: str(e.displayName) ?? id,
    contextWindow: num(e.inputTokenLimit),
    maxOutput: num(e.outputTokenLimit),
    thinking: !thinks ? 'none' : three || /2\.5-pro/.test(id) ? 'always' : 'optional',
    thinkingStyle: !thinks ? null : three ? 'gemini-level' : 'gemini-budget',
    efforts: !thinks
      ? []
      : three && !noMinimal
        ? ['minimal', 'low', 'medium', 'high']
        : ['low', 'medium', 'high'],
    // Gemini 3 is meant to run at its default sampling; older models take all of it.
    sampling: three
      ? { temperature: false, topP: false, topK: false, seed: true }
      : { temperature: true, topP: true, topK: true, seed: true },
  };
}

/** The text models in a provider's list answer, sorted by id. */
export function parseModelList(provider: CloudProvider, body: unknown): CloudModel[] {
  const b = obj(body);
  const entries = provider === 'gemini' ? list(b?.models) : list(b?.data);
  const read =
    provider === 'openai' ? openaiModel : provider === 'anthropic' ? anthropicModel : geminiModel;
  return entries
    .map(read)
    .filter((m): m is CloudModel => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The effort to send: the one asked for if the model takes it, else a sensible one it does. */
export function effortFor(
  model: CloudModel,
  thinking: boolean,
  asked: string | null,
): string | null {
  const levels = model.efforts;
  if (levels.length === 0) return null;
  if (!thinking) {
    for (const low of ['none', 'minimal', 'low']) if (levels.includes(low)) return low;
    return levels[0] ?? null;
  }
  if (asked && levels.includes(asked)) return asked;
  if (asked === null) return null;
  // The nearest level the model takes.
  const order = EFFORTS as readonly string[];
  const want = order.indexOf(asked);
  return (
    [...levels].sort(
      (a, b) => Math.abs(order.indexOf(a) - want) - Math.abs(order.indexOf(b) - want),
    )[0] ?? null
  );
}

const GEMINI_BUDGETS: Record<string, number> = { low: 1024, medium: 8192, high: 24_576 };

/**
 * The request for one run: path and body, following each provider's current API. The prompt is
 * the one sent to every machine, nonce line included. Nothing a provider would refuse is sent.
 */
export function cloudRequest(
  provider: CloudProvider,
  model: CloudModel,
  config: Pick<TextConfig, 'maxTokens' | 'thinking' | 'reasoningEffort' | 'sampling' | 'prefill'>,
  prompt: string,
): { path: string; body: Record<string, unknown> } {
  const thinking =
    model.thinking === 'always' || (model.thinking === 'optional' && config.thinking);
  // With Thinking off, a model that always thinks is asked for as little as it allows.
  const effort = effortFor(model, config.thinking, config.reasoningEffort);
  const s = config.sampling;
  if (provider === 'openai') {
    const plain = model.thinking === 'none' || effort === 'none';
    return {
      path: '/v1/responses',
      body: {
        model: model.id,
        input: prompt,
        stream: true,
        store: false,
        max_output_tokens: config.maxTokens,
        stream_options: { include_obfuscation: false },
        ...(model.thinkingStyle === 'openai-effort'
          ? {
              reasoning: {
                ...(effort ? { effort } : {}),
                ...(effort === 'none' ? {} : { summary: 'auto' }),
              },
            }
          : {}),
        ...(plain && model.sampling.temperature ? { temperature: s.temperature } : {}),
        ...(plain && model.sampling.topP ? { top_p: s.topP } : {}),
      },
    };
  }
  if (provider === 'anthropic') {
    let thinkingBlock: Record<string, unknown> | null = null;
    if (model.thinkingStyle === 'anthropic-adaptive') {
      thinkingBlock = thinking ? { type: 'adaptive', display: 'summarized' } : { type: 'disabled' };
    } else if (model.thinkingStyle === 'anthropic-enabled' && thinking && config.maxTokens > 1024) {
      const budget = Math.max(
        1024,
        Math.min(config.maxTokens - 1, Math.floor(config.maxTokens * 0.6)),
      );
      thinkingBlock = { type: 'enabled', budget_tokens: budget };
    }
    return {
      path: '/v1/messages',
      body: {
        model: model.id,
        max_tokens: config.maxTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        ...(thinkingBlock ? { thinking: thinkingBlock } : {}),
        ...(effort && thinking ? { output_config: { effort } } : {}),
      },
    };
  }
  let thinkingConfig: Record<string, unknown> | null = null;
  if (model.thinkingStyle === 'gemini-level') {
    thinkingConfig = {
      includeThoughts: true,
      ...(effort ? { thinkingLevel: effort.toUpperCase() } : {}),
    };
  } else if (model.thinkingStyle === 'gemini-budget') {
    thinkingConfig = thinking
      ? {
          includeThoughts: true,
          thinkingBudget:
            model.thinking === 'always' && !config.thinking
              ? 128
              : effort
                ? (GEMINI_BUDGETS[effort] ?? -1)
                : -1,
        }
      : { thinkingBudget: 0 };
  }
  return {
    path: `/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: config.maxTokens,
        ...(model.sampling.temperature ? { temperature: s.temperature } : {}),
        ...(model.sampling.topP ? { topP: s.topP } : {}),
        ...(model.sampling.topK ? { topK: s.topK } : {}),
        ...(model.sampling.seed && config.prefill === 'cold' ? { seed: s.seed } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    },
  };
}

/** Headers for a provider: its key header, and Anthropic's version. */
export function cloudHeaders(
  provider: CloudProvider,
  apiKey: string | null,
): Record<string, string> {
  if (!apiKey) return {};
  if (provider === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (provider === 'gemini') return { 'x-goog-api-key': apiKey };
  return { authorization: `Bearer ${apiKey}` };
}

/** The path of a provider's model list. */
export function modelListPath(provider: CloudProvider): string {
  return provider === 'openai'
    ? '/v1/models'
    : provider === 'anthropic'
      ? '/v1/models?limit=1000'
      : '/v1beta/models?pageSize=1000';
}

/** A provider's error message, from any of the three error shapes. */
export function cloudErrorMessage(body: unknown): string | null {
  const b = obj(body);
  const error = obj(b?.error);
  return (
    str(error?.message) ?? str(b?.message) ?? (typeof body === 'string' ? body.slice(0, 300) : null)
  );
}

/**
 * Reads one provider's stream into Model Duel's chat events. Output tokens are counted the way
 * the decode speed needs them: over the tokens that streamed, so reasoning the provider kept
 * hidden is left out, while reasoning it showed is counted.
 */
export class CloudStreamReader {
  private reasoningSeen = false;
  private usage: {
    prompt: number | null;
    cached: number | null;
    output: number | null;
    reasoning: number | null;
  } = {
    prompt: null,
    cached: null,
    output: null,
    reasoning: null,
  };
  private finished = false;
  /** The provider's own usage, as it reported it, for the report. */
  raw: Json | null = null;

  constructor(private readonly provider: CloudProvider) {}

  private done(reason: string): ChatEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const hidden = this.reasoningSeen ? 0 : (this.usage.reasoning ?? 0);
    const completion =
      this.provider === 'gemini'
        ? (this.usage.output ?? 0) + (this.reasoningSeen ? (this.usage.reasoning ?? 0) : 0)
        : this.usage.output === null
          ? null
          : this.usage.output - hidden;
    return [
      { type: 'finish', reason },
      {
        type: 'usage',
        usage: {
          promptTokens: this.usage.prompt,
          completionTokens: completion,
          cachedTokens: this.usage.cached,
        },
        timings: null,
      },
      { type: 'done' },
    ];
  }

  push(message: SseMessage): ChatEvent[] {
    if (message.kind === 'comment') return [{ type: 'keepalive' }];
    const raw = message.data.trim();
    if (raw === '[DONE]') return [];
    let data: Json | null;
    try {
      data = obj(JSON.parse(raw));
    } catch {
      return [{ type: 'ignored', why: 'not JSON' }];
    }
    if (!data) return [{ type: 'ignored', why: 'not an object' }];
    if (this.provider === 'openai') return this.openai(data);
    if (this.provider === 'anthropic') return this.anthropic(data);
    return this.gemini(data);
  }

  private reasoning(text: string): ChatEvent[] {
    if (!text) return [];
    this.reasoningSeen = true;
    return [{ type: 'reasoning', text }];
  }

  private openai(d: Json): ChatEvent[] {
    const type = str(d.type) ?? '';
    if (type === 'response.output_text.delta') {
      const text = str(d.delta);
      return text ? [{ type: 'content', text }] : [];
    }
    if (type === 'response.reasoning_summary_text.delta') return this.reasoning(str(d.delta) ?? '');
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = obj(d.response);
      const usage = obj(response?.usage);
      this.raw = usage;
      this.usage = {
        prompt: num(usage?.input_tokens),
        cached: num(obj(usage?.input_tokens_details)?.cached_tokens),
        output: num(usage?.output_tokens),
        reasoning: num(obj(usage?.output_tokens_details)?.reasoning_tokens),
      };
      const why = str(obj(response?.incomplete_details)?.reason);
      return this.done(
        type === 'response.completed'
          ? 'stop'
          : why === 'max_output_tokens' || why === 'max_tokens'
            ? 'length'
            : (why ?? 'incomplete'),
      );
    }
    if (type === 'response.failed') {
      const error = obj(obj(d.response)?.error);
      return [
        {
          type: 'error',
          message: str(error?.message) ?? 'The response failed.',
          code: str(error?.code),
        },
      ];
    }
    if (type === 'error') {
      return [
        {
          type: 'error',
          message: str(d.message) ?? 'OpenAI reported an error.',
          code: str(d.code),
        },
      ];
    }
    return [{ type: 'ignored', why: type || 'unknown event' }];
  }

  private anthropic(d: Json): ChatEvent[] {
    const type = str(d.type) ?? '';
    if (type === 'message_start') {
      const usage = obj(obj(d.message)?.usage);
      const read = num(usage?.cache_read_input_tokens) ?? 0;
      const created = num(usage?.cache_creation_input_tokens) ?? 0;
      const input = num(usage?.input_tokens);
      this.usage.prompt = input === null ? null : input + read + created;
      this.usage.cached = read;
      return [];
    }
    if (type === 'content_block_delta') {
      const delta = obj(d.delta);
      if (delta?.type === 'thinking_delta') return this.reasoning(str(delta.thinking) ?? '');
      if (delta?.type === 'text_delta') {
        const text = str(delta.text);
        return text ? [{ type: 'content', text }] : [];
      }
      return [];
    }
    if (type === 'message_delta') {
      const usage = obj(d.usage);
      this.raw = usage;
      this.usage.output = num(usage?.output_tokens) ?? this.usage.output;
      this.usage.reasoning =
        num(obj(usage?.output_tokens_details)?.thinking_tokens) ?? this.usage.reasoning;
      const stop = str(obj(d.delta)?.stop_reason);
      if (stop) this.stopReason = stop;
      return [];
    }
    if (type === 'message_stop') {
      const stop = this.stopReason;
      return this.done(
        stop === 'end_turn' ? 'stop' : stop === 'max_tokens' ? 'length' : (stop ?? 'stop'),
      );
    }
    if (type === 'error') {
      const error = obj(d.error);
      return [
        {
          type: 'error',
          message: str(error?.message) ?? 'Anthropic reported an error.',
          code: str(error?.type),
        },
      ];
    }
    if (type === 'ping') return [{ type: 'keepalive' }];
    return [];
  }

  private stopReason: string | null = null;

  private gemini(d: Json): ChatEvent[] {
    const error = obj(d.error);
    if (error) {
      return [
        {
          type: 'error',
          message: str(error.message) ?? 'Gemini reported an error.',
          code: str(error.status),
        },
      ];
    }
    const events: ChatEvent[] = [];
    const candidate = obj(list(d.candidates)[0]);
    for (const part of list(obj(candidate?.content)?.parts)) {
      const p = obj(part);
      const text = str(p?.text);
      if (!text) continue;
      if (p?.thought === true) events.push(...this.reasoning(text));
      else events.push({ type: 'content', text });
    }
    const usage = obj(d.usageMetadata);
    if (usage) {
      this.raw = usage;
      this.usage = {
        prompt: num(usage.promptTokenCount),
        cached: num(usage.cachedContentTokenCount),
        output: num(usage.candidatesTokenCount),
        reasoning: num(usage.thoughtsTokenCount),
      };
    }
    const finish = str(candidate?.finishReason);
    if (finish) this.stopReason = finish;
    return events;
  }

  /** Called when the stream ends: Gemini says nothing after its last chunk. */
  end(): ChatEvent[] {
    if (this.provider !== 'gemini' || this.finished) return [];
    const stop = this.stopReason;
    if (stop === null) return [];
    return this.done(
      stop === 'STOP' ? 'stop' : stop === 'MAX_TOKENS' ? 'length' : stop.toLowerCase(),
    );
  }
}

/** A provider's own token counts for a run, from the usage it reported. */
export interface CloudUsage {
  prompt: number | null;
  cached: number | null;
  /** Every output token billed, reasoning included. */
  output: number | null;
  reasoning: number | null;
}

export function cloudUsage(provider: CloudProvider, raw: unknown): CloudUsage {
  const u = obj(raw);
  if (!u) return { prompt: null, cached: null, output: null, reasoning: null };
  if (provider === 'openai') {
    return {
      prompt: num(u.input_tokens),
      cached: num(obj(u.input_tokens_details)?.cached_tokens),
      output: num(u.output_tokens),
      reasoning: num(obj(u.output_tokens_details)?.reasoning_tokens),
    };
  }
  if (provider === 'anthropic') {
    const input = num(u.input_tokens);
    const read = num(u.cache_read_input_tokens);
    return {
      prompt:
        input === null ? null : input + (read ?? 0) + (num(u.cache_creation_input_tokens) ?? 0),
      cached: read,
      output: num(u.output_tokens),
      reasoning: num(obj(u.output_tokens_details)?.thinking_tokens),
    };
  }
  const answer = num(u.candidatesTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  return {
    prompt: num(u.promptTokenCount),
    cached: num(u.cachedContentTokenCount),
    output: answer === null ? null : answer + (thoughts ?? 0),
    reasoning: thoughts,
  };
}
