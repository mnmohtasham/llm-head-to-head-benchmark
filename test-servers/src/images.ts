import { randomBytes } from 'node:crypto';
import type { Profile } from './profiles';
import { seededPng } from './png';

export interface ImageMockConfig {
  /** How long an image load takes; null uses the profile's time. */
  loadMs: number | null;
  /** Time per denoising step at 1024 by 1024; smaller images take proportionally less. */
  stepMs: number | null;
  /** The VAE decode after the last step. */
  decodeMs: number | null;
  /** The next load fails in the background with this message, as load-progress reports it. */
  failNextLoad: string | null;
}

export const DEFAULT_IMAGE: ImageMockConfig = {
  loadMs: null,
  stepMs: null,
  decodeMs: null,
  failNextLoad: null,
};

interface ImageProfile {
  engine: string;
  device: string;
  dtype: string;
  loadMs: number;
  stepMs: number;
  decodeMs: number;
}

const PROFILE_IMAGE: Record<Profile['name'], ImageProfile> = {
  'linux-cuda': {
    engine: 'diffusers',
    device: 'cuda',
    dtype: 'bfloat16',
    loadMs: 1500,
    stepMs: 140,
    decodeMs: 450,
  },
  'mac-mlx': {
    engine: 'diffusers',
    device: 'mps',
    dtype: 'bfloat16',
    loadMs: 2500,
    stepMs: 380,
    decodeMs: 1100,
  },
};

export interface ImageLoad {
  repoId: string;
  ggufFilename: string | null;
  memoryMode: string;
  speedMode: string;
}

export interface ImageState {
  loaded: ImageLoad | null;
  loading: (ImageLoad & { startedAt: number; durationMs: number; fails: string | null }) | null;
  loadError: string | null;
  /** The generation running now: when it started, its steps, and the phase it is in. */
  generating: {
    total: number;
    step: number;
    phase: 'steps' | 'decode' | 'save';
    cancel: () => void;
  } | null;
  /** A generate waits for the one before it, as Unsloth's lock does. */
  queue: Promise<void>;
  gallery: Map<string, { seed: number; width: number; height: number; png: Buffer | null }>;
}

export const newImageState = (): ImageState => ({
  loaded: null,
  loading: null,
  loadError: null,
  generating: null,
  queue: Promise.resolve(),
  gallery: new Map(),
});

export const imageTimes = (p: Profile, config: ImageMockConfig) => {
  const base = PROFILE_IMAGE[p.name];
  return {
    loadMs: config.loadMs ?? base.loadMs,
    stepMs: config.stepMs ?? base.stepMs,
    decodeMs: config.decodeMs ?? base.decodeMs,
  };
};

/** Finishes a load whose time is up, so status and progress read the same everywhere. */
export function settleLoad(state: ImageState): void {
  const loading = state.loading;
  if (!loading || Date.now() - loading.startedAt < loading.durationMs) return;
  state.loading = null;
  if (loading.fails) {
    state.loadError = loading.fails;
    return;
  }
  state.loaded = {
    repoId: loading.repoId,
    ggufFilename: loading.ggufFilename,
    memoryMode: loading.memoryMode,
    speedMode: loading.speedMode,
  };
}

export function imageStatusBody(p: Profile, state: ImageState): Record<string, unknown> {
  settleLoad(state);
  const base = PROFILE_IMAGE[p.name];
  const m = state.loaded;
  const speed = m?.speedMode ?? null;
  return {
    loaded: m !== null,
    repo_id: m?.repoId ?? null,
    family: m ? (/qwen-image/i.test(m.repoId) ? 'qwen-image-2.1' : 'flux.2-klein') : null,
    base_repo: m ? m.repoId.replace(/-GGUF$/i, '') : null,
    device: m ? base.device : null,
    dtype: m ? base.dtype : null,
    model_kind: m ? (m.ggufFilename ? 'gguf' : 'pipeline') : null,
    gguf_filename: m?.ggufFilename ?? null,
    gguf_variant: m?.ggufFilename?.match(/(Q\d\w*|BF16|F16)(?=\.gguf$)/i)?.[1] ?? null,
    cpu_offload: false,
    offload_policy: m ? 'none' : null,
    vae_tiling: false,
    memory_mode: m?.memoryMode ?? null,
    speed_mode: speed,
    speed_optims:
      speed && speed !== 'off' && base.device === 'cuda' ? ['channels_last', 'compiled'] : [],
    text_encoder_quant: null,
    transformer_quant: null,
    attention_backend: null,
    transformer_cache: null,
    workflows: m ? ['txt2img'] : [],
    conditioning: null,
    engine: base.engine,
    native_mode: null,
    fallback_reason: `GPU backend '${base.device}' uses diffusers`,
    supports_lora: false,
    supports_controlnet: false,
    resolved: m
      ? {
          speed_mode: {
            value: speed,
            requested: speed,
            source: 'explicit',
            status: 'applied',
            reason: null,
          },
          memory_mode: {
            value: 'none',
            requested: m.memoryMode,
            source: 'explicit',
            status: 'applied',
            reason: null,
          },
        }
      : null,
  };
}

export function loadProgressBody(state: ImageState): Record<string, unknown> {
  settleLoad(state);
  if (state.loading) {
    const fraction = Math.min(1, (Date.now() - state.loading.startedAt) / state.loading.durationMs);
    return {
      phase: 'finalizing',
      bytes_downloaded: 0,
      bytes_total: 0,
      fraction: Number(fraction.toFixed(3)),
      error: null,
    };
  }
  if (state.loadError) {
    return {
      phase: 'error',
      bytes_downloaded: 0,
      bytes_total: 0,
      fraction: 0,
      error: state.loadError,
    };
  }
  return {
    phase: state.loaded ? 'ready' : null,
    bytes_downloaded: 0,
    bytes_total: 0,
    fraction: state.loaded ? 1 : 0,
    error: null,
  };
}

export function progressBody(state: ImageState): Record<string, unknown> {
  const g = state.generating;
  if (!g) return { active: false, step: 0, total_steps: 0, fraction: 0, eta_seconds: null };
  // While the PNG is saved the engine's state is gone and the route reads 0 of 0.
  if (g.phase === 'save')
    return { active: true, step: 0, total_steps: 0, fraction: 0, eta_seconds: null };
  return {
    active: true,
    step: g.step,
    total_steps: g.total,
    fraction: g.total > 0 ? g.step / g.total : 0,
    eta_seconds: null,
  };
}

export function galleryRecord(
  id: string,
  body: Record<string, unknown>,
  seed: number,
  loaded: ImageLoad,
): Record<string, unknown> {
  return {
    id,
    url: `/api/inference/images/gallery/${id}/file`,
    prompt: body.prompt,
    negative_prompt: body.negative_prompt ?? null,
    width: body.width,
    height: body.height,
    steps: body.steps,
    guidance: body.guidance,
    seed,
    batch_seed: seed,
    batch_index: 0,
    batch_size: 1,
    model: loaded.repoId,
    model_kind: loaded.ggufFilename ? 'gguf' : 'pipeline',
    gguf_filename: loaded.ggufFilename,
    transformer_quant: null,
    text_encoder_quant: null,
    memory_mode: loaded.memoryMode,
    offload_policy: 'none',
    created_at: Date.now() / 1000,
    pinned: false,
    archived: false,
  };
}

export const newGalleryId = () => randomBytes(16).toString('hex');

/** The PNG for a gallery entry, painted on first request and kept. */
export function galleryPng(entry: {
  seed: number;
  width: number;
  height: number;
  png: Buffer | null;
}): Buffer {
  entry.png ??= seededPng(entry.seed, entry.width, entry.height);
  return entry.png;
}
