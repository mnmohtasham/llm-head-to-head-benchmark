import { describe, expect, it } from 'vitest';
import {
  imageConfigSchema,
  imageLabel,
  imageModelReady,
  imagePreflightIssues,
  isImageModel,
  migrateSession,
  normalizeImageStatus,
  stepMetrics,
  type ImagePreflightMachine,
  type StoredSession,
} from '../src';
import { makeRun, makeSession } from './make';

const config = imageConfigSchema.parse({
  model: 'unsloth/FLUX.2-klein-9B-GGUF',
  ggufFilename: 'flux-2-klein-9b-Q4_K_M.gguf',
});

describe('step timing', () => {
  it('reads the first step, the rate, and the decode tail from progress readings', () => {
    // A step every 200 ms after 300 ms of text encoding; the answer 1 s after the last step.
    const samples: Array<[number, number]> = [];
    for (let t = 0; t <= 1500; t += 100)
      samples.push([t, t < 300 ? 0 : Math.min(8, Math.floor((t - 300) / 200) + 1)]);
    const m = stepMetrics(samples, 8, 2600);
    expect(m.firstStepMs).toBe(300);
    // The readings stop at step 7, so the last step was never seen.
    expect(m.lastStepMs).toBeNull();
    const done = stepMetrics([...samples, [1600, 8], [1700, 8]], 8, 2600);
    expect(done.lastStepMs).toBe(1600);
    expect(done.stepsPerSec).toBeCloseTo(7 / 1.3, 3);
    expect(done.decodeTailMs).toBe(1000);
    expect(done.resolutionMs).toBe(100);
  });

  it('gives no rate from a single reading, and uses the furthest step when the last is missed', () => {
    expect(stepMetrics([[500, 3]], 8, 900).stepsPerSec).toBeNull();
    const partial = stepMetrics(
      [
        [100, 1],
        [300, 3],
        [500, 5],
      ],
      8,
      2000,
    );
    expect(partial).toMatchObject({ firstStepMs: 100, lastStepMs: null, decodeTailMs: null });
    expect(partial.stepsPerSec).toBeCloseTo(10, 5);
  });
});

describe('image settings', () => {
  it('default to Unsloth’s own defaults, the baseline speed mode and a fixed seed', () => {
    expect(config).toMatchObject({
      preset: 'lighthouse',
      width: 1024,
      height: 1024,
      steps: 9,
      guidance: 0,
      seed: 42,
      speedMode: 'off',
      memoryMode: 'auto',
      restoreText: true,
    });
    const bad = (patch: Record<string, unknown>) =>
      imageConfigSchema.safeParse({ ...config, ...patch }).error?.issues[0]?.message;
    expect(bad({ width: 1000 })).toBe('The width must be a multiple of 16.');
    expect(bad({ seed: -1 })).toBe('The seed cannot be negative.');
    expect(bad({ preset: 'custom', prompt: '' })).toBe('Write a prompt.');
    expect(bad({ ggufFilename: '../etc/passwd' })).toBe('Pick a .gguf file.');
    expect(imageLabel(config)).toBe(
      'Image "A red and white lighthouse on a rocky cliff at golden hour,…" with FLUX.2-klein-9B-GGUF Q4_K_M, 1024×1024, 9 steps',
    );
  });

  it('knows image models, leaving out video and edit models', () => {
    expect(isImageModel('unsloth/Qwen-Image-2.1-GGUF', null)).toBe(true);
    expect(isImageModel('unsloth/FLUX.2-klein-9B', 'text-to-image')).toBe(true);
    expect(isImageModel('Wan-AI/Wan2.2-TI2V-5B-Diffusers', 'text-to-video')).toBe(false);
    expect(isImageModel('unsloth/Qwen-Image-Edit-GGUF', null)).toBe(false);
    expect(isImageModel('unsloth/Qwen3.8-27B-GGUF', null)).toBe(false);
  });

  it('reads the status Unsloth gave on the RTX machine, and says when no load is needed', () => {
    const idle = normalizeImageStatus({
      loaded: false,
      engine: 'diffusers',
      speed_optims: [],
      resolved: null,
    });
    expect(idle).toMatchObject({ loaded: false, yours: true, engine: 'diffusers', resolved: null });
    const resident = normalizeImageStatus({
      loaded: true,
      repo_id: 'unsloth/FLUX.2-klein-9B-GGUF',
      gguf_filename: 'flux-2-klein-9b-Q4_K_M.gguf',
      memory_mode: 'auto',
      speed_mode: 'off',
      speed_optims: ['channels_last'],
      resolved: {
        speed_mode: {
          value: 'off',
          requested: 'off',
          source: 'explicit',
          status: 'applied',
          reason: null,
        },
      },
    });
    expect(resident.resolved?.speed_mode?.status).toBe('applied');
    expect(imageModelReady(resident, config)).toBe(true);
    expect(imageModelReady({ ...resident, speedMode: 'default' }, config)).toBe(false);
    expect(
      imageModelReady({ ...resident, ggufFilename: 'flux-2-klein-9b-Q8_0.gguf' }, config),
    ).toBe(false);
    expect(imageModelReady({ ...resident, yours: false }, config)).toBe(false);
  });
});

describe('image pre-flight', () => {
  const machine = (patch: Partial<ImagePreflightMachine>): ImagePreflightMachine => ({
    id: 'a',
    name: 'A',
    error: null,
    loading: false,
    image: normalizeImageStatus({ loaded: false }),
    imageError: null,
    onDisk: { ok: true, detail: 'on disk' },
    chatModel: null,
    platform: 'CUDA',
    ...patch,
  });

  it('stops a missing file, warns across platforms, and only notes the chat hand-off', () => {
    const issues = imagePreflightIssues(
      [
        machine({ chatModel: 'unsloth/Qwen3.8-27B-GGUF' }),
        machine({ id: 'b', name: 'B', platform: 'Apple Silicon' }),
        machine({ id: 'c', name: 'C', onDisk: { ok: false, detail: 'C lacks the file.' } }),
      ],
      config,
    );
    expect(issues.map((i) => [i.level, i.code, i.machineId])).toEqual([
      ['note', 'handoff', 'a'],
      ['error', 'image-download', 'c'],
      ['warning', 'image-settings', null],
    ]);
    expect(issues[0]?.text).toContain('Model Duel loads it again when the race ends.');
  });

  it('compares the resolved settings when every machine already has the model', () => {
    const resident = normalizeImageStatus({
      loaded: true,
      repo_id: config.model,
      gguf_filename: config.ggufFilename,
      memory_mode: 'auto',
      speed_mode: 'off',
      engine: 'diffusers',
      device: 'cuda',
      dtype: 'bfloat16',
    });
    const issues = imagePreflightIssues(
      [
        machine({ image: resident }),
        machine({ id: 'b', name: 'B', image: { ...resident, dtype: 'float16' } }),
      ],
      config,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.text).toContain('B runs diffusers · cuda · float16');
  });
});

describe('stored sessions', () => {
  it('migrate from version 6 with empty image fields', () => {
    const v6 = makeSession(['a'], [[makeRun('a')]]) as unknown as Record<string, unknown>;
    v6.schemaVersion = 6;
    v6.provenance = [{ machineId: 'a', statusBefore: null, sttBefore: null, sttAfter: null }];
    const migrated = migrateSession(v6 as unknown as StoredSession);
    expect(migrated.schemaVersion).toBe(7);
    expect(migrated.rounds[0]?.runs[0]?.image).toBeNull();
    expect(migrated.provenance[0]).toMatchObject({
      imageBefore: null,
      imageAfter: null,
      restore: null,
    });
  });
});
