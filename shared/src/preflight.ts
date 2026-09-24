import type { TextConfig } from './chat';
import type { ModelStatus } from './models';
import { backendLabel, speculativeOn } from './session';

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
  /** Errors stop a race; warnings need the user to race anyway on purpose. */
  level: 'error' | 'warning';
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
    | 'tokens';
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

export const hasErrors = (issues: readonly PreflightIssue[]) =>
  issues.some((issue) => issue.level === 'error');
export const hasWarnings = (issues: readonly PreflightIssue[]) =>
  issues.some((issue) => issue.level === 'warning');
