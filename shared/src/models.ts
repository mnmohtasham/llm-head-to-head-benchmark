import { z } from 'zod';
import { describeAddress } from './url';
import { detailOf, explainNetworkError, type RouteResult } from './probe';

/**
 * Model management against Unsloth Studio. Verified against a real Unsloth Studio 2026.9.11:
 * - `GET /api/models/local` lists what is on disk, with the identifier a load needs: a repo id
 *   for the Hugging Face cache, an opaque `ref:` handle for LM Studio and other folders.
 * - `GET /api/models/gguf-variants?repo_id=<that id>&offline=true` lists the quants on disk,
 *   without contacting Hugging Face. Partly downloaded quants are flagged `partial`.
 * - `GET /v1/models` says which model is loaded.
 * A load of files that are not on disk would start a download, so only complete quants are offered.
 */

export type ModelFormat = 'gguf' | 'mlx' | 'safetensors';

export interface QuantInfo {
  quant: string;
  sizeBytes: number | null;
  filename: string | null;
}

/** A model on one machine. `modelId` is the same on every machine; `loadId` is per machine. */
export interface LocalModel {
  loadId: string;
  modelId: string;
  displayName: string;
  source: string | null;
  format: ModelFormat;
  loaded: boolean;
  /** Complete quants on disk, GGUF only. */
  quants: QuantInfo[];
  defaultQuant: string | null;
  nativeContextLength: number | null;
  /** Why the quant list is short or missing, when it is. */
  note: string | null;
}

export const SPECULATIVE_TYPES = [
  'off',
  'auto',
  'mtp',
  'dspark',
  'dflash',
  'ngram',
  'mtp+ngram',
] as const;
export type SpeculativeType = (typeof SPECULATIVE_TYPES)[number];
export const SPECULATIVE_LABELS: Record<SpeculativeType, string> = {
  off: 'Off',
  auto: 'Auto',
  mtp: 'MTP',
  dspark: 'DSpark',
  dflash: 'DFlash',
  ngram: 'n-gram',
  'mtp+ngram': 'MTP + n-gram',
};

export const KV_CACHE_TYPES = [
  'f16',
  'bf16',
  'q8_0',
  'q4_0',
  'q4_1',
  'q5_0',
  'q5_1',
  'iq4_nl',
  'f32',
] as const;
export type KvCacheType = (typeof KV_CACHE_TYPES)[number];

export const MAX_CONTEXT_LENGTH = 1_048_576;

export const loadSettingsSchema = z.object({
  /** 0 lets Unsloth pick the context size. */
  contextLength: z
    .number()
    .int('Use a whole number of tokens.')
    .min(0, 'The context length cannot be negative.')
    .max(MAX_CONTEXT_LENGTH, 'Unsloth accepts at most 1,048,576 tokens.'),
  speculativeType: z.enum(SPECULATIVE_TYPES),
  /** -1 keeps the model's default, 0 turns thinking off where the model allows it. */
  reasoningBudget: z
    .number()
    .int('Use a whole number of tokens.')
    .min(-1, 'Use -1 for the model default.')
    .max(1_000_000, 'That budget is too large.'),
  parallelSlots: z
    .number()
    .int('Use a whole number.')
    .min(1, 'Use at least 1 slot.')
    .max(64, 'Unsloth allows at most 64 slots.'),
  /** null keeps Unsloth's default. */
  cacheTypeKv: z.enum(KV_CACHE_TYPES).nullable(),
  extraArgs: z.array(z.string().min(1).max(200)).max(40, 'Too many extra arguments.'),
});
export type LoadSettings = z.infer<typeof loadSettingsSchema>;

export const DEFAULT_LOAD_SETTINGS: LoadSettings = {
  contextLength: 0,
  speculativeType: 'off',
  reasoningBudget: -1,
  parallelSlots: 1,
  cacheTypeKv: null,
  extraArgs: [],
};

export const loadRequestSchema = z.object({
  machineIds: z.array(z.string().min(1)).min(1, 'Pick at least one machine.').max(16),
  modelId: z.string().trim().min(1, 'Pick a model.'),
  quant: z.string().trim().min(1).nullable(),
  settings: loadSettingsSchema,
});
export type LoadRequest = z.infer<typeof loadRequestSchema>;

/** Splits "--foo 1 --bar" into arguments, the way a shell would for simple cases. */
export function splitArgs(text: string): string[] {
  return text.split(/\s+/).filter((part) => part.length > 0);
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

const TEXT_TASKS = new Set([
  'text-generation',
  'image-text-to-text',
  'conversational',
  'text2text-generation',
]);

/**
 * Unsloth leaves `task` empty on some image models, for example Qwen-Image-2.1-GGUF, so known
 * diffusion families are recognised by name as well.
 */
export function looksLikeDiffusionModel(id: string): boolean {
  return /qwen-image|flux|(^|[/_-])wan[\d.]|stable-diffusion|sdxl|z-image|ltx-?(video|2)|hidream/i.test(
    id,
  );
}

function formatOf(entry: Json, id: string): ModelFormat {
  const declared = str(entry.model_format)?.toLowerCase();
  if (declared === 'gguf' || /gguf/i.test(id)) return 'gguf';
  if (declared === 'mlx' || /(^mlx-community\/|[-_]mlx([-_]|$))/i.test(id)) return 'mlx';
  return 'safetensors';
}

const SOURCE_RANK: Record<string, number> = {
  hf_cache: 0,
  lmstudio: 1,
  models_dir: 2,
  ollama: 3,
  hermes: 4,
  custom: 5,
};

/** One entry of `variants`: the answer of the offline gguf-variants route for a load id. */
export interface VariantsAnswer {
  status: number | null;
  body: unknown;
}

/**
 * Builds the list of text models a machine can load, from its local inventory, its catalog and
 * the offline quant listing of each GGUF model. Loaded models come first.
 */
export function mergeLocalModels(
  localBody: unknown,
  catalogBody: unknown,
  variants: Record<string, VariantsAnswer | undefined>,
): LocalModel[] {
  const catalog = list(obj(catalogBody)?.data)
    .map(obj)
    .filter((entry): entry is Json => entry !== null);
  const byModelId = new Map<string, { entry: Json; rank: number }>();

  for (const raw of list(obj(localBody)?.models)) {
    const entry = obj(raw);
    const loadId = str(entry?.id);
    if (!entry || !loadId || entry.partial === true) continue;
    const task = str(entry.task);
    if (task !== null && !TEXT_TASKS.has(task)) continue;
    const modelId = str(entry.model_id) ?? loadId;
    if (looksLikeDiffusionModel(modelId)) continue;
    const rank = SOURCE_RANK[str(entry.source) ?? 'custom'] ?? 9;
    const key = modelId.toLowerCase();
    const existing = byModelId.get(key);
    if (!existing || rank < existing.rank) byModelId.set(key, { entry, rank });
  }

  const models: LocalModel[] = [];
  for (const { entry } of byModelId.values()) {
    const loadId = str(entry.id) as string;
    const modelId = str(entry.model_id) ?? loadId;
    const format = formatOf(entry, modelId);
    const listed = catalog.find((c) => sameId(str(c.id), modelId));
    const model: LocalModel = {
      loadId,
      modelId,
      displayName: str(entry.display_name) ?? modelId,
      source: str(entry.source),
      format,
      loaded: listed?.loaded === true,
      quants: [],
      defaultQuant: null,
      nativeContextLength: null,
      note: null,
    };
    if (format === 'gguf') {
      const answer = variants[loadId];
      const body = answer?.status === 200 ? obj(answer.body) : null;
      if (body) {
        for (const v of list(body.variants).map(obj)) {
          const quant = str(v?.quant);
          if (!v || !quant || v.downloaded !== true || v.partial === true) continue;
          model.quants.push({ quant, sizeBytes: num(v.size_bytes), filename: str(v.filename) });
        }
        model.nativeContextLength = num(body.context_length);
        const preferred = str(body.default_variant);
        model.defaultQuant =
          model.quants.find((q) => sameId(q.quant, preferred))?.quant ??
          model.quants[0]?.quant ??
          null;
        if (model.quants.length === 0) model.note = 'No complete quant of this model is on disk.';
      } else {
        const fallback = str(listed?.quant);
        if (fallback) {
          model.quants.push({ quant: fallback, sizeBytes: null, filename: null });
          model.defaultQuant = fallback;
        }
        const why = answer ? detailOf(answer.body) || `HTTP ${answer.status}` : 'not asked';
        model.note = fallback
          ? `Only ${fallback} is known: the quant list could not be read (${why}).`
          : `The quant list could not be read (${why}).`;
      }
    }
    models.push(model);
  }
  return models.sort(
    (a, b) =>
      Number(b.loaded) - Number(a.loaded) ||
      a.modelId.localeCompare(b.modelId, undefined, { sensitivity: 'base' }),
  );
}

export type AvailabilityState = 'ready' | 'no-model' | 'no-quant' | 'unknown';
export interface Availability {
  state: AvailabilityState;
  model: LocalModel | null;
  message: string;
}

/** Whether a machine can load this model and quant from its own disk. */
export function availabilityOf(
  models: readonly LocalModel[] | null,
  modelId: string,
  quant: string | null,
): Availability {
  if (!models) {
    return { state: 'unknown', model: null, message: 'Its model list could not be read.' };
  }
  const model = models.find((m) => sameId(m.modelId, modelId)) ?? null;
  if (!model)
    return { state: 'no-model', model: null, message: 'This model is not on this machine.' };
  if (model.format === 'gguf') {
    if (!quant) return { state: 'no-quant', model, message: 'Pick a quant.' };
    if (!model.quants.some((q) => sameId(q.quant, quant))) {
      return {
        state: 'no-quant',
        model,
        message: `${quant} is not fully downloaded on this machine.`,
      };
    }
  }
  return { state: 'ready', model, message: 'Ready to load.' };
}

/** The quant name as this machine spells it, so the load names a file that exists. */
export function localQuantName(model: LocalModel, quant: string | null): string | null {
  if (model.format !== 'gguf' || !quant) return null;
  return model.quants.find((q) => sameId(q.quant, quant))?.quant ?? quant;
}

/** The body for `POST /api/inference/load`. Every setting is sent, so Unsloth defaults cannot differ. */
export function unslothLoadBody(
  model: LocalModel,
  quant: string | null,
  settings: LoadSettings,
  requestId: string,
): Record<string, unknown> {
  return {
    model_path: model.loadId,
    load_request_id: requestId,
    gguf_variant: localQuantName(model, quant),
    max_seq_length: settings.contextLength,
    reasoning_budget: settings.reasoningBudget,
    speculative_type: settings.speculativeType,
    n_parallel: settings.parallelSlots,
    cache_type_kv: settings.cacheTypeKv,
    llama_extra_args: settings.extraArgs,
    load_in_4bit: true,
    force_reload: false,
  };
}

/** What `/api/inference/status` says about the loaded text model. */
export interface ModelStatus {
  activeModel: string | null;
  modelIdentifier: string | null;
  backend: 'gguf' | 'mlx' | 'other' | null;
  quant: string | null;
  contextLength: number | null;
  maxContextLength: number | null;
  nativeContextLength: number | null;
  requestedContextLength: number | null;
  supportsReasoning: boolean;
  reasoningStyle: string | null;
  reasoningAlwaysOn: boolean;
  /** Effort levels the model accepts; empty when it has none. */
  reasoningEffortLevels: string[];
  reasoningBudget: number | null;
  speculativeType: string | null;
  specDrafterKind: string | null;
  specFallbackReason: string | null;
  cacheTypeKv: string | null;
  mlxKvBits: number | null;
  gpuMemoryMode: string | null;
  /** -1 means Unsloth fits the layers itself; it does not say how many landed on the GPU. */
  gpuLayers: number | null;
  totalLayers: number | null;
  parallelSlots: number | null;
  memoryWarning: string | null;
  loading: string[];
  isVision: boolean;
}

export function normalizeStatus(body: unknown): ModelStatus {
  const b = obj(body) ?? {};
  const activeModel = str(b.active_model);
  const strings = (v: unknown) => list(v).filter((x): x is string => typeof x === 'string');
  return {
    activeModel,
    modelIdentifier: str(b.model_identifier) ?? activeModel,
    backend: activeModel
      ? b.is_gguf === true
        ? 'gguf'
        : b.is_mlx === true
          ? 'mlx'
          : 'other'
      : null,
    quant: str(b.gguf_variant),
    contextLength: num(b.context_length),
    maxContextLength: num(b.max_context_length),
    nativeContextLength: num(b.native_context_length),
    requestedContextLength: num(b.requested_context_length),
    supportsReasoning: b.supports_reasoning === true,
    reasoningStyle: str(b.reasoning_style),
    reasoningAlwaysOn: b.reasoning_always_on === true,
    reasoningEffortLevels: strings(b.reasoning_effort_levels),
    reasoningBudget: num(b.reasoning_budget),
    speculativeType: str(b.speculative_type),
    specDrafterKind: str(b.spec_drafter_kind),
    specFallbackReason: str(b.spec_fallback_reason),
    cacheTypeKv: str(b.cache_type_kv),
    mlxKvBits: num(b.mlx_kv_bits),
    gpuMemoryMode: str(b.gpu_memory_mode),
    gpuLayers: num(b.gpu_layers),
    totalLayers: num(b.n_layers),
    parallelSlots: num(b.parallel_slots),
    memoryWarning: str(b.memory_warning),
    loading: strings(b.loading),
    isVision: b.is_vision === true,
  };
}

export interface LoadProgress {
  phase: string | null;
  bytesLoaded: number;
  bytesTotal: number;
  fraction: number;
}

export function normalizeLoadProgress(body: unknown): LoadProgress | null {
  const b = obj(body);
  if (!b) return null;
  const fraction = num(b.fraction) ?? 0;
  return {
    phase: str(b.phase),
    bytesLoaded: num(b.bytes_loaded) ?? 0,
    bytesTotal: num(b.bytes_total) ?? 0,
    fraction: Math.min(1, Math.max(0, fraction)),
  };
}

export type LoadOutcome =
  | { kind: 'loaded'; alreadyLoaded: boolean; memoryWarning: string | null }
  | { kind: 'cancelled' }
  | { kind: 'failed'; status: number | null; message: string };

/** The detail of an Unsloth error: a string, a gpu_busy object, or a FastAPI validation list. */
function errorText(status: number | null, detail: unknown): string {
  if (typeof detail === 'string' && detail) return detail;
  const d = obj(detail);
  if (d) {
    if (d.error === 'gpu_busy') {
      return 'The GPU on that machine is busy with a model another Unsloth account loaded.';
    }
    const message = str(d.message) ?? str(d.detail);
    if (message) return message;
  }
  if (Array.isArray(detail)) {
    const parts = detail
      .map(obj)
      .filter((x): x is Json => x !== null)
      .map((x) => {
        const where = list(x.loc)
          .filter((part) => part !== 'body')
          .join('.');
        return where ? `${where}: ${str(x.msg) ?? 'invalid'}` : (str(x.msg) ?? 'invalid');
      });
    if (parts.length > 0) return `Unsloth rejected the load settings. ${parts.join('; ')}.`;
  }
  return status !== null ? `Unsloth answered HTTP ${status}.` : 'Unsloth gave no answer.';
}

/**
 * Reads the answer of `POST /api/inference/load` or `/unload`. A call that runs past 15 seconds
 * is answered with 200 and space padding, and a late failure then arrives in the body as
 * `{"_deferred_error": {"status_code", "detail"}}`.
 */
export function interpretLoadResponse(route: RouteResult, baseUrl: string): LoadOutcome {
  if (route.error) {
    const { title } = explainNetworkError(route.error, baseUrl);
    return {
      kind: 'failed',
      status: null,
      message: `${title} The load may still finish on the machine. Refresh its status to see.`,
    };
  }
  const body = obj(route.body);
  const deferred = obj(body?._deferred_error);
  const status = deferred ? num(deferred.status_code) : route.status;
  if (status === 200 && body && !deferred) {
    return {
      kind: 'loaded',
      alreadyLoaded: body.status === 'already_loaded',
      memoryWarning: str(body.memory_warning),
    };
  }
  const detail = deferred ? deferred.detail : (body?.detail ?? route.body);
  const message = errorText(status, detail);
  if (status === 409 && /load cancelled/i.test(message)) return { kind: 'cancelled' };
  return { kind: 'failed', status, message };
}

/** A plain sentence for a failed read of a machine's status or model list. */
export function describeRouteFailure(route: RouteResult, baseUrl: string): string {
  if (route.error) {
    const { title, hint } = explainNetworkError(route.error, baseUrl);
    return `${title} ${hint}`;
  }
  if (route.status === 401) {
    return `${describeAddress(baseUrl)} rejected the API key. Update it on the Machines screen.`;
  }
  if (route.status === 404) return `This Unsloth version has no ${route.path.split('?')[0]} route.`;
  const detail = detailOf(route.body);
  return `Unsloth answered HTTP ${route.status}${detail ? `: ${detail}` : ''}.`;
}

export type LoadJobState = 'loading' | 'cancelling' | 'loaded' | 'failed' | 'cancelled';

/** One load on one machine, as the controller tracks it. */
export interface LoadJob {
  id: string;
  machineId: string;
  modelId: string;
  displayName: string;
  format: ModelFormat;
  quant: string | null;
  settings: LoadSettings;
  state: LoadJobState;
  startedAt: string;
  finishedAt: string | null;
  /** From the load request to its answer, measured on the controller. */
  durationMs: number | null;
  progress: LoadProgress | null;
  alreadyLoaded: boolean;
  memoryWarning: string | null;
  error: string | null;
}

export function isActiveJob(job: LoadJob | null | undefined): boolean {
  return job?.state === 'loading' || job?.state === 'cancelling';
}

export interface MachineModelsView {
  machineId: string;
  models: LocalModel[] | null;
  fetchedAt: string | null;
  error: string | null;
}

export interface MachineStatusView {
  machineId: string;
  status: ModelStatus | null;
  error: string | null;
  job: LoadJob | null;
  checkedAt: string;
}

export interface LoadStartResult {
  machineId: string;
  started: boolean;
  job: LoadJob | null;
  reason: string | null;
}
