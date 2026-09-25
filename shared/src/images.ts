import { z } from 'zod';
import type { StepSample } from './imagesteps';

export const IMAGE_MEMORY_MODES = ['auto', 'fast', 'balanced', 'low_vram'] as const;
export const IMAGE_SPEED_MODES = ['off', 'eager', 'default', 'max'] as const;
export type ImageSpeedMode = (typeof IMAGE_SPEED_MODES)[number];

export const IMAGE_PRESET_IDS = ['lighthouse', 'market', 'portrait', 'custom'] as const;
export type ImagePresetId = (typeof IMAGE_PRESET_IDS)[number];

export const IMAGE_PRESETS: ReadonlyArray<{ id: ImagePresetId; label: string; prompt: string }> = [
  {
    id: 'lighthouse',
    label: 'Lighthouse',
    prompt:
      'A red and white lighthouse on a rocky cliff at golden hour, waves breaking below, seagulls in a clear sky, photorealistic, 35 mm photograph',
  },
  {
    id: 'market',
    label: 'Night market',
    prompt:
      'A busy night market street in the rain, paper lanterns, neon signs reflected in puddles, steam rising from food stalls, cinematic lighting',
  },
  {
    id: 'portrait',
    label: 'Portrait',
    prompt:
      'Studio portrait of an elderly clockmaker at his workbench, soft window light, detailed hands holding a pocket watch, shallow depth of field',
  },
  { id: 'custom', label: 'Custom', prompt: '' },
];

/** The largest seed Unsloth takes: 2^53 - 1. */
export const MAX_IMAGE_SEED = Number.MAX_SAFE_INTEGER;

const side = (name: string) =>
  z
    .number()
    .int(`Use a whole number for the ${name}.`)
    .min(256, `The ${name} must be at least 256 pixels.`)
    .max(2048, `The ${name} can be at most 2,048 pixels.`)
    .refine((v) => v % 16 === 0, `The ${name} must be a multiple of 16.`);

export const imageConfigSchema = z
  .object({
    /** The repo on every machine, for example `unsloth/FLUX.2-klein-9B-GGUF`. */
    model: z
      .string()
      .trim()
      .min(1, 'Pick an image model.')
      .max(300)
      .regex(/^[\w.-]+\/[\w.-]+$/, 'Use a Hugging Face owner/model id.'),
    /** The GGUF file inside the repo; null loads the repo as a diffusers pipeline. */
    ggufFilename: z
      .string()
      .trim()
      .max(300)
      .regex(/^[\w./-]+\.(gguf|safetensors)$/i, 'Pick a .gguf file.')
      .nullable(),
    preset: z.enum(IMAGE_PRESET_IDS).default('lighthouse'),
    /** Required for a custom prompt; a preset sends its own. */
    prompt: z.string().trim().max(4000).default(''),
    negativePrompt: z.string().trim().max(4000).default(''),
    width: side('width').default(1024),
    height: side('height').default(1024),
    steps: z.number().int('Use a whole number of steps.').min(1).max(100).default(9),
    guidance: z.number().min(0).max(20).default(0),
    seed: z
      .number()
      .int('Use a whole number seed.')
      .min(0, 'The seed cannot be negative.')
      .max(MAX_IMAGE_SEED, 'That seed is too large.')
      .default(42),
    memoryMode: z.enum(IMAGE_MEMORY_MODES).default('auto'),
    /** `off` is the bit-identical baseline; the others compile and must match on every machine. */
    speedMode: z.enum(IMAGE_SPEED_MODES).default('off'),
    /** Load the chat model each machine had before, once the race is over. */
    restoreText: z.boolean().default(true),
  })
  .refine((c) => c.preset !== 'custom' || c.prompt.length > 0, {
    message: 'Write a prompt.',
    path: ['prompt'],
  });
export type ImageConfig = z.infer<typeof imageConfigSchema>;

/** The prompt a preset sends; custom sends the config's own. */
export function imagePrompt(config: Pick<ImageConfig, 'preset' | 'prompt'>): string {
  if (config.preset === 'custom') return config.prompt;
  return IMAGE_PRESETS.find((p) => p.id === config.preset)?.prompt ?? config.prompt;
}

/** One entry of `resolved` in the image status: what Unsloth did with a setting and why. */
export interface ResolvedSetting {
  value: string | number | boolean | null;
  requested: string | number | boolean | null;
  source: string | null;
  status: string | null;
  reason: string | null;
}

/** What `GET /api/inference/images/status` says, reduced to what a race needs. */
export interface ImageStatus {
  loaded: boolean;
  /** False when another account's model holds the machine. */
  yours: boolean;
  repoId: string | null;
  family: string | null;
  device: string | null;
  dtype: string | null;
  modelKind: string | null;
  ggufFilename: string | null;
  ggufVariant: string | null;
  engine: string | null;
  nativeMode: string | null;
  fallbackReason: string | null;
  memoryMode: string | null;
  /** The effective speed mode, and the optimisations that actually engaged. */
  speedMode: string | null;
  speedOptims: string[];
  offloadPolicy: string | null;
  transformerQuant: string | null;
  textEncoderQuant: string | null;
  attentionBackend: string | null;
  transformerCache: string | null;
  cpuOffload: boolean;
  resolved: Record<string, ResolvedSetting> | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const scalar = (v: unknown): string | number | boolean | null =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;

export function normalizeImageStatus(body: unknown): ImageStatus {
  const b = obj(body) ?? {};
  const resolved = obj(b.resolved);
  return {
    loaded: b.loaded === true,
    yours: b.yours !== false,
    repoId: str(b.repo_id),
    family: str(b.family),
    device: str(b.device),
    dtype: str(b.dtype),
    modelKind: str(b.model_kind),
    ggufFilename: str(b.gguf_filename),
    ggufVariant: str(b.gguf_variant),
    engine: str(b.engine),
    nativeMode: str(b.native_mode),
    fallbackReason: str(b.fallback_reason),
    memoryMode: str(b.memory_mode),
    speedMode: str(b.speed_mode),
    speedOptims: Array.isArray(b.speed_optims)
      ? b.speed_optims.filter((x): x is string => typeof x === 'string')
      : [],
    offloadPolicy: str(b.offload_policy),
    transformerQuant: str(b.transformer_quant),
    textEncoderQuant: str(b.text_encoder_quant),
    attentionBackend: str(b.attention_backend),
    transformerCache: str(b.transformer_cache),
    cpuOffload: b.cpu_offload === true,
    resolved: resolved
      ? Object.fromEntries(
          Object.entries(resolved).map(([key, raw]) => {
            const r = obj(raw) ?? {};
            return [
              key,
              {
                value: scalar(r.value),
                requested: scalar(r.requested),
                source: str(r.source),
                status: str(r.status),
                reason: str(r.reason),
              },
            ];
          }),
        )
      : null,
  };
}

/** The settings that change speed or pixels, as one line per machine, for spotting differences. */
export function imageSettingsLine(s: ImageStatus): string {
  return [
    s.engine ?? 'unknown engine',
    s.device ?? 'unknown device',
    s.dtype ?? 'unknown precision',
    `speed ${s.speedMode ?? 'unknown'}`,
    s.transformerQuant ? `transformer ${s.transformerQuant}` : null,
    s.offloadPolicy && s.offloadPolicy !== 'none' ? `offload ${s.offloadPolicy}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Whether the resident model is the one a race asks for, so no load is needed. */
export function imageModelReady(
  s: ImageStatus,
  config: Pick<ImageConfig, 'model' | 'ggufFilename' | 'memoryMode' | 'speedMode'>,
): boolean {
  const same = (a: string | null, b: string | null) =>
    (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
  const file = (name: string | null) => name?.split('/').pop() ?? null;
  return (
    s.loaded &&
    s.yours &&
    same(s.repoId, config.model) &&
    same(file(s.ggufFilename), file(config.ggufFilename)) &&
    same(s.memoryMode, config.memoryMode) &&
    (config.speedMode !== 'off' || s.speedMode === 'off')
  );
}

/** What one machine did with one prompt. */
export interface ImageResult {
  /** The image's id in the machine's gallery, and the copy Model Duel keeps. */
  galleryId: string | null;
  stored: boolean;
  width: number | null;
  height: number | null;
  seed: number | null;
  steps: number;
  /** Time to load the model before the round, when it had to be loaded. */
  loadMs: number | null;
  /** Progress readings: ms since the request left, and the step reached. */
  timeline: StepSample[];
  /** The most steps progress reported; larger than `steps` when memory ran short and it split. */
  totalSteps: number;
  firstStepMs: number | null;
  lastStepMs: number | null;
  stepsPerSec: number | null;
  decodeTailMs: number | null;
  resolutionMs: number | null;
  /** From the request to the answer: the time for one image at batch size 1. */
  totalMs: number;
  /** The settings that served, read back after the image. */
  engine: string | null;
  device: string | null;
  dtype: string | null;
  speedMode: string | null;
}

/** Fields of the image request, sent the same to every machine. */
export function imageRequestBody(config: ImageConfig): Record<string, unknown> {
  return {
    prompt: imagePrompt(config),
    negative_prompt: config.negativePrompt || null,
    width: config.width,
    height: config.height,
    steps: config.steps,
    guidance: config.guidance,
    seed: config.seed,
    batch_size: 1,
  };
}

/** Fields of the load request. Every setting is sent, so defaults cannot differ between machines. */
export function imageLoadBody(config: ImageConfig): Record<string, unknown> {
  return {
    model_path: config.model,
    gguf_filename: config.ggufFilename,
    model_kind: config.ggufFilename ? 'gguf' : 'pipeline',
    memory_mode: config.memoryMode,
    speed_mode: config.speedMode,
  };
}

/** An image model on a machine's disk, with the GGUF files that are complete. */
export interface ImageModelView {
  repoId: string;
  displayName: string;
  /** `gguf` loads one of `files`; `pipeline` loads the repo as a diffusers pipeline. */
  format: 'gguf' | 'pipeline';
  files: Array<{ filename: string; quant: string | null; sizeBytes: number | null }>;
}

/**
 * Whether a local model makes still images from text. Unsloth leaves `task` empty on some, so
 * known families count by name; video models and edit-only models do not count.
 */
export function isImageModel(id: string, task: string | null): boolean {
  if (/edit|kontext|inpaint|wan[\d.]|ltx/i.test(id)) return false;
  if (task === 'text-to-image') return true;
  if (task !== null) return false;
  return /qwen-image|flux|stable-diffusion|sdxl|z-image|hidream|lumina|krea|hunyuanimage|ideogram/i.test(
    id,
  );
}
