import {
  newNonce,
  preflightIssues,
  withNonce,
  type PreflightMachine,
  type PreflightResult,
  type TextConfig,
} from '@duel/shared';
import { readModelStatus } from './models';
import { resolvePrompt } from './presets';
import type { StoredMachine } from './store';
import { UnslothClient } from './unsloth';

/** Asks a machine's own tokenizer how long the prompt is. */
async function countTokens(
  machine: StoredMachine,
  content: string,
): Promise<{ tokens: number | null; error: string | null }> {
  const client = new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 3000 });
  try {
    const answer = await client.postJson(
      '/v1/chat/count_tokens',
      { messages: [{ role: 'user', content }] },
      { timeoutMs: 30_000 },
    );
    const tokens = (answer.body as { input_tokens?: unknown } | null)?.input_tokens;
    if (answer.status === 200 && typeof tokens === 'number') return { tokens, error: null };
    if (answer.status === 503) return { tokens: null, error: 'it is busy generating' };
    if (answer.status === 404) return { tokens: null, error: 'this Unsloth cannot count tokens' };
    return {
      tokens: null,
      error: answer.error?.message ?? `it answered HTTP ${answer.status ?? 'nothing'}`,
    };
  } finally {
    await client.close();
  }
}

/**
 * Everything pre-flight needs, read from the machines themselves: each status, and the prompt's
 * exact length from each machine's tokenizer, with a nonce line when the prefill is cold.
 */
export async function runPreflight(
  machines: readonly StoredMachine[],
  config: TextConfig,
  isLoading: (machineId: string) => boolean,
): Promise<PreflightResult> {
  const prompt = resolvePrompt(config);
  const content = withNonce(prompt, config.prefill === 'cold' ? newNonce() : null);
  const entries: PreflightMachine[] = await Promise.all(
    machines.map(async (machine) => {
      const base = { id: machine.id, name: machine.name };
      if (isLoading(machine.id)) {
        return {
          ...base,
          status: null,
          error: null,
          loading: true,
          promptTokens: null,
          tokenError: null,
        };
      }
      const status = await readModelStatus(machine);
      if (status.error !== null || !status.status?.activeModel) {
        return {
          ...base,
          status: status.status,
          error: status.error,
          loading: false,
          promptTokens: null,
          tokenError: null,
        };
      }
      const counted = await countTokens(machine, content);
      return {
        ...base,
        status: status.status,
        error: null,
        loading: false,
        promptTokens: counted.tokens,
        tokenError: counted.error,
      };
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    issues: preflightIssues(entries, config),
    promptTokens: Object.fromEntries(entries.map((e) => [e.id, e.promptTokens])),
    promptWords: prompt.split(/\s+/).filter(Boolean).length,
  };
}
