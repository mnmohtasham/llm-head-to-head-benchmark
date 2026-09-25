import type { TextConfig } from './chat';
import type { ModelStatus } from './models';
import { backendLabel, speculativeOn } from './session';
import { STT_MODELS, type SttStatus, type TranscribeConfig } from './transcribe';
import { imageModelReady, imageSettingsLine, type ImageConfig, type ImageStatus } from './images';

/** What pre-flight knows about one machine just before a race. */
export interface PreflightMachine {
  id: string;
  name: string;
  status: ModelStatus | null;
  /** Why the status could not be read. */
  error: string | null;
  loading: boolean;
  /** The exact prompt length from the machine's own tokenizer, or null when it could not count. */
  promptTokens: number | null;
  tokenError: string | null;
}

export interface PreflightIssue {
  /** Errors stop a race; warnings need the user to race anyway on purpose; notes only inform. */
  level: 'error' | 'warning' | 'note';
  code:
    | 'unreachable'
    | 'loading'
    | 'no-model'
    | 'memory'
    | 'no-fit'
    | 'no-thinking'
    | 'model'
    | 'quant'
    | 'backend'
    | 'context'
    | 'speculative'
    | 'kv-cache'
    | 'gpu-memory'
    | 'tokens'
    | 'audio'
    | 'no-stt'
    | 'stt-engine'
    | 'stt-model'
    | 'stt-download'
    | 'no-image'
    | 'image-download'
    | 'image-busy'
    | 'image-settings'
    | 'image-speed'
    | 'handoff';
  machineId: string | null;
  text: string;
}

export interface PreflightResult {
  checkedAt: string;
  issues: PreflightIssue[];
  /** Prompt tokens per machine id, from each machine's tokenizer. */
  promptTokens: Record<string, number | null>;
  /** Words in the prompt that will be sent, before any nonce. */
  promptWords: number;
  /** The audio a transcription race will send. */
  audio?: { name: string; seconds: number | null; bytes: number } | null;
}

const n = (value: number) => value.toLocaleString('en-US');

function speculativeLabel(status: ModelStatus): string {
  if (!speculativeOn(status)) return 'off';
  return [status.speculativeType, status.specDrafterKind].filter(Boolean).join(' · ');
}

/**
 * The fairness checks before a race. Errors make a race impossible or meaningless; warnings mean
 * it compares more than the hardware, which can be what the user wants.
 */
export function preflightIssues(
  machines: readonly PreflightMachine[],
  config: Pick<TextConfig, 'maxTokens' | 'thinking'>,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const error = (code: PreflightIssue['code'], machineId: string | null, text: string) =>
    issues.push({ level: 'error', code, machineId, text });
  const warning = (code: PreflightIssue['code'], machineId: string | null, text: string) =>
    issues.push({ level: 'warning', code, machineId, text });

  for (const m of machines) {
    const s = m.status;
    if (m.error) {
      error('unreachable', m.id, `${m.name} is not answering: ${m.error}`);
      continue;
    }
    if (m.loading) {
      error('loading', m.id, `A model is loading on ${m.name}. Wait for it to finish.`);
      continue;
    }
    if (!s?.activeModel) {
      error('no-model', m.id, `No model is loaded on ${m.name}. Load one on the Models tab.`);
      continue;
    }
    if (s.memoryWarning) {
      error(
        'memory',
        m.id,
        `${m.name} is short of memory for its model (${s.memoryWarning}), so part of it runs from disk. That is not a fair comparison; load a smaller quant or a shorter context.`,
      );
    }
    if (config.thinking && !s.supportsReasoning) {
      error(
        'no-thinking',
        m.id,
        `The model on ${m.name} cannot think. Turn Thinking off to race it.`,
      );
    }
    const context = s.contextLength;
    if (m.promptTokens !== null && context !== null) {
      if (m.promptTokens >= context) {
        error(
          'no-fit',
          m.id,
          `The prompt alone is ${n(m.promptTokens)} tokens, longer than ${m.name}'s context of ${n(context)}. Pick a shorter prompt, or load the model with a longer context.`,
        );
      } else if (m.promptTokens + config.maxTokens > context) {
        error(
          'no-fit',
          m.id,
          `The prompt (${n(m.promptTokens)} tokens) and Max tokens (${n(config.maxTokens)}) do not fit ${m.name}'s context of ${n(context)}. Lower Max tokens to ${n(context - m.promptTokens)} or less, or load a longer context.`,
        );
      }
    } else if (m.tokenError) {
      warning(
        'tokens',
        m.id,
        `${m.name} could not count the prompt's tokens (${m.tokenError}), so pre-flight could not check that it fits.`,
      );
    }
  }

  const loaded = machines.filter(
    (m): m is PreflightMachine & { status: ModelStatus } =>
      !m.error && !m.loading && !!m.status?.activeModel,
  );
  if (loaded.length < 2) return issues;
  const compare = (
    code: PreflightIssue['code'],
    what: string,
    pick: (s: ModelStatus) => string,
  ) => {
    const values = loaded.map((m) => pick(m.status));
    if (new Set(values).size > 1) {
      const each = loaded.map((m, i) => `${m.name} has ${values[i]}`).join(', ');
      warning(code, null, `The machines run different ${what}: ${each}.`);
    }
  };
  compare('model', 'models', (s) => s.activeModel ?? 'none');
  const sameModel = new Set(loaded.map((m) => m.status.activeModel)).size === 1;
  if (sameModel) compare('quant', 'quants', (s) => s.quant ?? 'unknown');
  compare('backend', 'backends', (s) => backendLabel(s.backend));
  compare('context', 'context lengths', (s) =>
    s.contextLength === null ? 'unknown' : `${n(s.contextLength)} tokens`,
  );
  compare('speculative', 'speculative decoding', speculativeLabel);
  compare('kv-cache', 'KV cache types', (s) => s.cacheTypeKv ?? 'the default');
  compare('gpu-memory', 'GPU memory modes', (s) => s.gpuMemoryMode ?? 'the default');
  const speculative = loaded.filter((m) => speculativeOn(m.status));
  if (speculative.length > 0 && speculative.length === loaded.length) {
    warning(
      'speculative',
      null,
      `Speculative decoding is on for every machine, so tokens arrive in groups and speed depends on how many drafts each model keeps. Load with speculative decoding off for a like-for-like race.`,
    );
  }
  return issues;
}

/** What pre-flight knows about one machine's speech-to-text before a transcription race. */
export interface SttPreflightMachine {
  id: string;
  name: string;
  stt: SttStatus | null;
  error: string | null;
  /** A text model is loading on the machine. */
  loading: boolean;
}

/**
 * The checks before a transcription race. A model that is not downloaded is an error, because
 * loading it would start a download of up to a few gigabytes in the middle of the race.
 */
export function transcribePreflightIssues(
  machines: readonly SttPreflightMachine[],
  config: Pick<TranscribeConfig, 'model' | 'engine'>,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const error = (code: PreflightIssue['code'], machineId: string | null, text: string) =>
    issues.push({ level: 'error', code, machineId, text });
  const warning = (code: PreflightIssue['code'], machineId: string | null, text: string) =>
    issues.push({ level: 'warning', code, machineId, text });
  const served = new Map<string, string>();
  for (const m of machines) {
    if (m.error) {
      error('unreachable', m.id, `${m.name} is not answering: ${m.error}`);
      continue;
    }
    if (m.loading) {
      error('loading', m.id, `A model is loading on ${m.name}. Wait for it to finish.`);
      continue;
    }
    const stt = m.stt;
    if (!stt?.available) {
      error('no-stt', m.id, `${m.name} has no speech-to-text in this Unsloth.`);
      continue;
    }
    if (stt.loading) {
      error('loading', m.id, `A speech model is loading on ${m.name}. Wait for it to finish.`);
      continue;
    }
    let engine: string = config.engine;
    if (!stt.engines[config.engine].available) {
      if (config.engine === 'gguf' && stt.engines.transformers.available) {
        engine = 'transformers';
        warning(
          'stt-engine',
          m.id,
          `${m.name} cannot run GGUF speech models (whisper.cpp is not built), so it will use transformers instead.`,
        );
      } else {
        error('stt-engine', m.id, `${m.name} cannot run the ${config.engine} engine.`);
        continue;
      }
    }
    served.set(m.id, engine);
    const offered = stt.engines[engine as keyof SttStatus['engines']];
    const curated =
      (STT_MODELS as readonly string[]).includes(config.model) || /^qwen3-asr-/.test(config.model);
    if (curated && offered.models.length > 0 && !offered.models.includes(config.model)) {
      error(
        'stt-model',
        m.id,
        `The ${engine} engine on ${m.name} does not offer ${config.model}. It offers ${offered.models.join(', ')}.`,
      );
      continue;
    }
    const inMemory = stt.loadedModel === config.model && stt.loadedEngine === engine;
    if (!inMemory && !offered.downloaded.includes(config.model)) {
      error(
        'stt-download',
        m.id,
        `${config.model} is not downloaded for ${engine} on ${m.name}${offered.downloaded.length > 0 ? ` (it has ${offered.downloaded.join(', ')})` : ''}. Download it in Unsloth Studio first, so the race does not start a download.`,
      );
    }
  }
  const engines = new Set(served.values());
  if (engines.size > 1) {
    const each = machines
      .filter((m) => served.has(m.id))
      .map((m) => `${m.name} uses ${served.get(m.id)}`)
      .join(', ');
    warning('stt-engine', null, `The machines use different engines: ${each}.`);
  }
  return issues;
}

/** What pre-flight knows about one machine before an image race. */
export interface ImagePreflightMachine {
  id: string;
  name: string;
  /** Why the machine could not be read at all. */
  error: string | null;
  /** A chat model load is running. */
  loading: boolean;
  /** The image status, or null with `imageError` when the routes are missing. */
  image: ImageStatus | null;
  imageError: string | null;
  /** Whether the model's files are on disk; null when that could not be read. */
  onDisk: { ok: boolean; detail: string } | null;
  /** The chat model loaded now, which the image load will push out. */
  chatModel: string | null;
  /** Apple Silicon, CUDA, ROCm, or null when unknown. */
  platform: string | null;
}

/**
 * The checks before an image race. A missing file is an error, because loading it would start a
 * download. Unloading the chat model is only a note: the tab exists to do that.
 */
export function imagePreflightIssues(
  machines: readonly ImagePreflightMachine[],
  config: ImageConfig,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const add =
    (level: PreflightIssue['level']) =>
    (code: PreflightIssue['code'], machineId: string | null, text: string) =>
      issues.push({ level, code, machineId, text });
  const error = add('error');
  const warning = add('warning');
  const note = add('note');
  const usable: ImagePreflightMachine[] = [];
  for (const m of machines) {
    if (m.error) {
      error('unreachable', m.id, `${m.name} is not answering: ${m.error}`);
      continue;
    }
    if (m.loading) {
      error('loading', m.id, `A model is loading on ${m.name}. Wait for it to finish.`);
      continue;
    }
    if (!m.image) {
      error(
        'no-image',
        m.id,
        `${m.name} cannot generate images: ${m.imageError ?? 'no image routes'}.`,
      );
      continue;
    }
    if (!m.onDisk) {
      warning(
        'image-download',
        m.id,
        `Pre-flight could not check that ${config.model} is on ${m.name}'s disk. If it is not, loading it starts a download.`,
      );
    } else if (!m.onDisk.ok) {
      error(
        'image-download',
        m.id,
        `${m.onDisk.detail} Download it in Unsloth Studio first, so the race does not start a download.`,
      );
      continue;
    }
    if (m.image.loaded && !m.image.yours) {
      warning(
        'image-busy',
        m.id,
        `Another account's image model is loaded on ${m.name}. Loading this one replaces it.`,
      );
    }
    usable.push(m);
    if (m.chatModel) {
      note(
        'handoff',
        m.id,
        `Loading the image model unloads ${m.chatModel} on ${m.name}. ${config.restoreText ? 'Model Duel loads it again when the race ends.' : 'It stays unloaded after the race.'}`,
      );
    }
  }
  if (config.speedMode !== 'off') {
    note(
      'image-speed',
      null,
      `Speed mode ${config.speedMode} compiles the model during the first images, so a warm-up matters, and the pixels may differ from the "off" baseline.`,
    );
  }
  if (usable.length < 2) return issues;
  const ready = usable.filter((m) => m.image && imageModelReady(m.image, config));
  if (ready.length === usable.length) {
    const lines = ready.map((m) => imageSettingsLine(m.image as ImageStatus));
    if (new Set(lines).size > 1) {
      warning(
        'image-settings',
        null,
        `The machines resolved the model differently: ${ready.map((m, i) => `${m.name} runs ${lines[i]}`).join('; ')}.`,
      );
    }
  } else {
    const platforms = new Set(usable.map((m) => m.platform).filter(Boolean));
    if (platforms.size > 1) {
      warning(
        'image-settings',
        null,
        `The machines run on ${[...platforms].join(' and ')}, so Unsloth picks a different engine, precision or speed setting on each, and one seed gives different pixels. The report prints what each machine used.`,
      );
    }
  }
  return issues;
}

export const hasErrors = (issues: readonly PreflightIssue[]) =>
  issues.some((issue) => issue.level === 'error');
export const hasWarnings = (issues: readonly PreflightIssue[]) =>
  issues.some((issue) => issue.level === 'warning');
