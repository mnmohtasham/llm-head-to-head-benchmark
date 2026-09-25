import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  concatWav,
  LIBRISPEECH_CLIP,
  parseWav,
  repeatsFor,
  wavFile,
  type AudioSource,
} from '@duel/shared';

/** The bundled clip sits in `server/assets`, one level up from both `src` and `dist`. */
export const CLIP_PATH = fileURLToPath(
  new URL(`../assets/${LIBRISPEECH_CLIP.file}`, import.meta.url),
);

/** Largest upload: about 25 minutes of 16-bit stereo 44.1 kHz WAV, far more in compressed formats. */
export const AUDIO_UPLOAD_LIMIT = 256 * 1024 * 1024;

let clip: Uint8Array | null = null;
async function clipBytes(): Promise<Uint8Array> {
  clip ??= new Uint8Array(await readFile(CLIP_PATH));
  return clip;
}

export interface Audio {
  bytes: Uint8Array;
  name: string;
  contentType: string;
  /** From the WAV header; null for other formats until the machine says. */
  seconds: number | null;
  /** What was said, for the word error rate. */
  reference: string | null;
}

export interface UploadedAudio {
  id: string;
  name: string;
  bytes: number;
  contentType: string;
  seconds: number | null;
}

/** Uploaded audio, stored by content hash in `<dataDir>/audio/`. */
export class AudioStore {
  constructor(readonly dataDir: string) {}

  private dir(): string {
    return path.join(this.dataDir, 'audio');
  }

  async save(name: string, contentType: string, bytes: Uint8Array): Promise<UploadedAudio> {
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    const id = createHash('sha256').update(bytes).digest('hex');
    const meta: UploadedAudio = {
      id,
      name: name.slice(0, 200) || 'audio',
      bytes: bytes.length,
      contentType: contentType || 'application/octet-stream',
      seconds: parseWav(bytes)?.seconds ?? null,
    };
    await writeFile(path.join(this.dir(), `${id}.bin`), bytes, { mode: 0o600 });
    await writeFile(path.join(this.dir(), `${id}.json`), `${JSON.stringify(meta)}\n`, {
      mode: 0o600,
    });
    return meta;
  }

  async meta(id: string): Promise<UploadedAudio | null> {
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    try {
      return JSON.parse(
        await readFile(path.join(this.dir(), `${id}.json`), 'utf8'),
      ) as UploadedAudio;
    } catch {
      return null;
    }
  }

  async load(id: string): Promise<{ meta: UploadedAudio; bytes: Uint8Array } | null> {
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    try {
      const meta = JSON.parse(
        await readFile(path.join(this.dir(), `${id}.json`), 'utf8'),
      ) as UploadedAudio;
      const bytes = new Uint8Array(await readFile(path.join(this.dir(), `${id}.bin`)));
      return { meta, bytes };
    } catch {
      return null;
    }
  }
}

/** The audio a transcription session sends, with its reference text. */
export async function resolveAudio(
  source: AudioSource,
  store: AudioStore,
): Promise<Audio | string> {
  if (source.kind === 'clip') {
    return {
      bytes: await clipBytes(),
      name: LIBRISPEECH_CLIP.file,
      contentType: 'audio/wav',
      seconds: LIBRISPEECH_CLIP.seconds,
      reference: LIBRISPEECH_CLIP.reference,
    };
  }
  if (source.kind === 'long') {
    const times = repeatsFor(source.minutes);
    const bytes = await clipBytes();
    const joined = concatWav(Array.from({ length: times }, () => bytes));
    if (!joined) return 'The bundled clip could not be repeated.';
    return {
      bytes: joined,
      name: `librispeech-${source.minutes}min.wav`,
      contentType: 'audio/wav',
      seconds: parseWav(joined)?.seconds ?? null,
      reference: Array.from({ length: times }, () => LIBRISPEECH_CLIP.reference).join(' '),
    };
  }
  const saved = await store.load(source.audioId);
  if (!saved) return 'That uploaded audio is gone. Upload it again.';
  return {
    bytes: saved.bytes,
    name: saved.meta.name,
    contentType: saved.meta.contentType,
    seconds: saved.meta.seconds,
    reference: source.reference?.trim() ? source.reference : null,
  };
}

/** What a source will send, without reading or joining the audio: for pre-flight. */
export async function describeAudio(
  source: AudioSource,
  store: AudioStore,
): Promise<{ name: string; seconds: number | null; bytes: number } | string> {
  if (source.kind === 'clip') {
    return {
      name: LIBRISPEECH_CLIP.file,
      seconds: LIBRISPEECH_CLIP.seconds,
      bytes: LIBRISPEECH_CLIP.bytes,
    };
  }
  if (source.kind === 'long') {
    const times = repeatsFor(source.minutes);
    return {
      name: `librispeech-${source.minutes}min.wav`,
      seconds: times * LIBRISPEECH_CLIP.seconds,
      bytes: 44 + times * (LIBRISPEECH_CLIP.bytes - 44),
    };
  }
  const meta = await store.meta(source.audioId);
  if (!meta) return 'That uploaded audio is gone. Upload it again.';
  return { name: meta.name, seconds: meta.seconds, bytes: meta.bytes };
}

/** The first seconds of the clip, for the warm-up: enough to wake the engine, too little to time. */
export async function warmupAudio(seconds = 5): Promise<Audio> {
  const bytes = await clipBytes();
  const info = parseWav(bytes);
  if (!info) throw new Error('The bundled clip is not a WAV file.');
  const perSecond = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  const data = bytes.subarray(
    info.dataOffset,
    info.dataOffset + Math.min(info.dataBytes, Math.round(seconds * perSecond)),
  );
  return {
    bytes: wavFile(info, data),
    name: 'warmup.wav',
    contentType: 'audio/wav',
    seconds,
    reference: null,
  };
}
