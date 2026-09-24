import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  DEFAULT_LOAD_SETTINGS,
  interpretLoadResponse,
  loadRequestSchema,
  looksLikeDiffusionModel,
  mergeLocalModels,
  normalizeLoadProgress,
  normalizeStatus,
  splitArgs,
  unslothLoadBody,
  type LocalModel,
  type VariantsAnswer,
} from '../src/models';
import type { RouteResult } from '../src/probe';

interface ModelsFixture {
  local: unknown;
  v1Models: unknown;
  status: unknown;
  loadProgress: unknown;
  variants: Record<string, VariantsAnswer>;
}

const real = JSON.parse(
  readFileSync(new URL('../../fixtures/models/real-linux-rtx3060.json', import.meta.url), 'utf8'),
) as ModelsFixture;

const BASE = 'http://192.168.1.20:8888';

function route(
  status: number | null,
  body: unknown,
  extra: Partial<RouteResult> = {},
): RouteResult {
  return {
    path: '/api/inference/load',
    status,
    ms: 10,
    contentType: 'application/json',
    body,
    error: null,
    ...extra,
  };
}

describe('mergeLocalModels on a real Unsloth', () => {
  const models = mergeLocalModels(real.local, real.v1Models, real.variants);
  const byId = (id: string) => models.find((m) => m.modelId === id);

  it('keeps text models and drops image, video and partly downloaded ones', () => {
    expect(models.map((m) => m.modelId).sort()).toEqual([
      'deepreinforce-ai/Ornith-1.0-9B-GGUF',
      'lmstudio-community/Qwen3.8-27B-GGUF',
      'lmstudio-community/gemma-4-12B-it-QAT-GGUF',
      'unsloth/Qwen3.8-27B-GGUF',
      'unsloth/gemma-4-E4B-it-unsloth-bnb-4bit',
    ]);
  });

  it('offers only complete quants, never the partly downloaded one', () => {
    expect(byId('unsloth/Qwen3.8-27B-GGUF')).toMatchObject({
      loadId: 'unsloth/Qwen3.8-27B-GGUF',
      format: 'gguf',
      quants: [expect.objectContaining({ quant: 'UD-IQ2_XXS' })],
      defaultQuant: 'UD-IQ2_XXS',
      nativeContextLength: 262144,
    });
  });

  it('loads LM Studio models through their ref handle, listed once', () => {
    const lmstudio = byId('lmstudio-community/Qwen3.8-27B-GGUF');
    expect(lmstudio?.loadId).toMatch(/^ref:[0-9a-f]+$/);
    expect(lmstudio?.source).toBe('lmstudio');
    expect(lmstudio?.quants.map((q) => q.quant)).toEqual(['Q4_K_M']);
    expect(models.filter((m) => m.modelId === 'lmstudio-community/Qwen3.8-27B-GGUF')).toHaveLength(
      1,
    );
  });

  it('treats a checkpoint without GGUF files as safetensors with no quants', () => {
    expect(byId('unsloth/gemma-4-E4B-it-unsloth-bnb-4bit')).toMatchObject({
      format: 'safetensors',
      quants: [],
    });
  });

  it('normalises the status of a machine with nothing loaded', () => {
    expect(normalizeStatus(real.status)).toMatchObject({
      activeModel: null,
      backend: null,
      contextLength: null,
      speculativeType: null,
      gpuMemoryMode: 'auto',
      gpuLayers: -1,
      loading: [],
      memoryWarning: null,
      reasoningEffortLevels: [],
    });
    expect(normalizeLoadProgress(real.loadProgress)).toEqual({
      phase: null,
      bytesLoaded: 0,
      bytesTotal: 0,
      fraction: 0,
    });
  });
});

describe('mergeLocalModels edge cases', () => {
  it('falls back to the catalog quant when the quant list cannot be read', () => {
    const local = {
      models: [
        {
          id: 'ref:abc',
          model_id: 'org/Model-GGUF',
          display_name: 'Model-GGUF',
          source: 'lmstudio',
          model_format: 'gguf',
          task: null,
          partial: false,
        },
      ],
    };
    const catalog = { data: [{ id: 'org/Model-GGUF', loaded: true, quant: 'Q5_K_M' }] };
    const variants = {
      'ref:abc': {
        status: 404,
        body: { detail: 'No cached GGUF variants available while offline.' },
      },
    };
    const [model] = mergeLocalModels(local, catalog, variants);
    expect(model).toMatchObject({
      loaded: true,
      defaultQuant: 'Q5_K_M',
      quants: [{ quant: 'Q5_K_M', sizeBytes: null, filename: null }],
    });
    expect(model?.note).toMatch(/Only Q5_K_M is known/);
  });

  it('puts loaded models first and recognises image families by name', () => {
    const local = {
      models: [
        {
          id: 'b/Zeta-GGUF',
          model_id: 'b/Zeta-GGUF',
          model_format: 'gguf',
          task: null,
          partial: false,
        },
        {
          id: 'a/Alpha-GGUF',
          model_id: 'a/Alpha-GGUF',
          model_format: 'gguf',
          task: 'text-generation',
          partial: false,
        },
        {
          id: 'unsloth/Qwen-Image-2.1-GGUF',
          model_id: 'unsloth/Qwen-Image-2.1-GGUF',
          model_format: 'gguf',
          task: null,
          partial: false,
        },
      ],
    };
    const catalog = { data: [{ id: 'b/Zeta-GGUF', loaded: true }] };
    expect(mergeLocalModels(local, catalog, {}).map((m) => m.modelId)).toEqual([
      'b/Zeta-GGUF',
      'a/Alpha-GGUF',
    ]);
    expect(looksLikeDiffusionModel('unsloth/FLUX.2-klein-9B-GGUF')).toBe(true);
    expect(looksLikeDiffusionModel('unsloth/Wan2.2-TI2V-5B-GGUF')).toBe(true);
    expect(looksLikeDiffusionModel('unsloth/Qwen3.8-27B-GGUF')).toBe(false);
    expect(looksLikeDiffusionModel('lmstudio-community/gemma-4-12B-it-QAT-GGUF')).toBe(false);
  });

  it('survives bodies that are not what it expects', () => {
    expect(mergeLocalModels(null, null, {})).toEqual([]);
    expect(mergeLocalModels({ models: 'nope' }, { data: {} }, {})).toEqual([]);
  });
});

describe('availabilityOf', () => {
  const gguf: LocalModel = {
    loadId: 'unsloth/Gemma-GGUF',
    modelId: 'unsloth/Gemma-GGUF',
    displayName: 'Gemma-GGUF',
    source: 'hf_cache',
    format: 'gguf',
    loaded: false,
    quants: [{ quant: 'Q4_K_M', sizeBytes: 1, filename: 'g.gguf' }],
    defaultQuant: 'Q4_K_M',
    nativeContextLength: null,
    note: null,
  };
  const mlx: LocalModel = {
    ...gguf,
    loadId: 'mlx-community/Qwen-4bit',
    modelId: 'mlx-community/Qwen-4bit',
    format: 'mlx',
    quants: [],
    defaultQuant: null,
  };

  it('finds the same model and quant, ignoring case', () => {
    expect(availabilityOf([gguf], 'UNSLOTH/gemma-gguf', 'q4_k_m')).toMatchObject({
      state: 'ready',
      model: gguf,
    });
  });

  it('reports what is missing', () => {
    expect(availabilityOf([gguf], 'unsloth/Gemma-GGUF', 'Q8_0')).toMatchObject({
      state: 'no-quant',
      message: 'Q8_0 is not fully downloaded on this machine.',
    });
    expect(availabilityOf([gguf], 'other/Model', 'Q4_K_M').state).toBe('no-model');
    expect(availabilityOf(null, 'unsloth/Gemma-GGUF', 'Q4_K_M').state).toBe('unknown');
    expect(availabilityOf([gguf], 'unsloth/Gemma-GGUF', null).state).toBe('no-quant');
  });

  it('needs no quant for MLX and safetensors models', () => {
    expect(availabilityOf([mlx], 'mlx-community/Qwen-4bit', null).state).toBe('ready');
  });

  it('builds a load body with every setting, in the machine’s spelling of the quant', () => {
    const body = unslothLoadBody(
      gguf,
      'q4_k_m',
      { ...DEFAULT_LOAD_SETTINGS, contextLength: 8192, extraArgs: ['--top-k', '20'] },
      'duel-1',
    );
    expect(body).toEqual({
      model_path: 'unsloth/Gemma-GGUF',
      load_request_id: 'duel-1',
      gguf_variant: 'Q4_K_M',
      max_seq_length: 8192,
      reasoning_budget: -1,
      speculative_type: 'off',
      n_parallel: 1,
      cache_type_kv: null,
      llama_extra_args: ['--top-k', '20'],
      load_in_4bit: true,
      force_reload: false,
    });
    expect(unslothLoadBody(mlx, null, DEFAULT_LOAD_SETTINGS, 'duel-2').gguf_variant).toBeNull();
  });

  it('validates load requests', () => {
    const ok = loadRequestSchema.safeParse({
      machineIds: ['a'],
      modelId: 'x',
      quant: null,
      settings: DEFAULT_LOAD_SETTINGS,
    });
    expect(ok.success).toBe(true);
    const bad = loadRequestSchema.safeParse({
      machineIds: [],
      modelId: '',
      quant: null,
      settings: { ...DEFAULT_LOAD_SETTINGS, parallelSlots: 99 },
    });
    expect(bad.success).toBe(false);
    expect(splitArgs('  --top-k 20   --seed 1 ')).toEqual(['--top-k', '20', '--seed', '1']);
  });
});

describe('interpretLoadResponse', () => {
  it('reads a successful and an already-loaded answer', () => {
    expect(
      interpretLoadResponse(route(200, { status: 'loaded', memory_warning: null }), BASE),
    ).toEqual({ kind: 'loaded', alreadyLoaded: false, memoryWarning: null });
    expect(interpretLoadResponse(route(200, { status: 'already_loaded' }), BASE)).toMatchObject({
      alreadyLoaded: true,
    });
    expect(
      interpretLoadResponse(
        route(200, { status: 'loaded', memory_warning: 'Paging from disk.' }),
        BASE,
      ),
    ).toMatchObject({ memoryWarning: 'Paging from disk.' });
  });

  it('finds a failure hidden in a padded 200 answer', () => {
    const late = route(200, {
      _deferred_error: { status_code: 500, detail: 'Failed to load GGUF model: Big-GGUF' },
    });
    expect(interpretLoadResponse(late, BASE)).toEqual({
      kind: 'failed',
      status: 500,
      message: 'Failed to load GGUF model: Big-GGUF',
    });
    const cancelled = route(200, {
      _deferred_error: { status_code: 409, detail: 'Model load cancelled' },
    });
    expect(interpretLoadResponse(cancelled, BASE)).toEqual({ kind: 'cancelled' });
  });

  it('explains direct errors in plain words', () => {
    expect(interpretLoadResponse(route(409, { detail: 'Model load cancelled' }), BASE)).toEqual({
      kind: 'cancelled',
    });
    expect(
      interpretLoadResponse(route(400, { detail: 'Invalid model identifier: x' }), BASE),
    ).toMatchObject({ message: 'Invalid model identifier: x' });
    expect(
      interpretLoadResponse(route(409, { detail: { error: 'gpu_busy', message: 'busy' } }), BASE),
    ).toMatchObject({ message: expect.stringMatching(/GPU on that machine is busy/) });
    const invalid = route(422, {
      detail: [{ loc: ['body', 'n_parallel'], msg: 'Input should be less than or equal to 64' }],
    });
    expect(interpretLoadResponse(invalid, BASE)).toMatchObject({
      message:
        'Unsloth rejected the load settings. n_parallel: Input should be less than or equal to 64.',
    });
    const lost = route(null, null, { error: { code: 'ECONNRESET', message: 'socket hang up' } });
    expect(interpretLoadResponse(lost, BASE)).toMatchObject({
      kind: 'failed',
      message: expect.stringMatching(/cut off.*may still finish/),
    });
  });
});
