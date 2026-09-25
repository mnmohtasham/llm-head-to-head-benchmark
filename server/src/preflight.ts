import {
  imagePreflightIssues,
  newNonce,
  preflightIssues,
  transcribePreflightIssues,
  withNonce,
  type ImageConfig,
  type ImagePreflightMachine,
  type PreflightMachine,
  type PreflightResult,
  type SttPreflightMachine,
  type TextConfig,
  type TranscribeConfig,
} from '@duel/shared';
import { describeAudio, type AudioStore } from './audio';
import { imageFilesOnDisk, readImageStatus } from './imagegen';
import { readModelStatus } from './models';
import { readSttStatus } from './stt';
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

/** The checks for a transcription race: each machine's speech-to-text, and the audio itself. */
export async function runTranscribePreflight(
  machines: readonly StoredMachine[],
  config: TranscribeConfig,
  isLoading: (machineId: string) => boolean,
  store: AudioStore,
): Promise<PreflightResult> {
  const [audio, entries] = await Promise.all([
    describeAudio(config.audio, store),
    Promise.all(
      machines.map(async (machine): Promise<SttPreflightMachine> => {
        const base = { id: machine.id, name: machine.name };
        if (isLoading(machine.id)) return { ...base, stt: null, error: null, loading: true };
        const read = await readSttStatus(machine);
        return { ...base, stt: read.status, error: read.error, loading: false };
      }),
    ),
  ]);
  const issues = transcribePreflightIssues(entries, config);
  if (typeof audio === 'string')
    issues.unshift({ level: 'error', code: 'audio', machineId: null, text: audio });
  return {
    checkedAt: new Date().toISOString(),
    issues,
    promptTokens: {},
    promptWords: 0,
    audio: typeof audio === 'string' ? null : audio,
  };
}

/** Apple Silicon, CUDA or ROCm, from a machine's last probe, for spotting platform differences. */
export function platformName(
  report: { platform: { os: string | null; backend: string | null } } | null,
): string | null {
  const text = `${report?.platform.os ?? ''} ${report?.platform.backend ?? ''}`.toLowerCase();
  if (/mps|mlx|metal|macos|darwin/.test(text)) return 'Apple Silicon';
  if (/rocm|hip/.test(text)) return 'ROCm';
  if (/cuda/.test(text)) return 'CUDA';
  return null;
}

/**
 * The checks for an image race: each machine's image routes and resident model, whether the
 * files are on disk, and which chat model the load will push out.
 */
export async function runImagePreflight(
  machines: readonly StoredMachine[],
  config: ImageConfig,
  isLoading: (machineId: string) => boolean,
  platformOf: (machineId: string) => string | null,
): Promise<PreflightResult> {
  const entries: ImagePreflightMachine[] = await Promise.all(
    machines.map(async (machine) => {
      const base = { id: machine.id, name: machine.name, platform: platformOf(machine.id) };
      if (isLoading(machine.id)) {
        return {
          ...base,
          error: null,
          loading: true,
          image: null,
          imageError: null,
          onDisk: null,
          chatModel: null,
        };
      }
      const [image, chat] = await Promise.all([readImageStatus(machine), readModelStatus(machine)]);
      if (!image.status && chat.error !== null) {
        return {
          ...base,
          error: chat.error,
          loading: false,
          image: null,
          imageError: image.error,
          onDisk: null,
          chatModel: null,
        };
      }
      const onDisk = image.status ? await imageFilesOnDisk(machine, config) : null;
      return {
        ...base,
        error: null,
        loading: false,
        image: image.status,
        imageError: image.error,
        onDisk,
        chatModel: chat.status?.activeModel ?? null,
      };
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    issues: imagePreflightIssues(entries, config),
    promptTokens: {},
    promptWords: 0,
  };
}
