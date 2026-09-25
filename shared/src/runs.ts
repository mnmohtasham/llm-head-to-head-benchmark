import { CLOUD_INFO, type CloudProvider } from './cloud';
import { TEMPLATE_INFO } from './commands';
import { metricKind, metricsFor, type Better, type MetricKind, type MetricUnit } from './compare';
import { formatValue } from './format';
import { IMAGE_PRESETS } from './images';
import { PRESETS } from './presets';
import {
  audioSource,
  backendLabel,
  publicSession,
  speculativeOn,
  type SessionView,
  type StoredSession,
  type Workload,
} from './session';
import { runsOf, sessionStats, statisticWord, type Statistic } from './stats';

/**
 * One row per machine per race, for the Results tab: what the machine was, what it ran and how,
 * and its medians and averages over the counted rounds, the report's own numbers from `sessionStats`.
 */
export type DeviceRunState = 'done' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

export interface DeviceRun {
  /** `sessionId/machineId`. */
  key: string;
  sessionId: string;
  machineId: string;
  workload: Workload;
  kind: MetricKind;
  createdAt: string;
  /** `done` when every counted round finished, `partial` when some did. */
  state: DeviceRunState;
  error: string | null;
  rounds: number;
  roundsDone: number;
  machine: string;
  color: string;
  cloud: CloudProvider | null;
  /** The other machines in the race. */
  others: string[];

  gpu: string | null;
  /** Every GPU's memory added up; for integrated GPUs, the memory they may share. */
  gpuMemoryGb: number | null;
  memoryGb: number | null;
  /** The GPU platform Unsloth runs on: cuda, rocm, mlx and so on. */
  platform: string | null;
  os: string | null;
  studio: string | null;
  llamaCpp: string | null;

  model: string | null;
  quant: string | null;
  engine: string | null;
  contextLength: number | null;
  /** The KV cache type set at load, or MLX's KV bits; null for the default. */
  kvCache: string | null;
  /** -1 when Unsloth fits the layers itself. */
  gpuLayers: number | null;
  totalLayers: number | null;
  slots: number | null;
  speculative: string | null;
  gpuMemoryMode: string | null;
  /** True when a chat model's settings apply: a local text or throughput race. */
  chatModel: boolean;

  prompt: string | null;
  /** The full custom prompt, for search. */
  promptText: string | null;
  promptTokens: number | null;
  prefill: 'cold' | 'warm' | null;
  thinking: string | null;
  maxTokens: number | null;
  concurrency: number | null;
  /** The workload's settings in a few words, for transcription, image and command races. */
  settings: string | null;

  /** Medians over the counted rounds that finished, by metric key; `finish` is text. */
  metrics: Record<string, number | string | null>;
  /** Averages over the same rounds; `finish` is text, as in `metrics`. */
  means: Record<string, number | string | null>;
  /** Metrics this machine won in its race, past the noise gate. */
  wins: string[];
}

const PLATFORMS: Record<string, string> = {
  cuda: 'CUDA',
  rocm: 'ROCm',
  mlx: 'MLX',
  mps: 'Metal',
  metal: 'Metal',
  cpu: 'CPU',
  xpu: 'Intel XPU',
};

export function platformLabel(platform: string | null): string | null {
  return platform === null ? null : (PLATFORMS[platform.toLowerCase()] ?? platform);
}

/** "2× NVIDIA GeForce RTX 4090", or the names joined when they differ. */
function gpuName(gpus: Array<{ name: string }>): string | null {
  if (gpus.length === 0) return null;
  const names = [...new Set(gpus.map((g) => g.name))];
  if (names.length === 1)
    return gpus.length > 1 ? `${gpus.length}× ${names[0]}` : (names[0] ?? null);
  return gpus.map((g) => g.name).join(' + ');
}

const QUANT_IN_FILE = /(?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=\.gguf$|[-.])/i;

/** The quant in a GGUF file name, such as `Q4_K_M` in `flux-2-klein-4b-Q4_K_M.gguf`. */
export function quantOfFile(file: string | null): string | null {
  if (!file) return null;
  return QUANT_IN_FILE.exec(file.split('/').pop() ?? file)?.[0] ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function counted(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => (count > 1 ? `${value} ×${count}` : value))
    .join(', ');
}

/** The rows of one race: one per machine, in the race's order. */
export function deviceRuns(session: StoredSession | SessionView): DeviceRun[] {
  const view = publicSession(session);
  const kind = metricKind(view);
  const stats = sessionStats(view);
  const text = view.workload === 'text' ? view.config : null;

  return view.machines.map((machine, i) => {
    const p = view.provenance[i] ?? null;
    const cloud = p?.cloud ?? null;
    const status = p?.statusBefore ?? null;
    const runs = runsOf(view, machine.id);
    const done = runs.filter((run) => run.state === 'done');
    const chatModel = text !== null && cloud === null;

    let model: string | null = null;
    let quant: string | null = null;
    let engine: string | null;
    let settings: string | null = null;
    if (view.workload === 'text') {
      model = cloud
        ? (cloud.model?.id ?? null)
        : (status?.activeModel ?? runs[0]?.modelBefore ?? null);
      quant = cloud ? null : (status?.quant ?? null);
      engine = cloud
        ? `${CLOUD_INFO[cloud.provider].label} API`
        : status?.backend
          ? backendLabel(status.backend)
          : null;
    } else if (view.workload === 'transcribe') {
      const stt = p?.sttAfter ?? null;
      model = stt?.loadedModel ?? view.config.model;
      const device = stt?.device ?? null;
      engine = `${stt?.loadedEngine ?? view.config.engine}${device ? ` on ${device}` : ''}`;
      settings = `${audioSource(view.config)}, ${view.config.language}`;
    } else if (view.workload === 'image') {
      const image = p?.imageAfter ?? null;
      model = image?.repoId ?? view.config.model;
      quant =
        quantOfFile(image?.ggufFilename ?? view.config.ggufFilename) ??
        image?.transformerQuant ??
        null;
      engine = image?.engine ? `${image.engine}${image.device ? ` on ${image.device}` : ''}` : null;
      const c = view.config;
      const preset = IMAGE_PRESETS.find((option) => option.id === c.preset)?.label ?? 'Custom';
      settings = `${preset}, ${c.width}×${c.height}, ${c.steps} steps, guidance ${c.guidance}, seed ${c.seed}`;
    } else {
      const c = view.config;
      engine = runs.find((run) => run.command?.encoder)?.command?.encoder ?? null;
      const quality =
        c.template === 'x265' ? `CRF ${c.crf}, ${c.x265Preset}` : `${c.bitrateMbps} Mb/s`;
      settings = `${TEMPLATE_INFO[c.template].label}, ${quality}, ${c.clip}`;
    }

    let thinking: string | null = null;
    if (text) {
      const effort = (e: unknown) => (typeof e === 'string' ? `, ${e}` : '');
      if (cloud) {
        const takes = cloud.model?.thinking ?? 'optional';
        thinking =
          takes === 'none'
            ? 'off'
            : takes === 'always' || text.thinking
              ? `on${effort(text.reasoningEffort)}`
              : 'off';
      } else if (p?.request) {
        thinking =
          p.request.enable_thinking === false ? 'off' : `on${effort(p.request.reasoning_effort)}`;
      }
    }

    const metrics: Record<string, number | string | null> = {};
    const means: Record<string, number | string | null> = {};
    const wins: string[] = [];
    for (const row of stats) {
      if (row.unit === 'text') {
        metrics[row.key] = counted(done.map((run) => run.client?.finishReason ?? run.state));
        means[row.key] = metrics[row.key] ?? null;
      } else {
        metrics[row.key] = row.summaries[i]?.median ?? null;
        means[row.key] = row.summaries[i]?.mean ?? null;
      }
      if (row.verdict.kind === 'win' && row.verdict.leader === i) wins.push(row.key);
    }

    const roundsDone = done.length;
    const rounds = view.rounds.length;
    const state: DeviceRunState =
      roundsDone > 0 && roundsDone === rounds
        ? 'done'
        : roundsDone > 0
          ? 'partial'
          : view.state === 'cancelled' || view.state === 'interrupted'
            ? view.state
            : 'failed';
    const kv = status?.cacheTypeKv ?? (status?.mlxKvBits ? `${status.mlxKvBits}-bit` : null);
    const preset = text ? PRESETS.find((option) => option.id === text.preset) : undefined;

    return {
      key: `${view.id}/${machine.id}`,
      sessionId: view.id,
      machineId: machine.id,
      workload: view.workload,
      kind,
      createdAt: view.createdAt,
      state,
      error: runs.find((run) => run.error)?.error ?? view.error ?? null,
      rounds,
      roundsDone,
      machine: machine.name,
      color: machine.color,
      cloud: cloud?.provider ?? null,
      others: view.machines.filter((m) => m.id !== machine.id).map((m) => m.name),

      gpu: cloud ? `${CLOUD_INFO[cloud.provider].label}, cloud` : gpuName(p?.gpus ?? []),
      gpuMemoryGb:
        p && p.gpus.some((g) => g.memoryGb !== null)
          ? Math.round(p.gpus.reduce((sum, g) => sum + (g.memoryGb ?? 0), 0) * 100) / 100
          : null,
      memoryGb: p?.platform.memoryTotalGb ?? null,
      platform: platformLabel(p?.platform.backend ?? null),
      os: p?.platform.os ?? null,
      studio: p?.versions.studio ?? p?.versions.unsloth ?? null,
      llamaCpp: p?.versions.llamaCpp ?? null,

      model,
      quant,
      engine,
      contextLength: cloud
        ? (cloud.model?.contextWindow ?? null)
        : chatModel
          ? (status?.contextLength ?? null)
          : null,
      kvCache: chatModel ? kv : null,
      gpuLayers: chatModel ? (status?.gpuLayers ?? null) : null,
      totalLayers: chatModel ? (status?.totalLayers ?? null) : null,
      slots: chatModel ? (status?.parallelSlots ?? null) : null,
      speculative:
        chatModel && status
          ? speculativeOn(status)
            ? [status.speculativeType, status.specDrafterKind].filter(Boolean).join(' · ')
            : 'off'
          : null,
      gpuMemoryMode: chatModel ? (status?.gpuMemoryMode ?? null) : null,
      chatModel,

      prompt: text
        ? text.preset === 'custom'
          ? `Custom: ${text.prompt.length > 48 ? `${text.prompt.slice(0, 48).trimEnd()}…` : text.prompt}`
          : (preset?.label ?? text.preset)
        : null,
      promptText: text ? text.prompt : null,
      promptTokens: median(
        done
          .map((run) => run.client?.promptTokens)
          .filter((v): v is number => typeof v === 'number'),
      ),
      prefill: text ? text.prefill : null,
      thinking,
      maxTokens: text ? text.maxTokens : null,
      concurrency: text && text.mode === 'throughput' ? text.concurrency : null,
      settings,

      metrics,
      means,
      wins,
    };
  });
}

/** A column of the Results table: the raw value to sort and export, and the text to show. */
export interface RunColumn {
  id: string;
  label: string;
  group: 'Race' | 'Machine' | 'Model' | 'Settings' | 'Result';
  value: (run: DeviceRun) => number | string | null;
  text: (run: DeviceRun) => string;
  numeric: boolean;
  /** Offered as a filter. */
  filter: boolean;
  /** Shown until the user picks columns. */
  initial: boolean;
  hint?: string;
  unit?: MetricUnit;
  better?: Better;
}

export type RunsView = MetricKind | 'all';

const EMPTY = '—';
const show = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? EMPTY : String(v);
const count = (n: number | null) => (n === null ? EMPTY : n.toLocaleString('en-US'));
const gb = (n: number | null) =>
  n === null ? EMPTY : `${n >= 100 ? Math.round(n) : Number(n.toFixed(1))} GB`;

/** A local time as YYYY-MM-DD HH:MM, which sorts and reads the same everywhere. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export const KIND_LABELS: Record<MetricKind, string> = {
  text: 'Text',
  throughput: 'Throughput',
  transcribe: 'Transcribe',
  image: 'Image',
  command: 'Command',
};

/** The one number that sums up a run of each kind, for the table of every kind. */
const HEADLINE: Record<MetricKind, string> = {
  text: 'decode',
  throughput: 'aggregate',
  transcribe: 'rtf',
  image: 'stepsPerSec',
  command: 'encodeFps',
};

/** Metrics shown until the user picks columns. */
const INITIAL_METRICS: Record<MetricKind, readonly string[]> = {
  text: ['firstAnswer', 'ttft', 'decode', 'decodeServer', 'prompt', 'endToEnd', 'tokensPerJoule'],
  throughput: ['aggregate', 'perRequest', 'ttftMedian', 'ttftP95', 'batchTime', 'tokensPerJoule'],
  transcribe: ['rtf', 'processing', 'wer', 'load', 'joulesPerMinute'],
  image: ['imageTime', 'stepsPerSec', 'firstStep', 'load', 'energyPerImage'],
  command: ['encodeTime', 'encodeFps', 'encodeSpeed', 'outputSize', 'energyPerEncode'],
};

const STATE_TEXT: Record<DeviceRunState, string> = {
  done: 'done',
  partial: 'partly failed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

/** A row's median or average of a metric. */
export function runMetric(
  run: DeviceRun,
  key: string,
  statistic: Statistic,
): number | string | null {
  return (statistic === 'mean' ? run.means : run.metrics)[key] ?? null;
}

/**
 * The columns for one kind of race, or for every kind at once, with each metric's median or
 * average.
 */
export function runColumns(view: RunsView, statistic: Statistic = 'median'): RunColumn[] {
  const summed = `${statisticWord(statistic).replace(/^./, (c) => c.toUpperCase())} over the counted rounds`;
  const chat = view === 'text' || view === 'throughput' || view === 'all';
  const columns: RunColumn[] = [
    {
      id: 'machine',
      label: 'Machine',
      group: 'Machine',
      value: (r) => r.machine,
      text: (r) => r.machine,
      numeric: false,
      filter: true,
      initial: true,
    },
    {
      id: 'date',
      label: 'Date',
      group: 'Race',
      value: (r) => r.createdAt,
      text: (r) => shortDate(r.createdAt),
      numeric: false,
      filter: false,
      initial: true,
    },
    ...(view === 'all'
      ? [
          {
            id: 'kind',
            label: 'Workload',
            group: 'Race',
            value: (r: DeviceRun) => KIND_LABELS[r.kind],
            text: (r: DeviceRun) => KIND_LABELS[r.kind],
            numeric: false,
            filter: true,
            initial: true,
          } satisfies RunColumn,
        ]
      : []),
    {
      id: 'rounds',
      label: 'Rounds',
      group: 'Race',
      value: (r) => r.roundsDone,
      text: (r) =>
        r.state === 'done'
          ? String(r.rounds)
          : `${r.roundsDone} of ${r.rounds}, ${STATE_TEXT[r.state]}`,
      numeric: true,
      filter: false,
      initial: true,
      hint: 'Counted rounds that finished on this machine',
    },
    {
      id: 'state',
      label: 'State',
      group: 'Race',
      value: (r) => STATE_TEXT[r.state],
      text: (r) => STATE_TEXT[r.state],
      numeric: false,
      filter: true,
      initial: false,
    },
    {
      id: 'others',
      label: 'Raced against',
      group: 'Race',
      value: (r) => r.others.join(', '),
      text: (r) => show(r.others.join(', ')),
      numeric: false,
      filter: false,
      initial: false,
    },
    {
      id: 'gpu',
      label: 'GPU',
      group: 'Machine',
      value: (r) => r.gpu,
      text: (r) => show(r.gpu),
      numeric: false,
      filter: true,
      initial: true,
    },
    {
      id: 'gpuMemory',
      label: 'GPU memory',
      group: 'Machine',
      value: (r) => r.gpuMemoryGb,
      text: (r) => gb(r.gpuMemoryGb),
      numeric: true,
      filter: true,
      initial: true,
      unit: 'GB',
      hint: 'VRAM, added up over the GPUs. Integrated GPUs report the memory they may share.',
    },
    {
      id: 'platform',
      label: 'GPU platform',
      group: 'Machine',
      value: (r) => r.platform,
      text: (r) => show(r.platform),
      numeric: false,
      filter: true,
      initial: true,
    },
    {
      id: 'memory',
      label: 'RAM',
      group: 'Machine',
      value: (r) => r.memoryGb,
      text: (r) => gb(r.memoryGb),
      numeric: true,
      filter: true,
      initial: false,
      unit: 'GB',
      hint: 'System memory; on Apple Silicon, shared with the GPU',
    },
    {
      id: 'os',
      label: 'System',
      group: 'Machine',
      value: (r) => r.os,
      text: (r) => show(r.os),
      numeric: false,
      filter: true,
      initial: false,
    },
    {
      id: 'studio',
      label: 'Unsloth Studio',
      group: 'Machine',
      value: (r) => r.studio,
      text: (r) => show(r.studio),
      numeric: false,
      filter: true,
      initial: false,
    },
    {
      id: 'llamaCpp',
      label: 'llama.cpp',
      group: 'Machine',
      value: (r) => r.llamaCpp,
      text: (r) => show(r.llamaCpp),
      numeric: false,
      filter: true,
      initial: false,
    },
    ...(view === 'command'
      ? []
      : [
          {
            id: 'model',
            label: 'Model',
            group: 'Model',
            value: (r: DeviceRun) => r.model,
            text: (r: DeviceRun) => show(r.model),
            numeric: false,
            filter: true,
            initial: true,
          } satisfies RunColumn,
        ]),
    ...(view === 'command' || view === 'transcribe'
      ? []
      : [
          {
            id: 'quant',
            label: 'Quant',
            group: 'Model',
            value: (r: DeviceRun) => r.quant,
            text: (r: DeviceRun) => show(r.quant),
            numeric: false,
            filter: true,
            initial: true,
          } satisfies RunColumn,
        ]),
    {
      id: 'engine',
      label: view === 'command' ? 'Encoder' : 'Engine',
      group: 'Model',
      value: (r) => r.engine,
      text: (r) => show(r.engine),
      numeric: false,
      filter: true,
      initial: true,
    },
    ...(chat
      ? ([
          {
            id: 'context',
            label: 'Context',
            group: 'Model',
            value: (r) => r.contextLength,
            text: (r) => count(r.contextLength),
            numeric: true,
            filter: true,
            initial: true,
            unit: 'tokens',
            hint: 'Context length the model was loaded with, in tokens; a cloud model’s context window',
          },
          {
            id: 'contextPerSlot',
            label: 'Context per slot',
            group: 'Model',
            value: (r) =>
              r.contextLength !== null && r.slots ? Math.floor(r.contextLength / r.slots) : null,
            text: (r) =>
              count(
                r.contextLength !== null && r.slots ? Math.floor(r.contextLength / r.slots) : null,
              ),
            numeric: true,
            filter: false,
            initial: false,
            unit: 'tokens',
            hint: 'llama.cpp splits the context between its slots',
          },
          {
            id: 'kvCache',
            label: 'KV cache',
            group: 'Model',
            value: (r) => (r.chatModel ? (r.kvCache ?? 'default') : null),
            text: (r) => (r.chatModel ? (r.kvCache ?? 'default') : EMPTY),
            numeric: false,
            filter: true,
            initial: true,
            hint: 'The KV cache type set at load. Unsloth does not report how much memory it takes.',
          },
          {
            id: 'gpuLayers',
            label: 'GPU layers',
            group: 'Model',
            value: (r) => r.gpuLayers,
            text: (r) =>
              r.gpuLayers === null
                ? EMPTY
                : r.gpuLayers < 0
                  ? r.totalLayers
                    ? `auto, ${r.totalLayers} layers`
                    : 'auto'
                  : r.totalLayers
                    ? `${r.gpuLayers} of ${r.totalLayers}`
                    : String(r.gpuLayers),
            numeric: true,
            filter: true,
            initial: true,
            hint: 'Auto means Unsloth fits the layers to the GPU itself and does not say how many landed there',
          },
          {
            id: 'slots',
            label: 'Slots',
            group: 'Model',
            value: (r) => r.slots,
            text: (r) => count(r.slots),
            numeric: true,
            filter: true,
            initial: true,
            hint: 'Requests the model serves at once',
          },
          {
            id: 'speculative',
            label: 'Speculative decoding',
            group: 'Model',
            value: (r) => r.speculative,
            text: (r) => show(r.speculative),
            numeric: false,
            filter: true,
            initial: true,
          },
          {
            id: 'gpuMemoryMode',
            label: 'GPU memory mode',
            group: 'Model',
            value: (r) => r.gpuMemoryMode,
            text: (r) => show(r.gpuMemoryMode),
            numeric: false,
            filter: true,
            initial: false,
          },
          {
            id: 'prompt',
            label: 'Prompt',
            group: 'Settings',
            value: (r) => r.prompt,
            text: (r) => show(r.prompt),
            numeric: false,
            filter: true,
            initial: true,
          },
          {
            id: 'promptTokens',
            label: 'Prompt tokens',
            group: 'Settings',
            value: (r) => r.promptTokens,
            text: (r) => count(r.promptTokens),
            numeric: true,
            filter: false,
            initial: true,
          },
          {
            id: 'prefill',
            label: 'Prefill',
            group: 'Settings',
            value: (r) => r.prefill,
            text: (r) => show(r.prefill),
            numeric: false,
            filter: true,
            initial: false,
          },
          {
            id: 'thinking',
            label: 'Thinking',
            group: 'Settings',
            value: (r) => r.thinking,
            text: (r) => show(r.thinking),
            numeric: false,
            filter: true,
            initial: true,
          },
          {
            id: 'maxTokens',
            label: 'Max tokens',
            group: 'Settings',
            value: (r) => r.maxTokens,
            text: (r) => count(r.maxTokens),
            numeric: true,
            filter: true,
            initial: false,
          },
        ] satisfies RunColumn[])
      : []),
    ...(view === 'throughput' || view === 'all'
      ? [
          {
            id: 'concurrency',
            label: 'Requests at once',
            group: 'Settings',
            value: (r: DeviceRun) => r.concurrency,
            text: (r: DeviceRun) => count(r.concurrency),
            numeric: true,
            filter: true,
            initial: view === 'throughput',
          } satisfies RunColumn,
        ]
      : []),
    ...(view === 'transcribe' || view === 'image' || view === 'command' || view === 'all'
      ? [
          {
            id: 'settings',
            label: 'Settings',
            group: 'Settings',
            value: (r: DeviceRun) => r.settings,
            text: (r: DeviceRun) => show(r.settings),
            numeric: false,
            filter: true,
            initial: view !== 'all',
          } satisfies RunColumn,
        ]
      : []),
  ];

  if (view === 'all') {
    columns.push({
      id: 'headline',
      label: 'Headline',
      group: 'Result',
      value: (r) => {
        const v = runMetric(r, HEADLINE[r.kind], statistic);
        return typeof v === 'number' ? v : null;
      },
      text: (r) => {
        const spec = metricsFor(r.kind).find((m) => m.key === HEADLINE[r.kind]);
        const v = runMetric(r, HEADLINE[r.kind], statistic);
        return spec && typeof v === 'number'
          ? `${formatValue(v, spec.unit)} ${spec.label.toLowerCase()}`
          : EMPTY;
      },
      numeric: true,
      filter: false,
      initial: true,
      hint: 'Decode speed for text, aggregate speed for throughput, real-time factor for transcription, denoising speed for images, frames per second for commands',
    });
  } else {
    const initial = INITIAL_METRICS[view];
    for (const spec of metricsFor(view)) {
      columns.push({
        id: `metric:${spec.key}`,
        label: spec.label,
        group: 'Result',
        value: (r) => runMetric(r, spec.key, statistic),
        text: (r) => {
          const v = runMetric(r, spec.key, statistic);
          return typeof v === 'number' ? formatValue(v, spec.unit) : show(v);
        },
        numeric: spec.unit !== 'text',
        filter: spec.unit === 'text',
        initial: initial.includes(spec.key),
        hint:
          spec.better === 'lower'
            ? `${summed}; lower is better`
            : spec.better === 'higher'
              ? `${summed}; higher is better`
              : summed,
        unit: spec.unit,
        better: spec.better,
      });
    }
  }
  columns.push({
    id: 'wins',
    label: 'Won in its race',
    group: 'Result',
    value: (r) => r.wins.length,
    text: (r) => {
      if (r.others.length === 0) return 'alone';
      const labels = metricsFor(r.kind)
        .filter((m) => r.wins.includes(m.key))
        .map((m) => m.label.toLowerCase());
      return labels.length === 0 ? 'nothing' : labels.join(', ');
    },
    numeric: true,
    filter: false,
    initial: false,
    hint: 'Metrics where this machine beat the others past the noise gate',
  });
  return columns;
}

/** The rows as CSV, with the columns' raw values: numbers stay numbers. */
export function runsCsv(runs: readonly DeviceRun[], columns: readonly RunColumn[]): string {
  const cell = (v: string | number | null) => {
    if (v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) =>
    cell(c.unit && c.unit !== 'text' ? `${c.label} (${c.unit})` : c.label),
  );
  const body = runs.map((r) => columns.map((c) => cell(c.value(r))).join(','));
  return `${[header.join(','), ...body].join('\n')}\n`;
}
