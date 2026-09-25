import { describe, expect, it } from 'vitest';
import {
  audioLabel,
  concatWav,
  LIBRISPEECH_CLIP,
  normalizeSttStatus,
  normalizeForWer,
  numberToWords,
  parseWav,
  repeatsFor,
  transcribeConfigSchema,
  wavFile,
  wordErrorRate,
} from '../src';

const tone = (samples: number, rate = 16_000) =>
  wavFile(
    { sampleRate: rate, channels: 1, bitsPerSample: 16 },
    new Uint8Array(samples * 2).fill(7),
  );

describe('word error rate', () => {
  it('ignores case, punctuation and spelled-out numbers', () => {
    expect(normalizeForWer('In 1861, the Queen’s “ball” was held—at 3.5 PM!')).toEqual([
      'in',
      'one',
      'thousand',
      'eight',
      'hundred',
      'sixty',
      'one',
      'the',
      "queen's",
      'ball',
      'was',
      'held',
      'at',
      'three',
      'point',
      'five',
      'pm',
    ]);
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(2_000_015)).toBe('two million fifteen');
    expect(
      wordErrorRate('Concord returned to its place.', 'concord returned to its place'),
    ).toMatchObject({
      wer: 0,
      referenceWords: 5,
    });
  });

  it('counts substitutions, deletions and insertions against the reference length', () => {
    const result = wordErrorRate('the cat sat on the mat', 'the bat sat on mat');
    expect(result).toMatchObject({
      substitutions: 1,
      deletions: 1,
      insertions: 0,
      referenceWords: 6,
    });
    expect(result.wer).toBeCloseTo(2 / 6);
    expect(result.alignment.map((a) => a.op)).toEqual(['ok', 'sub', 'ok', 'ok', 'del', 'ok']);
    const extra = wordErrorRate('one two three', 'one two three four');
    expect(extra).toMatchObject({ insertions: 1, wer: 1 / 3 });
    expect(extra.alignment.at(-1)).toEqual({ op: 'ins', ref: null, hyp: 'four' });
    expect(wordErrorRate('', '').wer).toBe(0);
    expect(wordErrorRate('', 'noise').wer).toBe(1);
  });

  it('scores the bundled reference against itself as perfect, and one wrong word as 1 in 190', () => {
    expect(normalizeForWer(LIBRISPEECH_CLIP.reference)).toHaveLength(190);
    expect(
      wordErrorRate(LIBRISPEECH_CLIP.reference, LIBRISPEECH_CLIP.reference.toLowerCase()).wer,
    ).toBe(0);
    const wrong = LIBRISPEECH_CLIP.reference.replace('CONCORD', 'CONCORDE');
    expect(wordErrorRate(LIBRISPEECH_CLIP.reference, wrong).wer).toBeCloseTo(1 / 190);
  });

  it('aligns a half-hour transcript quickly', () => {
    const reference = Array.from({ length: 26 }, () => LIBRISPEECH_CLIP.reference).join(' ');
    const started = performance.now();
    const result = wordErrorRate(reference, reference.replace(/PRINCESS/g, 'PRINCE'));
    expect(result.referenceWords).toBe(26 * 190);
    expect(result.substitutions).toBe(26 * 2);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('WAV files', () => {
  it('reads the header, joins files of one format, and refuses mixed formats', () => {
    const a = tone(16_000);
    const b = tone(8_000);
    expect(parseWav(a)).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
      dataOffset: 44,
      seconds: 1,
    });
    const joined = concatWav([a, b]);
    expect(joined && parseWav(joined)?.seconds).toBeCloseTo(1.5);
    expect(concatWav([a, tone(100, 44_100)])).toBeNull();
    expect(parseWav(new TextEncoder().encode('ID3 not a wav file'))).toBeNull();
  });

  it('repeats the clip until it lasts the minutes asked for', () => {
    expect(repeatsFor(1)).toBe(1);
    expect(repeatsFor(2)).toBe(2);
    expect(repeatsFor(30)).toBe(26);
    expect(repeatsFor(30) * LIBRISPEECH_CLIP.seconds).toBeGreaterThanOrEqual(1800);
  });
});

describe('transcription settings', () => {
  it('default to GGUF on the best device in English, and describe the audio', () => {
    const config = transcribeConfigSchema.parse({
      audio: { kind: 'clip' },
      model: 'large-v3-turbo',
    });
    expect(config).toMatchObject({ engine: 'gguf', device: 'auto', language: 'en' });
    expect(audioLabel(config)).toBe(
      'Transcribe LibriSpeech clip, 70 s with large-v3-turbo on gguf',
    );
    expect(audioLabel({ ...config, audio: { kind: 'long', minutes: 10 } })).toContain(
      'repeated 9 times',
    );
    expect(
      transcribeConfigSchema.safeParse({ audio: { kind: 'clip' }, model: 'rm -rf' }).success,
    ).toBe(false);
    expect(
      transcribeConfigSchema.safeParse({ audio: { kind: 'clip' }, model: 'openai/whisper-small' })
        .success,
    ).toBe(true);
  });

  it('read Unsloth’s STT status, per engine', () => {
    const status = normalizeSttStatus({
      available: true,
      keep_alive_seconds: 300,
      transformers: { available: true, models: ['small'], downloaded_models: [] },
      gguf: {
        available: true,
        loaded_model: 'large-v3-turbo',
        device: 'cuda',
        models: ['small', 'large-v3-turbo'],
        downloaded_models: ['large-v3-turbo'],
      },
      mtmd: { available: false },
    });
    expect(status).toMatchObject({
      available: true,
      loadedModel: 'large-v3-turbo',
      loadedEngine: 'gguf',
      device: 'cuda',
      keepAliveSeconds: 300,
    });
    expect(status.engines.gguf.downloaded).toEqual(['large-v3-turbo']);
    expect(status.engines.mtmd).toEqual({ available: false, models: [], downloaded: [] });
  });
});
