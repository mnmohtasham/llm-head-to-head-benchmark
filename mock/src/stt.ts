import { LIBRISPEECH_CLIP, parseWav } from '@duel/shared';
import type { Profile } from './profiles';

export const STT_ENGINES = ['transformers', 'gguf', 'mtmd'] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

const WHISPER = ['tiny', 'base', 'small', 'large-v3-turbo', 'large-v3'];
const QWEN_ASR = ['qwen3-asr-0.6b', 'qwen3-asr-1.7b'];
export const STT_OFFERED: Record<SttEngine, string[]> = {
  transformers: WHISPER,
  gguf: WHISPER,
  mtmd: QWEN_ASR,
};
/** On disk in every mock; anything else would need a download, which the mock refuses. */
export const STT_DOWNLOADED: Record<SttEngine, string[]> = {
  transformers: ['small', 'large-v3-turbo'],
  gguf: ['small', 'large-v3-turbo'],
  mtmd: ['qwen3-asr-0.6b'],
};

export interface SttLoaded {
  model: string;
  engine: SttEngine;
  device: string;
}

export interface SttState {
  loaded: SttLoaded | null;
  loading: SttLoaded | null;
  lastUsedAt: number;
}

export interface SttMockConfig {
  /** How long a speech model takes to load; null uses the profile's time. */
  loadMs: number | null;
  /** Processing time per second of audio; null uses the profile's speed for the engine. */
  msPerAudioSecond: number | null;
  /** The sidecar unloads the model after this long unused, like Unsloth's keep-alive. */
  idleUnloadMs: number;
}

export const DEFAULT_STT: SttMockConfig = {
  loadMs: null,
  msPerAudioSecond: null,
  idleUnloadMs: 300_000,
};

export const newSttState = (): SttState => ({ loaded: null, loading: null, lastUsedAt: 0 });

/** Unloads the model when it sat unused longer than the keep-alive. */
export function expireIdle(state: SttState, config: SttMockConfig): void {
  if (state.loaded && Date.now() - state.lastUsedAt > config.idleUnloadMs) state.loaded = null;
}

/** The engine a load really uses: gguf falls back to transformers without whisper.cpp. */
export function servedEngine(p: Profile, engine: SttEngine): SttEngine | null {
  if (p.stt[engine]) return engine;
  return engine === 'gguf' && p.stt.transformers ? 'transformers' : null;
}

export function sttBody(p: Profile, state: SttState): Record<string, unknown> {
  const device = p.appleSilicon ? 'mps' : 'cuda';
  const engine = (name: SttEngine) => {
    const loaded = state.loaded?.engine === name ? state.loaded : null;
    return {
      available: p.stt[name],
      loaded_model: loaded?.model ?? null,
      loading: state.loading?.engine === name,
      device: loaded ? device : null,
      keep_alive_seconds: 300,
      default_model: name === 'mtmd' ? null : 'small',
      models: STT_OFFERED[name],
      downloaded_models: p.stt[name] ? STT_DOWNLOADED[name] : [],
      download: {
        downloading: false,
        model: null,
        error: null,
        cancelled: false,
        cancelled_model: null,
        bytes_total: null,
        bytes_done: null,
      },
    };
  };
  return {
    available: p.stt.transformers || p.stt.gguf || p.stt.mtmd,
    loaded_model: state.loaded?.model ?? null,
    loading: state.loading !== null,
    device: state.loaded ? device : null,
    keep_alive_seconds: 300,
    default_model: 'small',
    models: WHISPER,
    transformers: engine('transformers'),
    gguf: engine('gguf'),
    mtmd: engine('mtmd'),
  };
}

export interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

/** Just enough multipart/form-data parsing for the transcription route. */
export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Each part: CRLF, headers, a blank line, the data, CRLF before the next delimiter.
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = part.subarray(0, split).toString('utf8');
      const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
      if (name !== undefined) {
        parts.push({
          name,
          filename: /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null,
          contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? null,
          data: part.subarray(split + 4),
        });
      }
    }
    at = next;
  }
  return parts;
}

/** Profile speed: milliseconds of processing per second of audio, per engine. */
const SPEED: Record<Profile['name'], Record<SttEngine, number>> = {
  'linux-cuda': { gguf: 14, transformers: 22, mtmd: 18 },
  'mac-mlx': { gguf: 30, transformers: 38, mtmd: 26 },
};
/** Every nth word comes out wrong, so the two profiles differ in word error rate. */
const ERROR_EVERY: Record<Profile['name'], Record<SttEngine, number>> = {
  'linux-cuda': { gguf: 48, transformers: 52, mtmd: 40 },
  'mac-mlx': { gguf: 44, transformers: 36, mtmd: 30 },
};

const LOAD_MS: Record<Profile['name'], number> = { 'linux-cuda': 600, 'mac-mlx': 900 };
export const sttLoadMs = (p: Profile, config: SttMockConfig) => config.loadMs ?? LOAD_MS[p.name];

export function processingMs(
  p: Profile,
  engine: SttEngine,
  seconds: number,
  config: SttMockConfig,
): number {
  return (config.msPerAudioSecond ?? SPEED[p.name][engine]) * seconds;
}

const FILLER =
  'the quick brown fox jumps over the lazy dog while a small band plays in the square'.split(' ');

/**
 * What the fake model heard: the LibriSpeech reference when the audio is the clip or the clip
 * repeated, filler words otherwise, with every nth word changed and sentence punctuation added.
 */
export function transcriptFor(
  p: Profile,
  engine: SttEngine,
  audio: Uint8Array,
): {
  text: string;
  seconds: number;
} {
  const seconds = parseWav(audio)?.seconds ?? audio.length / 32_000;
  const times = seconds / LIBRISPEECH_CLIP.seconds;
  const repeats = Math.round(times);
  const words =
    repeats >= 1 && Math.abs(times - repeats) < 0.01
      ? Array.from({ length: repeats }, () => LIBRISPEECH_CLIP.reference.split(' ')).flat()
      : Array.from(
          { length: Math.max(1, Math.round(seconds * 2.6)) },
          (_, i) => FILLER[i % FILLER.length] as string,
        );
  const every = ERROR_EVERY[p.name][engine];
  const heard = words.map((word, i) => {
    const lower = word.toLowerCase();
    if ((i + 1) % every !== 0) return lower;
    return lower.endsWith('s') ? lower.slice(0, -1) : `${lower}s`;
  });
  const sentences: string[] = [];
  for (let i = 0; i < heard.length; i += 14) {
    const sentence = heard.slice(i, i + 14).join(' ');
    sentences.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  return { text: sentences.join(' '), seconds };
}
