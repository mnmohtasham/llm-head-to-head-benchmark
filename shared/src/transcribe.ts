import { z } from 'zod';

/** Curated Whisper sizes Unsloth maps to its own repositories; a Hugging Face id also works. */
export const STT_MODELS = ['tiny', 'base', 'small', 'large-v3-turbo', 'large-v3'] as const;
export const STT_ENGINES = ['transformers', 'gguf', 'mtmd'] as const;
export const STT_DEVICES = ['auto', 'cpu', 'gpu'] as const;
export type SttEngineName = (typeof STT_ENGINES)[number];

/**
 * The bundled clip: six consecutive utterances by one speaker from LibriSpeech test-clean, with
 * their verified transcripts. LibriSpeech (Panayotov, Chen, Povey and Khudanpur, 2015) is under
 * CC BY 4.0; the audio is 16 kHz mono 16-bit PCM, as the corpus has it.
 */
export const LIBRISPEECH_CLIP = {
  file: 'librispeech-6930-75918.wav',
  seconds: 70.295,
  bytes: 2_249_484,
  speaker: 6930,
  chapter: 75918,
  utterances: [
    '6930-75918-0000',
    '6930-75918-0001',
    '6930-75918-0002',
    '6930-75918-0003',
    '6930-75918-0004',
    '6930-75918-0005',
  ],
  reference:
    'CONCORD RETURNED TO ITS PLACE AMIDST THE TENTS THE ENGLISH FORWARDED TO THE FRENCH BASKETS OF FLOWERS OF WHICH THEY HAD MADE A PLENTIFUL PROVISION TO GREET THE ARRIVAL OF THE YOUNG PRINCESS THE FRENCH IN RETURN INVITED THE ENGLISH TO A SUPPER WHICH WAS TO BE GIVEN THE NEXT DAY CONGRATULATIONS WERE POURED IN UPON THE PRINCESS EVERYWHERE DURING HER JOURNEY FROM THE RESPECT PAID HER ON ALL SIDES SHE SEEMED LIKE A QUEEN AND FROM THE ADORATION WITH WHICH SHE WAS TREATED BY TWO OR THREE SHE APPEARED AN OBJECT OF WORSHIP THE QUEEN MOTHER GAVE THE FRENCH THE MOST AFFECTIONATE RECEPTION FRANCE WAS HER NATIVE COUNTRY AND SHE HAD SUFFERED TOO MUCH UNHAPPINESS IN ENGLAND FOR ENGLAND TO HAVE MADE HER FORGET FRANCE SHE TAUGHT HER DAUGHTER THEN BY HER OWN AFFECTION FOR IT THAT LOVE FOR A COUNTRY WHERE THEY HAD BOTH BEEN HOSPITABLY RECEIVED AND WHERE A BRILLIANT FUTURE OPENED BEFORE THEM THE COUNT HAD THROWN HIMSELF BACK ON HIS SEAT LEANING HIS SHOULDERS AGAINST THE PARTITION OF THE TENT AND REMAINED THUS HIS FACE BURIED IN HIS HANDS WITH HEAVING CHEST AND RESTLESS LIMBS',
  attribution:
    'LibriSpeech test-clean, speaker 6930, chapter 75918, utterances 0000 to 0005. V. Panayotov, G. Chen, D. Povey and S. Khudanpur, "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015. CC BY 4.0.',
} as const;

export const audioSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clip') }),
  /** The clip repeated until it lasts at least this many minutes. */
  z.object({ kind: z.literal('long'), minutes: z.number().int().min(1).max(30) }),
  z.object({
    kind: z.literal('upload'),
    audioId: z.string().regex(/^[0-9a-f]{64}$/, 'Upload the audio first.'),
    name: z.string().max(200),
    /** What was said, for the word error rate; null skips it. */
    reference: z.string().max(200_000).nullable(),
  }),
]);
export type AudioSource = z.infer<typeof audioSourceSchema>;

export const transcribeConfigSchema = z.object({
  audio: audioSourceSchema,
  /** A curated size, or a Hugging Face `owner/model` id. */
  model: z
    .string()
    .trim()
    .min(1, 'Pick a model.')
    .max(200)
    .refine(
      (m) =>
        (STT_MODELS as readonly string[]).includes(m) ||
        /^[\w.-]+\/[\w.-]+$/.test(m) ||
        /^qwen3-asr-/.test(m),
      'Use a curated size or a Hugging Face owner/model id.',
    ),
  engine: z.enum(STT_ENGINES).default('gguf'),
  device: z.enum(STT_DEVICES).default('auto'),
  language: z.string().trim().min(2).max(8).default('en'),
});
export type TranscribeConfig = z.infer<typeof transcribeConfigSchema>;

export interface WerResult {
  /** Errors per reference word: substitutions, deletions and insertions over the reference length. */
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
  /** Word by word, for highlighting what differs. */
  alignment: Array<{ op: 'ok' | 'sub' | 'del' | 'ins'; ref: string | null; hyp: string | null }>;
}

/** What one machine did with one audio file. */
export interface TranscriptionResult {
  text: string;
  language: string | null;
  /** Length of the audio, from the machine's answer or the file itself. */
  audioSeconds: number | null;
  bytes: number;
  /** From the request to the last byte of the file handed to the network. */
  uploadMs: number | null;
  /** From the last byte sent to the first byte of the answer, measured by Model Duel. */
  processingMs: number | null;
  /** Unsloth's own processing time from its monitor, which starts after the upload. */
  serverProcessingMs: number | null;
  /** Audio seconds per processing second: 20 means twenty times faster than real time. */
  rtf: number | null;
  serverRtf: number | null;
  /** Time to load the model before the round, when it had to be loaded. */
  loadMs: number | null;
  wer: WerResult | null;
  /** The engine and device that actually served, read back after the run. */
  engine: string | null;
  device: string | null;
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Whole numbers as English words, up to the billions: 1861 becomes "one thousand eight hundred sixty one". */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return String(n);
  if (n < 20) return ONES[n] ?? String(n);
  if (n < 100)
    return [TENS[Math.floor(n / 10)], n % 10 ? ONES[n % 10] : ''].filter(Boolean).join(' ');
  if (n < 1000) {
    return [`${ONES[Math.floor(n / 100)]} hundred`, n % 100 ? numberToWords(n % 100) : '']
      .filter(Boolean)
      .join(' ');
  }
  for (const [size, name] of [
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ] as const) {
    if (n >= size) {
      const head = numberToWords(Math.floor(n / size));
      const rest = n % size;
      return [`${head} ${name}`, rest ? numberToWords(rest) : ''].filter(Boolean).join(' ');
    }
  }
  return String(n);
}

/**
 * Text as word error rate compares it: lower case, numbers spelled out, punctuation and dashes
 * gone, apostrophes inside words kept, one space between words.
 */
export function normalizeForWer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(
      /(\d+)\.(\d+)/g,
      (_m, a: string, b: string) =>
        `${numberToWords(Number(a))} point ${b
          .split('')
          .map((d) => numberToWords(Number(d)))
          .join(' ')}`,
    )
    .replace(/\d+/g, (digits) => ` ${numberToWords(Number(digits))} `)
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/(^|\s)'+|'+(\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate by word-level Levenshtein alignment of the normalised texts. */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = normalizeForWer(reference);
  const hyp = normalizeForWer(hypothesis);
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  // Costs never exceed the longer text, so half-hour transcripts fit 16 bits and half the memory.
  const cost = rows + cols < 65_535 ? new Uint16Array(rows * cols) : new Uint32Array(rows * cols);
  for (let i = 0; i < rows; i += 1) cost[i * cols] = i;
  for (let j = 0; j < cols; j += 1) cost[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      cost[i * cols + j] = Math.min(
        (cost[(i - 1) * cols + j - 1] ?? 0) + same,
        (cost[(i - 1) * cols + j] ?? 0) + 1,
        (cost[i * cols + j - 1] ?? 0) + 1,
      );
    }
  }
  const alignment: WerResult['alignment'] = [];
  let i = ref.length;
  let j = hyp.length;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    const here = cost[i * cols + j] ?? 0;
    if (
      i > 0 &&
      j > 0 &&
      ref[i - 1] === hyp[j - 1] &&
      here === (cost[(i - 1) * cols + j - 1] ?? 0)
    ) {
      alignment.push({ op: 'ok', ref: ref[i - 1] ?? null, hyp: hyp[j - 1] ?? null });
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && here === (cost[(i - 1) * cols + j - 1] ?? 0) + 1) {
      alignment.push({ op: 'sub', ref: ref[i - 1] ?? null, hyp: hyp[j - 1] ?? null });
      substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === (cost[(i - 1) * cols + j] ?? 0) + 1) {
      alignment.push({ op: 'del', ref: ref[i - 1] ?? null, hyp: null });
      deletions += 1;
      i -= 1;
    } else {
      alignment.push({ op: 'ins', ref: null, hyp: hyp[j - 1] ?? null });
      insertions += 1;
      j -= 1;
    }
  }
  alignment.reverse();
  const errors = substitutions + deletions + insertions;
  return {
    wer: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : errors / ref.length,
    substitutions,
    deletions,
    insertions,
    referenceWords: ref.length,
    alignment,
  };
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Where the PCM samples start, and how many bytes of them there are. */
  dataOffset: number;
  dataBytes: number;
  seconds: number;
}

/** Reads a RIFF/WAVE header, walking its chunks; null when the bytes are not a PCM WAV file. */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let offset = 12;
  let format: { rate: number; channels: number; bits: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      format = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data' && format) {
      const dataBytes = Math.min(size, bytes.length - body);
      const perSecond = format.rate * format.channels * (format.bits / 8);
      return {
        sampleRate: format.rate,
        channels: format.channels,
        bitsPerSample: format.bits,
        dataOffset: body,
        dataBytes,
        seconds: perSecond > 0 ? dataBytes / perSecond : 0,
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** A PCM WAV file with a plain 44-byte header around the given samples. */
export function wavFile(
  info: Pick<WavInfo, 'sampleRate' | 'channels' | 'bitsPerSample'>,
  data: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i);
  };
  const blockAlign = info.channels * (info.bitsPerSample / 8);
  write(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, info.channels, true);
  view.setUint32(24, info.sampleRate, true);
  view.setUint32(28, info.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, info.bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** WAV files of the same format joined into one; null when they are not all PCM WAV of one format. */
export function concatWav(files: readonly Uint8Array[]): Uint8Array | null {
  const infos = files.map(parseWav);
  const first = infos[0];
  if (
    !first ||
    infos.some(
      (i) =>
        !i ||
        i.sampleRate !== first.sampleRate ||
        i.channels !== first.channels ||
        i.bitsPerSample !== first.bitsPerSample,
    )
  ) {
    return null;
  }
  const total = infos.reduce((sum, i) => sum + (i?.dataBytes ?? 0), 0);
  const data = new Uint8Array(total);
  let at = 0;
  files.forEach((file, index) => {
    const info = infos[index];
    if (!info) return;
    data.set(file.subarray(info.dataOffset, info.dataOffset + info.dataBytes), at);
    at += info.dataBytes;
  });
  return wavFile(first, data);
}

/** How many times the clip repeats to last at least `minutes`. */
export function repeatsFor(
  minutes: number,
  clipSeconds: number = LIBRISPEECH_CLIP.seconds,
): number {
  return Math.max(1, Math.ceil((minutes * 60) / clipSeconds));
}

/** The engines of Unsloth's STT status, reduced to what a race needs. */
export interface SttStatus {
  available: boolean;
  /** The model in memory, its engine and device, if any. */
  loadedModel: string | null;
  loadedEngine: SttEngineName | null;
  device: string | null;
  loading: boolean;
  keepAliveSeconds: number | null;
  engines: Record<SttEngineName, { available: boolean; models: string[]; downloaded: string[] }>;
}

export function normalizeSttStatus(body: unknown): SttStatus {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const engines = {} as SttStatus['engines'];
  let loadedEngine: SttEngineName | null = null;
  let loadedModel: string | null = null;
  let device: string | null = null;
  let loading = false;
  for (const engine of STT_ENGINES) {
    const e = (b[engine] && typeof b[engine] === 'object' ? b[engine] : {}) as Record<
      string,
      unknown
    >;
    engines[engine] = {
      available: e.available === true,
      models: list(e.models),
      downloaded: list(e.downloaded_models),
    };
    if (typeof e.loaded_model === 'string' && e.loaded_model) {
      loadedEngine = engine;
      loadedModel = e.loaded_model;
      device = typeof e.device === 'string' ? e.device : null;
    }
    if (e.loading === true) loading = true;
  }
  return {
    available: b.available === true,
    loadedModel: loadedModel ?? (typeof b.loaded_model === 'string' ? b.loaded_model : null),
    loadedEngine,
    device: device ?? (typeof b.device === 'string' ? b.device : null),
    loading: loading || b.loading === true,
    keepAliveSeconds: typeof b.keep_alive_seconds === 'number' ? b.keep_alive_seconds : null,
    engines,
  };
}
