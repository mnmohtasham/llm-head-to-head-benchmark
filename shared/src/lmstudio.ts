import { withNonce } from './presets';
import type { ChatEvent, TextConfig } from './chat';
import type { ModelStatus } from './models';
import {
  median,
  formatMs,
  networkCategory,
  type Capability,
  type ProbeIssue,
  type ProbeRaw,
  type ProbeReport,
  type RouteResult,
} from './probe';
import type { SseMessage } from './sse';
import { describeAddress, loopbackHint } from './url';

/**
 * LM Studio as a second kind of local server, next to Unsloth Studio. Model Duel talks to its native
 * REST API (LM Studio 0.4 or newer): `GET /api/v1/models` for what is downloaded and loaded, and
 * `POST /api/v1/chat` for races, whose stream ends with LM Studio's own timings. Contracts as
 * documented at lmstudio.ai/docs/developer/rest and read from LM Studio 0.4.25 on 2026-09-26.
 */
export const LMSTUDIO_PORT = 1234;
export const MACHINE_SERVERS = ['unsloth', 'lmstudio'] as const;
export type MachineServer = (typeof MACHINE_SERVERS)[number];
export const SERVER_LABEL: Record<MachineServer, string> = {
  unsloth: 'Unsloth Studio',
  lmstudio: 'LM Studio',
};

/** One loaded copy of a model, with the settings it was loaded with. */
export interface LmInstance {
  id: string;
  contextLength: number | null;
  parallel: number | null;
  flashAttention: boolean | null;
  evalBatchSize: number | null;
  offloadKvToGpu: boolean | null;
}

/** A downloaded model, as LM Studio lists it. */
export interface LmModel {
  key: string;
  displayName: string;
  type: 'llm' | 'embedding' | string;
  format: 'gguf' | 'mlx' | string | null;
  quant: string | null;
  architecture: string | null;
  params: string | null;
  sizeBytes: number | null;
  maxContextLength: number | null;
  vision: boolean;
  /** The reasoning settings it accepts, such as off, low, medium, high, xhigh and on. */
  reasoningOptions: string[];
  reasoningDefault: string | null;
  loaded: LmInstance[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The models in `GET /api/v1/models`. */
export function parseLmModels(body: unknown): LmModel[] {
  return list(obj(body)?.models)
    .map((entry): LmModel | null => {
      const e = obj(entry);
      const key = str(e?.key);
      if (!e || !key) return null;
      const reasoning = obj(obj(e.capabilities)?.reasoning);
      return {
        key,
        displayName: str(e.display_name) ?? key,
        type: str(e.type) ?? 'llm',
        format: str(e.format),
        quant: str(obj(e.quantization)?.name),
        architecture: str(e.architecture),
        params: str(e.params_string),
        sizeBytes: num(e.size_bytes),
        maxContextLength: num(e.max_context_length),
        vision: obj(e.capabilities)?.vision === true,
        reasoningOptions: list(reasoning?.allowed_options).filter(
          (o): o is string => typeof o === 'string',
        ),
        reasoningDefault: str(reasoning?.default),
        loaded: list(e.loaded_instances)
          .map((instance): LmInstance | null => {
            const i = obj(instance);
            const id = str(i?.id);
            if (!i || !id) return null;
            const c = obj(i.config);
            return {
              id,
              contextLength: num(c?.context_length),
              parallel: num(c?.parallel),
              flashAttention: bool(c?.flash_attention),
              evalBatchSize: num(c?.eval_batch_size),
              offloadKvToGpu: bool(c?.offload_kv_cache_to_gpu),
            };
          })
          .filter((i): i is LmInstance => i !== null),
      };
    })
    .filter((m): m is LmModel => m !== null);
}

/** What LM Studio says about its loaded model beyond Unsloth's status fields. */
export interface LmStatusDetails {
  /** The loaded copy the race asks for. */
  instanceId: string;
  displayName: string;
  params: string | null;
  architecture: string | null;
  flashAttention: boolean | null;
  offloadKvToGpu: boolean | null;
  evalBatchSize: number | null;
  reasoningOptions: string[];
  /** Other chat models, or copies, loaded at the same time. */
  otherLoaded: string[];
}

/** Effort levels Model Duel knows among LM Studio's reasoning options. */
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh'];

/**
 * LM Studio's loaded chat model in Unsloth's status shape, so pre-flight, the report and the
 * Results tab read both servers alike. What LM Studio does not report stays null. With several
 * chat models loaded, the first is the one raced and the others are named in `lmstudio.otherLoaded`.
 */
export function lmModelStatus(models: readonly LmModel[]): ModelStatus {
  const loaded = models.filter((m) => m.type === 'llm' && m.loaded.length > 0);
  const model = loaded[0] ?? null;
  const instance = model?.loaded[0] ?? null;
  const options = model?.reasoningOptions ?? [];
  return {
    activeModel: model?.key ?? null,
    modelIdentifier: instance?.id ?? null,
    backend: model
      ? model.format === 'mlx'
        ? 'mlx'
        : model.format === 'gguf'
          ? 'gguf'
          : 'other'
      : null,
    quant: model?.quant ?? null,
    contextLength: instance?.contextLength ?? null,
    maxContextLength: model?.maxContextLength ?? null,
    nativeContextLength: model?.maxContextLength ?? null,
    requestedContextLength: null,
    supportsReasoning: options.length > 0,
    reasoningStyle: options.length > 0 ? 'lmstudio' : null,
    reasoningAlwaysOn: options.length > 0 && !options.includes('off'),
    reasoningEffortLevels: options.filter((o) => EFFORT_OPTIONS.includes(o)),
    reasoningBudget: null,
    speculativeType: null,
    specDrafterKind: null,
    specFallbackReason: null,
    cacheTypeKv: null,
    mlxKvBits: null,
    gpuMemoryMode: null,
    gpuLayers: null,
    totalLayers: null,
    parallelSlots: instance?.parallel ?? null,
    memoryWarning: null,
    loading: [],
    isVision: model?.vision ?? false,
    server: 'lmstudio',
    lmstudio: model
      ? {
          instanceId: instance?.id ?? model.key,
          displayName: model.displayName,
          params: model.params,
          architecture: model.architecture,
          flashAttention: instance?.flashAttention ?? null,
          offloadKvToGpu: instance?.offloadKvToGpu ?? null,
          evalBatchSize: instance?.evalBatchSize ?? null,
          reasoningOptions: options,
          otherLoaded: [
            ...loaded.slice(1).map((m) => m.key),
            ...model.loaded.slice(1).map((i) => i.id),
          ],
        }
      : null,
  };
}

/** The reasoning setting to send: off, an effort, on, or nothing when the model has none. */
export function lmReasoning(
  options: readonly string[],
  thinking: boolean,
  effort: string | null,
): string | null {
  if (options.length === 0) return null;
  if (!thinking) return options.includes('off') ? 'off' : null;
  if (effort && options.includes(effort)) return effort;
  return options.includes('on') ? 'on' : null;
}

/**
 * The body of `POST /api/v1/chat` for one run. The chat is not stored. The same prompt as for
 * Unsloth, nonce line included; LM Studio takes no seed, so cold prefill relies on the nonce.
 */
export function lmChatBody(
  config: Pick<
    TextConfig,
    'prompt' | 'maxTokens' | 'thinking' | 'reasoningEffort' | 'prefill' | 'sampling'
  >,
  status: Pick<ModelStatus, 'activeModel' | 'lmstudio'>,
  nonce: string | null,
): Record<string, unknown> {
  const s = config.sampling;
  const reasoning = lmReasoning(
    status.lmstudio?.reasoningOptions ?? [],
    config.thinking,
    config.reasoningEffort,
  );
  return {
    model: status.lmstudio?.instanceId ?? status.activeModel ?? '',
    input: withNonce(config.prompt, config.prefill === 'cold' ? nonce : null),
    stream: true,
    store: false,
    max_output_tokens: config.maxTokens,
    temperature: s.temperature,
    top_p: s.topP,
    top_k: s.topK,
    min_p: s.minP,
    repeat_penalty: s.repetitionPenalty,
    ...(reasoning ? { reasoning } : {}),
  };
}

/** LM Studio's own account of a run, from the stream's last event. */
export interface LmStats {
  ttftMs: number | null;
  tokPerSec: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Set when LM Studio loaded the model for this request. */
  modelLoadMs: number | null;
}

/**
 * Reads the events of `POST /api/v1/chat` into Model Duel's chat events. LM Studio sends no stop
 * reason, so a run whose output reached Max tokens is taken to have stopped there.
 */
export class LmStreamReader {
  stats: LmStats | null = null;
  private finished = false;

  constructor(private readonly maxTokens: number) {}

  push(message: SseMessage): ChatEvent[] {
    if (message.kind === 'comment') return [{ type: 'keepalive' }];
    let data: Json | null;
    try {
      data = obj(JSON.parse(message.data));
    } catch {
      return [{ type: 'ignored', why: 'not JSON' }];
    }
    const type = str(data?.type) ?? '';
    if (type === 'reasoning.delta') {
      const text = str(data?.content);
      return text ? [{ type: 'reasoning', text }] : [];
    }
    if (type === 'message.delta') {
      const text = str(data?.content);
      return text ? [{ type: 'content', text }] : [];
    }
    if (type === 'model_load.start') {
      return [
        {
          type: 'error',
          message: `LM Studio started loading ${str(data?.model_instance_id) ?? 'the model'}, which was not loaded, so this run would time the load. Load the model in LM Studio first.`,
          code: 'model_load',
        },
      ];
    }
    if (type === 'error') {
      const error = obj(data?.error);
      return [
        {
          type: 'error',
          message: str(error?.message) ?? str(data?.error) ?? 'LM Studio reported an error.',
          code: str(error?.code) ?? str(error?.type),
        },
      ];
    }
    if (type === 'chat.end') {
      if (this.finished) return [];
      this.finished = true;
      const stats = obj(obj(data?.result)?.stats);
      const seconds = num(stats?.time_to_first_token_seconds);
      const load = num(stats?.model_load_time_seconds);
      this.stats = {
        ttftMs: seconds === null ? null : seconds * 1000,
        tokPerSec: num(stats?.tokens_per_second),
        inputTokens: num(stats?.input_tokens),
        outputTokens: num(stats?.total_output_tokens),
        reasoningTokens: num(stats?.reasoning_output_tokens),
        modelLoadMs: load === null ? null : load * 1000,
      };
      const output = this.stats.outputTokens;
      return [
        { type: 'finish', reason: output !== null && output >= this.maxTokens ? 'length' : 'stop' },
        {
          type: 'usage',
          usage: {
            promptTokens: this.stats.inputTokens,
            completionTokens: output,
            cachedTokens: null,
          },
          timings: null,
        },
        { type: 'done' },
      ];
    }
    return [{ type: 'ignored', why: type || 'unknown event' }];
  }
}

/** An LM Studio error body in words, from either of its shapes. */
export function lmErrorMessage(body: unknown): string | null {
  const b = obj(body);
  return str(obj(b?.error)?.message) ?? str(b?.error) ?? str(b?.message);
}

/** Is this the greeting LM Studio answers at `/lmstudio-greeting`? */
export function isLmGreeting(route: RouteResult | undefined): boolean {
  return route?.status === 200 && obj(route.body)?.lmstudio === true;
}

const LM_NETWORK: Record<string, { title: (a: string) => string; hint: string; summary: string }> =
  {
    refused: {
      title: (a) => `Nothing is listening at ${a}.`,
      hint: "Check that LM Studio's server is running (Developer → Status: Running) with Serve on Local Network on, or `lms server start --bind 0.0.0.0`. LM Studio uses port 1234 unless set otherwise.",
      summary: 'Nothing listening',
    },
    timeout: {
      title: (a) => `${a} did not answer in time.`,
      hint: 'Check the IP address, that both computers are on the same network, and that no firewall blocks the port.',
      summary: 'No answer',
    },
    unreachable: {
      title: (a) => `${a} cannot be reached from this computer.`,
      hint: 'Check the IP address and that both computers are on the same network.',
      summary: 'Unreachable',
    },
    dns: {
      title: (a) => `The name in ${a} could not be found.`,
      hint: "Use the machine's IP address instead.",
      summary: 'Unknown name',
    },
    reset: {
      title: (a) => `The connection to ${a} was cut off.`,
      hint: 'A firewall may be refusing LM Studio, or something else uses this port.',
      summary: 'Cut off',
    },
    'too-large': {
      title: (a) => `${a} sent an answer larger than any real one.`,
      hint: 'Check that the address is LM Studio. Model Duel stops reading answers this large.',
      summary: 'Answer too large',
    },
  };

/** A probe of an LM Studio server, from the routes it recorded, in the same report shape. */
export function classifyLmProbe(raw: ProbeRaw): ProbeReport {
  const issues: ProbeIssue[] = [];
  const issue = (
    capability: ProbeIssue['capability'],
    severity: ProbeIssue['severity'],
    title: string,
    hint: string,
  ) => issues.push({ capability, severity, title, hint });
  const address = describeAddress(raw.baseUrl);
  const medianMs = median(raw.rttMs);
  const notChecked: Capability = { status: 'unknown', summary: 'Not checked' };
  const none = (summary: string): Capability => ({ status: 'missing', summary });

  let reachable: Capability = notChecked;
  const greeting = raw.routes.lmGreeting;
  if (greeting?.error) {
    const known = LM_NETWORK[networkCategory(greeting.error.code)];
    issue(
      'reachable',
      'error',
      known ? known.title(address) : `${address} did not answer: ${greeting.error.message}`,
      (known?.hint ?? 'Check the address and that LM Studio is running.') +
        (known === LM_NETWORK.refused ? loopbackHint(raw.baseUrl) : ''),
    );
    reachable = { status: 'error', summary: known?.summary ?? 'No answer' };
  } else if (greeting && !isLmGreeting(greeting)) {
    issue(
      'reachable',
      'error',
      `Something answered at ${address}, but it is not LM Studio.`,
      'Check the port: LM Studio uses 1234 unless set otherwise. For Unsloth Studio, add the machine as Unsloth instead.',
    );
    reachable = { status: 'error', summary: 'Not LM Studio' };
  } else if (greeting) {
    reachable = {
      status: 'ok',
      summary: medianMs !== null ? `RTT ${formatMs(medianMs)}` : 'Answered',
    };
  }

  let key: Capability = notChecked;
  let text: Capability = notChecked;
  let models: LmModel[] = [];
  const listed = raw.routes.lmModels;
  if (reachable.status === 'ok' && listed) {
    if (listed.error) {
      issue(
        'key',
        'error',
        'LM Studio stopped answering during the probe.',
        `${listed.error.message} Probe again.`,
      );
      key = { status: 'error', summary: 'No answer' };
    } else if (listed.status === 401 || listed.status === 403) {
      issue(
        'key',
        'error',
        raw.keyConfigured ? 'LM Studio refused the API token.' : 'LM Studio asks for an API token.',
        raw.keyConfigured
          ? 'Create a new token in LM Studio (Developer → Server Settings → Manage Tokens) and paste it with Edit.'
          : 'Require Authentication is on in LM Studio. Create a token under Developer → Server Settings → Manage Tokens and add it with Edit.',
      );
      key = { status: 'error', summary: raw.keyConfigured ? 'Token refused' : 'Token needed' };
    } else if (listed.status === 404) {
      key = { status: 'ok', summary: raw.keyConfigured ? 'Token accepted' : 'No token needed' };
      issue(
        'text',
        'error',
        'This LM Studio is too old for Model Duel.',
        'Model Duel needs LM Studio 0.4 or newer, whose REST API lists models at /api/v1/models. Update LM Studio.',
      );
      text = { status: 'error', summary: 'Needs LM Studio 0.4+' };
    } else if (listed.status === 200) {
      key = { status: 'ok', summary: raw.keyConfigured ? 'Token accepted' : 'No token needed' };
      if (!raw.keyConfigured) {
        issue(
          'key',
          'info',
          'LM Studio answers without an API token.',
          'Anyone on your network can use it. Turn on Require Authentication in LM Studio to limit that.',
        );
      }
      models = parseLmModels(listed.body);
    } else {
      issue(
        'key',
        'error',
        `LM Studio answered HTTP ${listed.status} for its model list.`,
        "Probe again, or restart LM Studio's server.",
      );
      key = { status: 'error', summary: `HTTP ${listed.status}` };
    }
  }

  const status = lmModelStatus(models);
  const llms = models.filter((m) => m.type === 'llm');
  if (key.status === 'ok' && text.status === 'unknown') {
    if (status.activeModel) {
      const others = status.lmstudio?.otherLoaded ?? [];
      text = {
        status: 'ok',
        summary: `${status.activeModel}${status.quant ? ` ${status.quant}` : ''} loaded · ${llms.length} downloaded`,
      };
      if (others.length > 0) {
        issue(
          'text',
          'warning',
          `LM Studio has more than one model loaded: ${[status.activeModel, ...others].join(', ')}.`,
          'Races use the first. Unload the others in LM Studio, so they do not share the GPU during a race.',
        );
      }
    } else {
      text = { status: 'ok', summary: `No model loaded · ${llms.length} downloaded` };
    }
  }

  const overall = issues.some((i) => i.severity === 'error')
    ? 'error'
    : issues.some((i) => i.severity === 'warning')
      ? 'warning'
      : 'ok';
  return {
    overall,
    capabilities: {
      reachable,
      key,
      text,
      stt: key.status === 'ok' ? none('LM Studio has no speech-to-text') : notChecked,
      image: key.status === 'ok' ? none('LM Studio has no image generation') : notChecked,
      telemetry: key.status === 'ok' ? none('LM Studio reports no hardware readings') : notChecked,
    },
    issues,
    versions: { unsloth: null, studio: null, llamaCpp: null, torch: null, cuda: null },
    platform: {
      os: null,
      deviceType: null,
      backend: null,
      appleSilicon: null,
      cpuCores: null,
      memoryTotalGb: null,
    },
    gpus: [],
    text: {
      activeModel: status.activeModel,
      backend: status.backend,
      quant: status.quant,
      contextLength: status.contextLength,
      supportsReasoning: status.activeModel ? status.supportsReasoning : null,
      loadedCount: models.filter((m) => m.loaded.length > 0).length,
      availableCount: llms.length,
      slots: status.parallelSlots,
    },
    stt: { engines: [] },
    image: { loaded: null, model: null, engine: null, device: null },
    telemetry: {
      backend: null,
      devices: 0,
      gpuUtilPct: null,
      powerW: null,
      temperatureC: null,
      vramUsedGb: null,
      vramTotalGb: null,
    },
    rtt: {
      samplesMs: [...raw.rttMs],
      medianMs,
      minMs: raw.rttMs.length > 0 ? Math.min(...raw.rttMs) : null,
    },
  };
}
