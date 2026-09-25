/**
 * Hardware profiles for the fake Unsloth backend. The response shapes follow the Unsloth Studio
 * backend source (studio/backend, commit f9bffe2); the values are invented.
 */
export type ProfileName = 'mac-mlx' | 'linux-cuda';
export const PROFILE_NAMES: readonly ProfileName[] = ['mac-mlx', 'linux-cuda'];

export interface InventoryQuant {
  quant: string;
  sizeGb: number;
  downloaded: boolean;
  partial?: boolean;
}

export interface InventoryEntry {
  /** The id a load needs: a repo id, or a `ref:` handle for models outside the Hugging Face cache. */
  loadId: string;
  modelId: string;
  displayName: string;
  source: 'hf_cache' | 'lmstudio';
  format: 'gguf' | 'mlx' | null;
  task: string | null;
  partial?: boolean;
  nativeContext: number;
  nLayers: number;
  supportsReasoning: boolean;
  sizeGb: number;
  quants: InventoryQuant[];
}

export interface Profile {
  name: ProfileName;
  /** Extra delay added to every answer, so the two profiles differ in speed. */
  latencyMs: number;
  unslothVersion: string;
  studioVersion: string;
  llamaCpp: string;
  deviceType: 'mac' | 'linux';
  appleSilicon: boolean;
  backend: 'mlx' | 'cuda';
  platform: string;
  cpuLogical: number;
  cpuPhysical: number;
  cpuMhz: number;
  memoryTotalGb: number;
  gpu: {
    name: string;
    vramTotalGb: number;
    vramUsedGb: number;
    powerLimitW: number | null;
    idlePowerW: number;
    idleUtilPct: number;
    idleTempC: number;
    /** Board power while decoding, for telemetry that follows activity. */
    busyPowerW: number;
    /** Apple Silicon power is a delta between two reads, so the first read is null. */
    nullFirstPower: boolean;
  };
  torch: string;
  cuda: string | null;
  transformers: string;
  /** What is on disk, as `/api/models/local` and `gguf-variants` report it. */
  inventory: InventoryEntry[];
  /** The model loaded when the mock starts or is reset. */
  initialModel: { loadId: string; quant: string; contextLength: number };
  /** How long a load takes, unless the control route overrides it. */
  loadMs: number;
  /** Prompt processing before the first streamed token. */
  startupMs: number;
  /** Time per streamed token: 36 ms is about 28 tokens per second. */
  tokenMs: number;
  stt: { transformers: boolean; gguf: boolean; mtmd: boolean };
}

export const PROFILES: Record<ProfileName, Profile> = {
  'mac-mlx': {
    name: 'mac-mlx',
    latencyMs: 4,
    unslothVersion: '2026.9.2',
    studioVersion: '0.1.815-beta',
    llamaCpp: 'b9585',
    deviceType: 'mac',
    appleSilicon: true,
    backend: 'mlx',
    platform: 'macOS-15.6.1-arm64-arm-64bit',
    cpuLogical: 32,
    cpuPhysical: 32,
    cpuMhz: 4056,
    memoryTotalGb: 512,
    gpu: {
      name: 'Apple M3 Ultra',
      vramTotalGb: 512,
      vramUsedGb: 39.1,
      powerLimitW: null,
      idlePowerW: 0.4,
      idleUtilPct: 2,
      idleTempC: 35,
      busyPowerW: 62,
      nullFirstPower: true,
    },
    torch: '2.9.0',
    cuda: null,
    transformers: '4.57.1',
    inventory: [
      {
        loadId: 'unsloth/Qwen3.8-27B-GGUF',
        modelId: 'unsloth/Qwen3.8-27B-GGUF',
        displayName: 'Qwen3.8-27B-GGUF',
        source: 'hf_cache',
        format: 'gguf',
        task: 'text-generation',
        nativeContext: 262144,
        nLayers: 64,
        supportsReasoning: true,
        sizeGb: 16.4,
        quants: [
          { quant: 'Q4_K_M', sizeGb: 16.4, downloaded: true },
          { quant: 'UD-Q8_K_XL', sizeGb: 31.2, downloaded: false, partial: true },
        ],
      },
      {
        loadId: 'unsloth/gemma-4-12b-it-GGUF',
        modelId: 'unsloth/gemma-4-12b-it-GGUF',
        displayName: 'gemma-4-12b-it-GGUF',
        source: 'hf_cache',
        format: 'gguf',
        task: null,
        nativeContext: 131072,
        nLayers: 48,
        supportsReasoning: false,
        sizeGb: 7.3,
        quants: [
          { quant: 'Q4_K_M', sizeGb: 7.3, downloaded: true },
          { quant: 'Q8_0', sizeGb: 12.7, downloaded: true },
        ],
      },
      {
        loadId: 'ref:4f1e0c2d9a8b7c6d5e4f3a2b1c0d9e8f',
        modelId: 'lmstudio-community/Qwen3.8-8B-GGUF',
        displayName: 'Qwen3.8-8B-GGUF',
        source: 'lmstudio',
        format: 'gguf',
        task: 'text-generation',
        nativeContext: 131072,
        nLayers: 36,
        supportsReasoning: true,
        sizeGb: 5,
        quants: [{ quant: 'Q4_K_M', sizeGb: 5, downloaded: true }],
      },
      {
        loadId: 'mlx-community/Qwen3.8-27B-4bit',
        modelId: 'mlx-community/Qwen3.8-27B-4bit',
        displayName: 'Qwen3.8-27B-4bit',
        source: 'hf_cache',
        format: 'mlx',
        task: 'text-generation',
        nativeContext: 262144,
        nLayers: 64,
        supportsReasoning: true,
        sizeGb: 15.2,
        quants: [],
      },
      {
        loadId: 'unsloth/FLUX.2-klein-9B-GGUF',
        modelId: 'unsloth/FLUX.2-klein-9B-GGUF',
        displayName: 'FLUX.2-klein-9B-GGUF',
        source: 'hf_cache',
        format: 'gguf',
        task: 'text-to-image',
        nativeContext: 0,
        nLayers: 0,
        supportsReasoning: false,
        sizeGb: 5.6,
        quants: [{ quant: 'Q4_K_M', sizeGb: 5.6, downloaded: true }],
      },
    ],
    initialModel: { loadId: 'unsloth/Qwen3.8-27B-GGUF', quant: 'Q4_K_M', contextLength: 32768 },
    loadMs: 2500,
    startupMs: 380,
    tokenMs: 36,
    stt: { transformers: true, gguf: false, mtmd: true },
  },
  'linux-cuda': {
    name: 'linux-cuda',
    latencyMs: 1,
    unslothVersion: '2026.9.2',
    studioVersion: '0.1.815-beta',
    llamaCpp: 'b9601',
    deviceType: 'linux',
    appleSilicon: false,
    backend: 'cuda',
    platform: 'Linux-6.17.0-41-generic-x86_64-with-glibc2.42',
    cpuLogical: 32,
    cpuPhysical: 16,
    cpuMhz: 5700,
    memoryTotalGb: 125.6,
    gpu: {
      name: 'NVIDIA GeForce RTX 5090',
      vramTotalGb: 31.84,
      vramUsedGb: 18.2,
      powerLimitW: 575,
      idlePowerW: 31.5,
      idleUtilPct: 3,
      idleTempC: 38,
      busyPowerW: 430,
      nullFirstPower: false,
    },
    torch: '2.9.0+cu130',
    cuda: '13.0',
    transformers: '4.57.1',
    inventory: [
      {
        loadId: 'unsloth/Qwen3.8-27B-GGUF',
        modelId: 'unsloth/Qwen3.8-27B-GGUF',
        displayName: 'Qwen3.8-27B-GGUF',
        source: 'hf_cache',
        format: 'gguf',
        task: 'text-generation',
        nativeContext: 262144,
        nLayers: 64,
        supportsReasoning: true,
        sizeGb: 16.4,
        quants: [
          { quant: 'Q4_K_M', sizeGb: 16.4, downloaded: true },
          { quant: 'UD-IQ2_XXS', sizeGb: 7.3, downloaded: true },
        ],
      },
      {
        loadId: 'unsloth/gemma-4-12b-it-GGUF',
        modelId: 'unsloth/gemma-4-12b-it-GGUF',
        displayName: 'gemma-4-12b-it-GGUF',
        source: 'hf_cache',
        format: 'gguf',
        task: null,
        nativeContext: 131072,
        nLayers: 48,
        supportsReasoning: false,
        sizeGb: 7.3,
        quants: [{ quant: 'Q4_K_M', sizeGb: 7.3, downloaded: true }],
      },
      {
        loadId: 'unsloth/Qwen3.8-8B-GGUF',
        modelId: 'unsloth/Qwen3.8-8B-GGUF',
        displayName: 'Qwen3.8-8B-GGUF',
        source: 'hf_cache',
        format: 'gguf',
        task: 'text-generation',
        nativeContext: 131072,
        nLayers: 36,
        supportsReasoning: true,
        sizeGb: 5,
        quants: [
          { quant: 'Q4_K_M', sizeGb: 5, downloaded: true },
          { quant: 'Q8_0', sizeGb: 8.7, downloaded: false, partial: true },
        ],
      },
      {
        loadId: 'unsloth/gemma-4-E4B-it-unsloth-bnb-4bit',
        modelId: 'unsloth/gemma-4-E4B-it-unsloth-bnb-4bit',
        displayName: 'gemma-4-E4B-it-unsloth-bnb-4bit',
        source: 'hf_cache',
        format: null,
        task: null,
        nativeContext: 131072,
        nLayers: 42,
        supportsReasoning: false,
        sizeGb: 5.1,
        quants: [],
      },
      {
        loadId: 'unsloth/Qwen-Image-2.1-GGUF',
        modelId: 'unsloth/Qwen-Image-2.1-GGUF',
        displayName: 'Qwen-Image-2.1-GGUF',
        source: 'hf_cache',
        format: 'gguf',
        task: null,
        nativeContext: 0,
        nLayers: 0,
        supportsReasoning: false,
        sizeGb: 4.2,
        quants: [{ quant: 'Q4_K_M', sizeGb: 4.2, downloaded: true }],
      },
      {
        loadId: 'unsloth/gemma-4-12B-it-qat-GGUF',
        modelId: 'unsloth/gemma-4-12B-it-qat-GGUF',
        displayName: 'gemma-4-12B-it-qat-GGUF',
        source: 'hf_cache',
        format: null,
        task: null,
        partial: true,
        nativeContext: 131072,
        nLayers: 48,
        supportsReasoning: false,
        sizeGb: 7.1,
        quants: [{ quant: 'Q4_0', sizeGb: 7.1, downloaded: false, partial: true }],
      },
    ],
    initialModel: { loadId: 'unsloth/Qwen3.8-27B-GGUF', quant: 'Q4_K_M', contextLength: 32768 },
    loadMs: 1600,
    startupMs: 200,
    tokenMs: 23,
    stt: { transformers: true, gguf: true, mtmd: true },
  },
};

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const jitter = (value: number, spread: number) => value + (Math.random() - 0.5) * 2 * spread;

/** The model the fake Unsloth has in memory, with the settings it was loaded with. */
export interface LoadedModel {
  entry: InventoryEntry;
  quant: string | null;
  contextLength: number;
  requestedContextLength: number;
  speculativeType: string | null;
  cacheTypeKv: string | null;
  parallelSlots: number | null;
  reasoningBudget: number;
  memoryWarning: string | null;
}

export interface PendingLoad {
  requestId: string | null;
  entry: InventoryEntry;
  quant: string | null;
  startedAt: number;
  durationMs: number;
  bytesTotal: number;
}

export interface ProfileState {
  studioRootId: string;
  port: number;
  telemetryReads: number;
  /** Chat streams running now. */
  activeStreams: number;
  /** 0 when idle, 1 when busy; follows the streams gradually, as real sensors lag. */
  activity: number;
  loaded: LoadedModel | null;
  pending: PendingLoad | null;
}

export function findEntry(p: Profile, id: string): InventoryEntry | undefined {
  const lower = id.toLowerCase();
  return p.inventory.find(
    (e) =>
      !e.partial &&
      (e.loadId.toLowerCase() === lower ||
        (e.source === 'hf_cache' && e.modelId.toLowerCase() === lower)),
  );
}

export function initialLoaded(p: Profile): LoadedModel | null {
  const entry = findEntry(p, p.initialModel.loadId);
  if (!entry) return null;
  return {
    entry,
    quant: p.initialModel.quant,
    contextLength: p.initialModel.contextLength,
    requestedContextLength: p.initialModel.contextLength,
    speculativeType: 'off',
    cacheTypeKv: 'f16',
    parallelSlots: 1,
    reasoningBudget: -1,
    memoryWarning: null,
  };
}

function localTimestamp(): string {
  return new Date().toISOString().replace('Z', '');
}

export function healthBody(p: Profile, s: ProfileState, authed: boolean): Record<string, unknown> {
  const base = {
    status: 'healthy',
    timestamp: localTimestamp(),
    service: 'Unsloth UI Backend',
    chat_only: false,
    desktop_protocol_version: 1,
    desktop_manageability_version: 2,
    supports_desktop_auth: true,
    supports_desktop_backend_ownership: true,
    studio_root_id: s.studioRootId,
    native_path_leases_supported: true,
    hf_endpoint: 'https://huggingface.co',
    hf_datasets_server: 'https://datasets-server.huggingface.co',
  };
  if (!authed) return base;
  return {
    ...base,
    version: p.unslothVersion,
    studio_version: p.studioVersion,
    cloudflare_url: null,
    server_url: `http://0.0.0.0:${s.port}`,
    secure: false,
    chat_only_reason: null,
    chat_only_detail: null,
    device_type: p.deviceType,
    apple_silicon: p.appleSilicon,
  };
}

function gpuDevice(p: Profile) {
  const used = round(jitter(p.gpu.vramUsedGb, 0.2), 2);
  return {
    index: 0,
    visible_ordinal: 0,
    name: p.gpu.name,
    memory_total_gb: p.gpu.vramTotalGb,
    vram_used_gb: used,
    vram_free_gb: round(p.gpu.vramTotalGb - used, 2),
    vram_utilization_pct: round((used / p.gpu.vramTotalGb) * 100),
  };
}

export function systemBody(p: Profile, s?: ProfileState): Record<string, unknown> {
  const gpu = {
    available: true,
    backend: p.backend,
    devices: [gpuDevice(p)],
    gguf_gpu_ids_supported: p.backend === 'cuda',
    vram_used_gb_aggregate: p.gpu.vramUsedGb,
  };
  const availableGb = round(p.memoryTotalGb * 0.82, 2);
  return {
    memory_refreshed: false,
    platform: p.platform,
    python_version: '3.12.11',
    device_backend: p.backend,
    cpu_count: p.cpuLogical,
    uptime_seconds: 86_400,
    cpu: {
      logical_count: p.cpuLogical,
      physical_count: p.cpuPhysical,
      usage_percent: round(jitter(6 + 22 * (s?.activity ?? 0), 2)),
      frequency_mhz: p.cpuMhz,
    },
    memory: {
      total_gb: p.memoryTotalGb,
      available_gb: availableGb,
      percent_used: round(100 - (availableGb / p.memoryTotalGb) * 100),
      process_used_mb: 812,
    },
    disk: { total_gb: 4000.79, free_gb: 1820.4, percent_used: 54.5 },
    gpu,
    inference_gpu: gpu,
    ml_packages: { torch: p.torch, transformers: p.transformers },
  };
}

export function hardwareBody(p: Profile, includeDetails: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    gpu: {
      gpu_name: p.gpu.name,
      vram_total_gb: p.gpu.vramTotalGb,
      vram_free_gb: round(p.gpu.vramTotalGb - p.gpu.vramUsedGb, 2),
    },
    versions: {
      unsloth: p.unslothVersion,
      torch: p.torch,
      transformers: p.transformers,
      cuda: p.cuda,
      rocm: null,
    },
  };
  if (includeDetails) {
    body.gpus = [{ name: p.gpu.name, vram_total_gb: p.gpu.vramTotalGb }];
    body.llama_cpp = p.llamaCpp;
  }
  return body;
}

const NO_MODEL_STATUS = {
  is_vision: false,
  is_diffusion: false,
  is_audio: false,
  audio_type: null,
  has_audio_input: false,
  has_video_input: false,
  context_length: null,
  max_context_length: null,
  native_context_length: null,
  context_length_enforced: null,
  supports_reasoning: false,
  reasoning_style: 'enable_thinking',
  reasoning_effort_levels: [],
  reasoning_always_on: false,
  reasoning_budget: -1,
  requested_reasoning_budget: -1,
  supports_tools: false,
  cache_type_kv: null,
  is_mlx: false,
  mlx_kv_bits: null,
  speculative_type: null,
  spec_draft_n_max: null,
  gpu_memory_mode: 'auto',
  gpu_layers: -1,
  n_layers: null,
  parallel_slots: null,
  active_model: null,
  model_identifier: null,
  is_gguf: false,
  is_local_model: false,
  gguf_variant: null,
  memory_warning: null,
  loading: [] as string[],
  loaded: [] as string[],
  inference: null,
  requested_context_length: null,
  llama_cpp_supports_mtp: true,
  spec_drafter_kind: null,
  spec_fallback_reason: null,
};

export function statusBody(p: Profile, s: ProfileState): Record<string, unknown> {
  const base = {
    ...NO_MODEL_STATUS,
    loading: s.pending ? [s.pending.entry.loadId] : [],
    llama_cpp_prebuilt_stale: false,
    llama_cpp_installed_tag: p.llamaCpp,
    llama_cpp_latest_tag: p.llamaCpp,
  };
  const m = s.loaded;
  if (!m) return base;
  const gguf = m.entry.format === 'gguf';
  return {
    ...base,
    active_model: m.entry.modelId,
    model_identifier: m.entry.loadId,
    is_gguf: gguf,
    is_mlx: m.entry.format === 'mlx',
    is_local_model: m.entry.source !== 'hf_cache',
    gguf_variant: m.quant,
    loaded: [m.entry.loadId],
    inference: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0 },
    context_length: m.contextLength,
    max_context_length: Math.min(m.entry.nativeContext, 131072),
    native_context_length: m.entry.nativeContext,
    requested_context_length: m.requestedContextLength,
    supports_reasoning: m.entry.supportsReasoning,
    reasoning_budget: m.reasoningBudget,
    requested_reasoning_budget: m.reasoningBudget,
    cache_type_kv: gguf ? m.cacheTypeKv : null,
    speculative_type: gguf ? m.speculativeType : null,
    n_layers: m.entry.nLayers,
    parallel_slots: gguf ? m.parallelSlots : null,
    memory_warning: m.memoryWarning,
  };
}

function firstDownloadedQuant(entry: InventoryEntry): string | null {
  return entry.quants.find((q) => q.downloaded && !q.partial)?.quant ?? null;
}

export function modelsBody(p: Profile, s: ProfileState): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: p.inventory
      .filter((e) => !e.partial)
      .map((e) => {
        const loaded = s.loaded?.entry === e;
        const quant = loaded ? s.loaded?.quant : firstDownloadedQuant(e);
        return {
          id: e.modelId,
          object: 'model',
          created,
          owned_by: 'unsloth-studio',
          ...(e.task && e.task !== 'text-generation' ? { task: e.task } : {}),
          loaded,
          ...(e.format === 'gguf' && quant ? { quant } : {}),
          ...(loaded ? { context_length: s.loaded?.contextLength } : {}),
          display_name: e.displayName,
        };
      }),
  };
}

export function propsBody(p: Profile, s: ProfileState): Record<string, unknown> {
  const base = {
    endpoint_slots: false,
    endpoint_props: false,
    endpoint_metrics: false,
    build_info: `unsloth-studio/${p.studioVersion}`,
  };
  const m = s.loaded;
  if (!m || m.entry.format !== 'gguf') return base;
  return {
    ...base,
    default_generation_settings: { n_ctx: m.contextLength },
    total_slots: m.parallelSlots ?? 1,
    chat_template: '{%- for message in messages %}{{ message.content }}{%- endfor %}',
    model_path: m.entry.modelId,
  };
}

export function localModelsBody(p: Profile): Record<string, unknown> {
  const rows = p.inventory.flatMap((e) => {
    const row = {
      id: e.loadId,
      display_name: e.displayName,
      path: '',
      source: e.source,
      model_id: e.modelId,
      active_cache: e.source === 'hf_cache' ? true : null,
      partial: e.partial === true,
      model_format: e.format,
      updated_at: 1790281744,
      task: e.task,
      audio_type: null,
    };
    // A real Unsloth lists LM Studio models twice, once as lmstudio and once as custom.
    return e.source === 'lmstudio' ? [row, { ...row, source: 'custom' }] : [row];
  });
  return { models_dir: '', hf_cache_dir: '', lmstudio_dirs: [], hermes_dirs: [], models: rows };
}

/** The offline gguf-variants answer, or null for "No cached GGUF variants available while offline". */
export function variantsBody(p: Profile, repoId: string): Record<string, unknown> | null {
  const lower = repoId.toLowerCase();
  const entry = p.inventory.find(
    (e) => e.loadId.toLowerCase() === lower || e.modelId.toLowerCase() === lower,
  );
  if (!entry || entry.quants.length === 0 || entry.quants.every((q) => q.partial)) return null;
  const name = entry.displayName.replace(/-GGUF$/i, '');
  return {
    repo_id: repoId,
    variants: entry.quants.map((q) => ({
      filename: `${name}-${q.quant}.gguf`,
      quant: q.quant,
      display_label: null,
      size_bytes: Math.round(q.sizeGb * 1e9),
      download_size_bytes: Math.round(q.sizeGb * 1e9),
      pending_drafter_filename: null,
      pending_drafter_size_bytes: 0,
      downloaded: q.downloaded,
      update_available: false,
      partial: q.partial === true,
      cleanable: false,
    })),
    has_vision: false,
    default_variant: firstDownloadedQuant(entry),
    context_length: entry.nativeContext || null,
    resolved_locally: false,
    dependencies_resolved: false,
    loadable_variants: null,
    loadable: null,
  };
}

/** The answer of a successful load, shaped like Unsloth's LoadResponse. */
export function loadResponseBody(
  m: LoadedModel,
  status: 'loaded' | 'already_loaded',
): Record<string, unknown> {
  return {
    status,
    model: m.entry.loadId,
    display_name: m.entry.displayName,
    is_lora: false,
    is_gguf: m.entry.format === 'gguf',
    is_local_model: m.entry.source !== 'hf_cache',
    inference: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0 },
    memory_warning: m.memoryWarning,
    carveout_advice: null,
    context_length: m.contextLength,
    native_context_length: m.entry.nativeContext,
    supports_reasoning: m.entry.supportsReasoning,
    is_mlx: m.entry.format === 'mlx',
  };
}

export function imageStatusBody(): Record<string, unknown> {
  return {
    loaded: false,
    repo_id: null,
    family: null,
    base_repo: null,
    device: null,
    dtype: null,
    model_kind: null,
    gguf_filename: null,
    gguf_variant: null,
    cpu_offload: false,
    offload_policy: null,
    vae_tiling: false,
    memory_mode: null,
    speed_mode: null,
    speed_optims: [],
    text_encoder_quant: null,
    transformer_quant: null,
    attention_backend: null,
    transformer_cache: null,
    workflows: [],
    conditioning: null,
    engine: null,
    native_mode: null,
    fallback_reason: null,
    supports_lora: false,
    supports_controlnet: false,
  };
}

export function telemetryBody(p: Profile, s: ProfileState): Record<string, unknown> {
  s.telemetryReads += 1;
  const firstRead = s.telemetryReads === 1;
  // Readings move towards busy while a stream runs and back to idle after, over a few reads.
  s.activity += ((s.activeStreams > 0 ? 1 : 0) - s.activity) * 0.6;
  const a = s.activity;
  const used = round(jitter(p.gpu.vramUsedGb, 0.2), 2);
  const powerMean = p.gpu.idlePowerW + (p.gpu.busyPowerW - p.gpu.idlePowerW) * a;
  // Apple's first power reading is null: it needs two energy counters to make a rate.
  const power =
    p.gpu.nullFirstPower && firstRead ? null : round(jitter(powerMean, powerMean * 0.05));
  const device = {
    available: true,
    backend: p.backend,
    index: 0,
    visible_ordinal: 0,
    gpu_utilization_pct: Math.min(
      100,
      Math.max(0, Math.round(jitter(p.gpu.idleUtilPct + (96 - p.gpu.idleUtilPct) * a, 1))),
    ),
    temperature_c: Math.round(jitter(p.gpu.idleTempC + 28 * a, 1)),
    vram_used_gb: used,
    vram_total_gb: p.gpu.vramTotalGb,
    vram_utilization_pct: round((used / p.gpu.vramTotalGb) * 100),
    power_draw_w: power,
    power_limit_w: p.gpu.powerLimitW,
    power_utilization_pct:
      power !== null && p.gpu.powerLimitW ? round((power / p.gpu.powerLimitW) * 100) : null,
  };
  return { ...device, available: true, backend: p.backend, devices: [device] };
}
