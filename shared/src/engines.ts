import { withNonce } from './presets';
import type { ChatEvent, TextConfig, Timings } from './chat';
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
 * The local servers Model Duel races. Unsloth Studio does everything: text, speech, images and
 * hardware readings. The others race text only:
 *
 * - LM Studio, through its native REST API (see lmstudio.ts).
 * - Ollama, through its native `/api/chat`, whose stream is one JSON object per line and ends
 *   with Ollama's own timings in nanoseconds. Contracts from docs/api.md in the Ollama repository,
 *   read on 2026-10-21.
 * - Any OpenAI-compatible server: llama.cpp's llama-server, vLLM, SGLang and the like, through
 *   `/v1/chat/completions`. llama-server ends its stream with llama.cpp's timings, as Unsloth
 *   does; the others send token counts only.
 */
export const MACHINE_SERVERS = ['unsloth', 'lmstudio', 'ollama', 'openai-compatible'] as const;
export type MachineServer = (typeof MACHINE_SERVERS)[number];
export const SERVER_LABEL: Record<MachineServer, string> = {
  unsloth: 'Unsloth Studio',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible server',
};

/** The port each server listens on unless it was started with another. */
export const SERVER_PORT: Record<MachineServer, number> = {
  unsloth: 8888,
  lmstudio: 1234,
  ollama: 11434,
  'openai-compatible': 8080,
};

/**
 * The server's name as a run shows it: for an OpenAI-compatible server, the software that answered
 * (llama.cpp, vLLM, SGLang) where it said.
 */
export function serverName(
  server: MachineServer,
  status: Pick<ModelStatus, 'engine'> | null | undefined,
): string {
  return server === 'openai-compatible'
    ? (status?.engine?.name ?? 'OpenAI-compatible')
    : SERVER_LABEL[server];
}

/** Every server but Unsloth Studio races text only and reports no hardware. */
export function textOnlyServer(server: MachineServer | null | undefined): boolean {
  return server !== undefined && server !== null && server !== 'unsloth';
}

/** What a text-only server says about its loaded model beyond the common status fields. */
export interface EngineStatusDetails {
  /** The software: Ollama, llama.cpp, vLLM, SGLang, or null when the server does not say. */
  name: string | null;
  version: string | null;
  params: string | null;
  family: string | null;
  /** Bytes the loaded model takes, and how much of it is in GPU memory (Ollama). */
  sizeBytes: number | null;
  sizeVramBytes: number | null;
  /** What the model can do, as the server lists it: thinking, vision, tools… */
  capabilities: string[];
  /** Other models loaded or served at the same time. */
  otherLoaded: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');

/** A quant named in a model's file name or tag, such as Q4_K_M, IQ3_XS, F16 or BF16. */
export function quantFromName(name: string | null): string | null {
  if (!name) return null;
  const found = /(?:^|[-_.:/])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32|FP8|MXFP4)(?=$|[-_.:/])/i.exec(
    name,
  );
  return found?.[1] ? found[1].toUpperCase() : null;
}

/** Shared by both servers' probes: network failures in words. */
function networkIssue(
  server: 'Ollama' | 'the server',
  hint: string,
  route: RouteResult,
  baseUrl: string,
): { title: string; hint: string; summary: string } {
  const address = describeAddress(baseUrl);
  const category = networkCategory(route.error?.code ?? '');
  const known: Record<string, { title: string; hint: string; summary: string }> = {
    refused: {
      title: `Nothing is listening at ${address}.`,
      hint: hint + loopbackHint(baseUrl),
      summary: 'Nothing listening',
    },
    timeout: {
      title: `${address} did not answer in time.`,
      hint: 'Check the IP address, that both computers are on the same network, and that no firewall blocks the port.',
      summary: 'No answer',
    },
    unreachable: {
      title: `${address} cannot be reached from this computer.`,
      hint: 'Check the IP address and that both computers are on the same network.',
      summary: 'Unreachable',
    },
    dns: {
      title: `The name in ${address} could not be found.`,
      hint: "Use the machine's IP address instead.",
      summary: 'Unknown name',
    },
    reset: {
      title: `The connection to ${address} was cut off.`,
      hint: `A firewall may be refusing ${server}, or something else uses this port.`,
      summary: 'Cut off',
    },
    'too-large': {
      title: `${address} sent an answer larger than any real one.`,
      hint: `Check that the address is ${server}. Model Duel stops reading answers this large.`,
      summary: 'Answer too large',
    },
  };
  return (
    known[category] ?? {
      title: `${address} did not answer: ${route.error?.message ?? 'no answer'}`,
      hint,
      summary: 'No answer',
    }
  );
}

/** The parts of a probe report that a text-only server leaves empty. */
function emptyReport(
  issues: ProbeIssue[],
  capabilities: Pick<ProbeReport['capabilities'], 'reachable' | 'key' | 'text'>,
  status: ModelStatus,
  counts: { loaded: number; available: number },
  raw: ProbeRaw,
  label: string,
): ProbeReport {
  const medianMs = median(raw.rttMs);
  const none = (summary: string): Capability => ({ status: 'missing', summary });
  const notChecked: Capability = { status: 'unknown', summary: 'Not checked' };
  const keyOk = capabilities.key.status === 'ok';
  const overall = issues.some((i) => i.severity === 'error')
    ? 'error'
    : issues.some((i) => i.severity === 'warning')
      ? 'warning'
      : 'ok';
  return {
    overall,
    capabilities: {
      ...capabilities,
      stt: keyOk ? none(`${label} has no speech-to-text in Model Duel`) : notChecked,
      image: keyOk ? none(`${label} has no image generation in Model Duel`) : notChecked,
      telemetry: keyOk ? none(`${label} reports no hardware readings`) : notChecked,
    },
    issues,
    versions: {
      unsloth: null,
      studio: null,
      llamaCpp: null,
      torch: null,
      cuda: null,
      engine: status.engine?.version
        ? `${status.engine.name ?? label} ${status.engine.version}`
        : null,
    },
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
      loadedCount: counts.loaded,
      availableCount: counts.available,
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

/** A status with only what every server can say: the model, and nothing Unsloth-specific. */
function baseStatus(server: 'ollama' | 'openai-compatible'): ModelStatus {
  return {
    activeModel: null,
    modelIdentifier: null,
    backend: null,
    quant: null,
    contextLength: null,
    maxContextLength: null,
    nativeContextLength: null,
    requestedContextLength: null,
    supportsReasoning: false,
    reasoningStyle: null,
    reasoningAlwaysOn: false,
    reasoningEffortLevels: [],
    reasoningBudget: null,
    speculativeType: null,
    specDrafterKind: null,
    specFallbackReason: null,
    cacheTypeKv: null,
    mlxKvBits: null,
    gpuMemoryMode: null,
    gpuLayers: null,
    totalLayers: null,
    parallelSlots: null,
    memoryWarning: null,
    loading: [],
    isVision: false,
    server,
    engine: null,
  };
}

// ---- Ollama ------------------------------------------------------------------------------------

/** How long a raced model stays loaded after each request; Ollama's own default is 5 minutes. */
export const OLLAMA_KEEP_ALIVE = '30m';
/** A run whose load took longer than this loaded the model itself, so its times include the load. */
export const OLLAMA_LOAD_LIMIT_MS = 1000;

/** A downloaded model, as `GET /api/tags` lists it. */
export interface OllamaModel {
  name: string;
  sizeBytes: number | null;
  format: string | null;
  family: string | null;
  params: string | null;
  quant: string | null;
}

/** A loaded model, as `GET /api/ps` lists it. */
export interface OllamaLoaded extends OllamaModel {
  sizeVramBytes: number | null;
  /** Newer Ollama versions report the context the model was loaded with. */
  contextLength: number | null;
  expiresAt: string | null;
}

/** What `POST /api/show` says about a model. */
export interface OllamaShow {
  capabilities: string[];
  /** The context the model was trained for, from `<architecture>.context_length`. */
  nativeContext: number | null;
}

function ollamaModel(entry: unknown): OllamaModel | null {
  const e = obj(entry);
  const name = str(e?.name) ?? str(e?.model);
  if (!e || !name) return null;
  const d = obj(e.details);
  return {
    name,
    sizeBytes: num(e.size),
    format: str(d?.format),
    family: str(d?.family),
    params: str(d?.parameter_size),
    quant: str(d?.quantization_level) ?? quantFromName(name),
  };
}

export function parseOllamaTags(body: unknown): OllamaModel[] {
  return list(obj(body)?.models)
    .map(ollamaModel)
    .filter((m): m is OllamaModel => m !== null);
}

export function parseOllamaPs(body: unknown): OllamaLoaded[] {
  return list(obj(body)?.models)
    .map((entry): OllamaLoaded | null => {
      const model = ollamaModel(entry);
      const e = obj(entry);
      if (!model || !e) return null;
      return {
        ...model,
        sizeVramBytes: num(e.size_vram),
        contextLength: num(e.context_length),
        expiresAt: str(e.expires_at),
      };
    })
    .filter((m): m is OllamaLoaded => m !== null);
}

export function parseOllamaShow(body: unknown): OllamaShow {
  const b = obj(body);
  const info = obj(b?.model_info);
  const architecture = str(info?.['general.architecture']);
  const context = architecture ? num(info?.[`${architecture}.context_length`]) : null;
  return { capabilities: strings(b?.capabilities), nativeContext: context };
}

/** gpt-oss thinks at a level and cannot stop; the others think or not. */
const isLevelThinker = (family: string | null) => family !== null && /gpt-?oss/i.test(family);

/**
 * Ollama's loaded model in Unsloth's status shape, so pre-flight, the report and the Results tab
 * read every server alike. With several models loaded, the first is the one raced.
 */
export function ollamaModelStatus(
  loaded: readonly OllamaLoaded[],
  show: OllamaShow | null,
  version: string | null,
): ModelStatus {
  const model = loaded[0] ?? null;
  const status = baseStatus('ollama');
  if (!model) return { ...status, engine: engineDetails('Ollama', version, null, [], []) };
  const thinks = show?.capabilities.includes('thinking') ?? false;
  const levels = thinks && isLevelThinker(model.family) ? ['low', 'medium', 'high'] : [];
  return {
    ...status,
    activeModel: model.name,
    modelIdentifier: model.name,
    backend: model.format === 'gguf' ? 'gguf' : model.format ? 'other' : null,
    quant: model.quant,
    contextLength: model.contextLength,
    maxContextLength: show?.nativeContext ?? null,
    nativeContextLength: show?.nativeContext ?? null,
    supportsReasoning: thinks,
    reasoningStyle: thinks ? 'ollama' : null,
    reasoningAlwaysOn: levels.length > 0,
    reasoningEffortLevels: levels,
    isVision: show?.capabilities.includes('vision') ?? false,
    engine: engineDetails(
      'Ollama',
      version,
      model,
      show?.capabilities ?? [],
      loaded.slice(1).map((m) => m.name),
    ),
  };
}

function engineDetails(
  name: string | null,
  version: string | null,
  model: (Partial<OllamaLoaded> & { params?: string | null }) | null,
  capabilities: string[],
  otherLoaded: string[],
): EngineStatusDetails {
  return {
    name,
    version,
    params: model?.params ?? null,
    family: model?.family ?? null,
    sizeBytes: model?.sizeBytes ?? null,
    sizeVramBytes: model?.sizeVramBytes ?? null,
    capabilities,
    otherLoaded,
  };
}

/** Ollama's `think`: true or false, a level for gpt-oss, or left out for a model that cannot think. */
export function ollamaThink(
  status: Pick<ModelStatus, 'supportsReasoning' | 'reasoningEffortLevels'>,
  thinking: boolean,
  effort: string | null,
): boolean | string | undefined {
  if (!status.supportsReasoning) return undefined;
  const levels = status.reasoningEffortLevels;
  if (levels.length > 0) return effort && levels.includes(effort) ? effort : undefined;
  return thinking;
}

/**
 * The body of `POST /api/chat` for one run. The same prompt as for the other servers, nonce line
 * included. The context is never sent: a `num_ctx` other than the loaded one makes Ollama load
 * the model again, which the run would time.
 */
export function ollamaChatBody(
  config: Pick<
    TextConfig,
    'prompt' | 'maxTokens' | 'thinking' | 'reasoningEffort' | 'prefill' | 'sampling'
  >,
  status: Pick<ModelStatus, 'activeModel' | 'supportsReasoning' | 'reasoningEffortLevels'>,
  nonce: string | null,
): Record<string, unknown> {
  const s = config.sampling;
  const cold = config.prefill === 'cold';
  const think = ollamaThink(status, config.thinking, config.reasoningEffort);
  return {
    model: status.activeModel ?? '',
    messages: [{ role: 'user', content: withNonce(config.prompt, cold ? nonce : null) }],
    stream: true,
    keep_alive: OLLAMA_KEEP_ALIVE,
    ...(think !== undefined ? { think } : {}),
    options: {
      num_predict: config.maxTokens,
      temperature: s.temperature,
      top_p: s.topP,
      top_k: s.topK,
      min_p: s.minP,
      repeat_penalty: s.repetitionPenalty,
      ...(cold ? { seed: s.seed } : {}),
    },
  };
}

/** Ollama's own account of a run, from the stream's last object. Times are in ms. */
export interface OllamaStats {
  loadMs: number | null;
  promptEvalCount: number | null;
  promptEvalMs: number | null;
  evalCount: number | null;
  evalMs: number | null;
  totalMs: number | null;
  doneReason: string | null;
}

const NS = 1e6;
const ms = (ns: unknown): number | null => {
  const v = num(ns);
  return v === null ? null : v / NS;
};
const rate = (count: number | null, millis: number | null): number | null =>
  count !== null && millis !== null && millis > 0 ? count / (millis / 1000) : null;

/** Ollama's numbers in llama.cpp's timings shape, which they mean the same as. */
export function ollamaTimings(stats: OllamaStats): Timings {
  return {
    promptN: stats.promptEvalCount,
    promptMs: stats.promptEvalMs,
    promptPerSecond: rate(stats.promptEvalCount, stats.promptEvalMs),
    predictedN: stats.evalCount,
    predictedMs: stats.evalMs,
    predictedPerSecond: rate(stats.evalCount, stats.evalMs),
    cacheN: null,
    draftN: null,
    draftAccepted: null,
  };
}

/** An Ollama error in words, from a body or a streamed object. */
export function ollamaErrorMessage(body: unknown): string | null {
  const b = obj(body);
  return str(b?.error) ?? str(obj(b?.error)?.message) ?? (typeof body === 'string' ? body : null);
}

/**
 * Reads the lines of `POST /api/chat` into Model Duel's chat events. Thinking arrives as
 * `message.thinking`, the answer as `message.content`, and the last object has `done: true` with
 * Ollama's timings. A run that made Ollama load the model is refused, since its times include
 * the load.
 */
export class OllamaStreamReader {
  stats: OllamaStats | null = null;
  private finished = false;

  push(message: SseMessage): ChatEvent[] {
    if (message.kind === 'comment') return [{ type: 'keepalive' }];
    let data: Json | null;
    try {
      data = obj(JSON.parse(message.data));
    } catch {
      return [{ type: 'ignored', why: 'not JSON' }];
    }
    if (!data) return [{ type: 'ignored', why: 'not an object' }];
    if (data.error !== undefined) {
      return [
        {
          type: 'error',
          message: ollamaErrorMessage(data) ?? 'Ollama reported an error.',
          code: null,
        },
      ];
    }
    const events: ChatEvent[] = [];
    const m = obj(data.message);
    const thinking = str(m?.thinking);
    if (thinking) events.push({ type: 'reasoning', text: thinking });
    const content = str(m?.content);
    if (content) events.push({ type: 'content', text: content });
    if (data.done === true && !this.finished) {
      this.finished = true;
      const stats: OllamaStats = {
        loadMs: ms(data.load_duration),
        promptEvalCount: num(data.prompt_eval_count),
        promptEvalMs: ms(data.prompt_eval_duration),
        evalCount: num(data.eval_count),
        evalMs: ms(data.eval_duration),
        totalMs: ms(data.total_duration),
        doneReason: str(data.done_reason),
      };
      this.stats = stats;
      if (stats.loadMs !== null && stats.loadMs > OLLAMA_LOAD_LIMIT_MS) {
        events.push({
          type: 'error',
          message: `Ollama loaded ${str(data.model) ?? 'the model'} for this run (${(stats.loadMs / 1000).toFixed(1)} s), so its times include the load. Load the model on the Models tab first.`,
          code: 'model_load',
        });
      }
      events.push(
        { type: 'finish', reason: stats.doneReason ?? 'stop' },
        {
          type: 'usage',
          usage: {
            promptTokens: stats.promptEvalCount,
            completionTokens: stats.evalCount,
            cachedTokens: null,
          },
          timings: ollamaTimings(stats),
        },
        { type: 'done' },
      );
    }
    return events.length > 0 ? events : [{ type: 'ignored', why: 'no output' }];
  }
}

/** A probe of an Ollama server: its version, which needs no key, then what is loaded and downloaded. */
export function classifyOllamaProbe(raw: ProbeRaw): ProbeReport {
  const issues: ProbeIssue[] = [];
  const issue = (
    capability: ProbeIssue['capability'],
    severity: ProbeIssue['severity'],
    title: string,
    hint: string,
  ) => issues.push({ capability, severity, title, hint });
  const notChecked: Capability = { status: 'unknown', summary: 'Not checked' };
  const medianMs = median(raw.rttMs);

  let reachable: Capability = notChecked;
  let version: string | null = null;
  const greeting = raw.routes.ollamaVersion;
  if (greeting?.error) {
    const known = networkIssue(
      'Ollama',
      'Check that Ollama is running and listens on the network: set OLLAMA_HOST=0.0.0.0 before starting it. Ollama uses port 11434 unless set otherwise.',
      greeting,
      raw.baseUrl,
    );
    issue('reachable', 'error', known.title, known.hint);
    reachable = { status: 'error', summary: known.summary };
  } else if (greeting) {
    version = str(obj(greeting.body)?.version);
    if (greeting.status === 401 || greeting.status === 403) {
      reachable = { status: 'ok', summary: 'Answered' };
    } else if (greeting.status !== 200 || !version) {
      issue(
        'reachable',
        'error',
        `Something answered at ${describeAddress(raw.baseUrl)}, but it is not Ollama.`,
        'Check the port: Ollama uses 11434 unless set otherwise. For llama.cpp, vLLM or SGLang, add the machine as an OpenAI-compatible server instead.',
      );
      reachable = { status: 'error', summary: 'Not Ollama' };
    } else {
      reachable = {
        status: 'ok',
        summary: medianMs !== null ? `RTT ${formatMs(medianMs)}` : 'Answered',
      };
    }
  }

  let key: Capability = notChecked;
  let text: Capability = notChecked;
  let loaded: OllamaLoaded[] = [];
  let downloaded: OllamaModel[] = [];
  const ps = raw.routes.ollamaPs;
  const tags = raw.routes.ollamaTags;
  if (reachable.status === 'ok' && ps) {
    if (ps.error) {
      issue(
        'key',
        'error',
        'Ollama stopped answering during the probe.',
        `${ps.error.message} Probe again.`,
      );
      key = { status: 'error', summary: 'No answer' };
    } else if (ps.status === 401 || ps.status === 403) {
      issue(
        'key',
        'error',
        raw.keyConfigured
          ? 'The server in front of Ollama refused the key.'
          : 'The server in front of Ollama asks for a key.',
        'Ollama itself takes no key. A proxy in front of it does: paste the key it expects with Edit.',
      );
      key = { status: 'error', summary: raw.keyConfigured ? 'Key refused' : 'Key needed' };
    } else if (ps.status === 200) {
      key = { status: 'ok', summary: raw.keyConfigured ? 'Key accepted' : 'No key needed' };
      loaded = parseOllamaPs(ps.body);
      downloaded = tags?.status === 200 ? parseOllamaTags(tags.body) : [];
    } else {
      issue(
        'key',
        'error',
        `Ollama answered HTTP ${ps.status} for its loaded models.`,
        'Probe again, or restart Ollama.',
      );
      key = { status: 'error', summary: `HTTP ${ps.status}` };
    }
  }

  const status = ollamaModelStatus(loaded, null, version);
  if (key.status === 'ok') {
    if (status.activeModel) {
      text = {
        status: 'ok',
        summary: `${status.activeModel}${status.quant ? ` ${status.quant}` : ''} loaded · ${downloaded.length} downloaded`,
      };
      const others = status.engine?.otherLoaded ?? [];
      if (others.length > 0) {
        issue(
          'text',
          'warning',
          `Ollama has more than one model loaded: ${[status.activeModel, ...others].join(', ')}.`,
          'Races use the first. Unload the others on the Models tab, so they do not share the GPU during a race.',
        );
      }
      const vram = loaded[0]?.sizeVramBytes ?? null;
      const size = loaded[0]?.sizeBytes ?? null;
      if (vram !== null && size !== null && size > 0 && vram < size * 0.99) {
        issue(
          'text',
          'warning',
          `${status.activeModel} is only ${Math.round((vram / size) * 100)}% in GPU memory; the rest runs on the CPU.`,
          'Its speed then measures the CPU as much as the GPU. A smaller quant or context fits it on the GPU.',
        );
      }
    } else {
      text = { status: 'ok', summary: `No model loaded · ${downloaded.length} downloaded` };
    }
  }
  return emptyReport(
    issues,
    { reachable, key, text },
    status,
    { loaded: loaded.length, available: downloaded.length },
    raw,
    'Ollama',
  );
}

// ---- OpenAI-compatible servers ------------------------------------------------------------------

/** A model an OpenAI-compatible server serves, with what llama-server and vLLM add to the list. */
export interface CompatModel {
  id: string;
  ownedBy: string | null;
  /** vLLM's `max_model_len`. */
  maxModelLen: number | null;
  /** llama-server's `meta`: the trained context, parameters and file size. */
  trainedContext: number | null;
  params: number | null;
  sizeBytes: number | null;
}

export function parseCompatModels(body: unknown): CompatModel[] {
  return list(obj(body)?.data)
    .map((entry): CompatModel | null => {
      const e = obj(entry);
      const id = str(e?.id);
      if (!e || !id) return null;
      const meta = obj(e.meta);
      return {
        id,
        ownedBy: str(e.owned_by),
        maxModelLen: num(e.max_model_len),
        trainedContext: num(meta?.n_ctx_train),
        params: num(meta?.n_params),
        sizeBytes: num(meta?.size),
      };
    })
    .filter((m): m is CompatModel => m !== null);
}

/** What llama-server's `/props` says: the context per slot, the slots and the build. */
export interface CompatProps {
  contextLength: number | null;
  slots: number | null;
  build: string | null;
  modelPath: string | null;
}

export function parseCompatProps(body: unknown): CompatProps | null {
  const b = obj(body);
  if (!b) return null;
  const settings = obj(b.default_generation_settings);
  const props = {
    contextLength: num(settings?.n_ctx) ?? num(b.n_ctx),
    slots: num(b.total_slots),
    build: str(b.build_info),
    modelPath: str(b.model_path),
  };
  return props.contextLength === null && props.slots === null && props.build === null
    ? null
    : props;
}

const OWNERS: Record<string, string> = { llamacpp: 'llama.cpp', vllm: 'vLLM', sglang: 'SGLang' };

/** Which software serves the models, from what it answered. */
export function compatEngine(
  models: readonly CompatModel[],
  props: CompatProps | null,
  version: string | null,
): { name: string | null; version: string | null } {
  if (props?.build) return { name: 'llama.cpp', version: props.build };
  const owner = models[0]?.ownedBy?.toLowerCase() ?? '';
  const name = OWNERS[owner] ?? null;
  return { name, version: name === 'llama.cpp' ? null : version };
}

/**
 * An OpenAI-compatible server's model in Unsloth's status shape. Such servers serve what they were
 * started with; with several, the first is the one raced. Whether the model thinks is not
 * reported, so thinking is offered and sent as the chat template's `enable_thinking`.
 */
export function compatModelStatus(
  models: readonly CompatModel[],
  props: CompatProps | null,
  version: string | null,
): ModelStatus {
  const model = models[0] ?? null;
  const engine = compatEngine(models, props, version);
  const status = baseStatus('openai-compatible');
  const details: EngineStatusDetails = {
    name: engine.name,
    version: engine.version,
    params: model?.params ? `${(model.params / 1e9).toFixed(1).replace(/\.0$/, '')}B` : null,
    family: null,
    sizeBytes: model?.sizeBytes ?? null,
    sizeVramBytes: null,
    capabilities: [],
    otherLoaded: models.slice(1).map((m) => m.id),
  };
  if (!model) return { ...status, engine: details };
  return {
    ...status,
    activeModel: model.id,
    modelIdentifier: model.id,
    backend: engine.name === 'llama.cpp' ? 'gguf' : 'other',
    quant: quantFromName(props?.modelPath ?? null) ?? quantFromName(model.id),
    contextLength: props?.contextLength ?? model.maxModelLen,
    maxContextLength: model.trainedContext ?? model.maxModelLen,
    nativeContextLength: model.trainedContext,
    supportsReasoning: true,
    reasoningStyle: 'chat-template',
    parallelSlots: props?.slots ?? null,
    engine: details,
  };
}

/**
 * The body of `POST /v1/chat/completions` for an OpenAI-compatible server: only standard fields,
 * plus the sampling fields llama-server and vLLM both read (each ignores the other's name for
 * the repetition penalty), and thinking through the chat template.
 */
export function compatChatBody(
  config: Pick<
    TextConfig,
    'prompt' | 'maxTokens' | 'thinking' | 'reasoningEffort' | 'prefill' | 'sampling'
  >,
  status: Pick<ModelStatus, 'activeModel' | 'reasoningEffortLevels'>,
  nonce: string | null,
): Record<string, unknown> {
  const s = config.sampling;
  const cold = config.prefill === 'cold';
  const effort =
    config.reasoningEffort && status.reasoningEffortLevels.includes(config.reasoningEffort)
      ? config.reasoningEffort
      : null;
  return {
    model: status.activeModel ?? '',
    messages: [{ role: 'user', content: withNonce(config.prompt, cold ? nonce : null) }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: config.maxTokens,
    temperature: s.temperature,
    top_p: s.topP,
    top_k: s.topK,
    min_p: s.minP,
    repeat_penalty: s.repetitionPenalty,
    repetition_penalty: s.repetitionPenalty,
    ...(cold ? { seed: s.seed } : {}),
    chat_template_kwargs: { enable_thinking: config.thinking },
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

/** An OpenAI-compatible error body in words. */
export function compatErrorMessage(body: unknown): string | null {
  const b = obj(body);
  return (
    str(obj(b?.error)?.message) ??
    str(b?.error) ??
    str(b?.message) ??
    str(b?.detail) ??
    (typeof body === 'string' ? body.slice(0, 300) : null)
  );
}

/** A probe of an OpenAI-compatible server: its model list, then llama-server's or vLLM's extras. */
export function classifyCompatProbe(raw: ProbeRaw): ProbeReport {
  const issues: ProbeIssue[] = [];
  const issue = (
    capability: ProbeIssue['capability'],
    severity: ProbeIssue['severity'],
    title: string,
    hint: string,
  ) => issues.push({ capability, severity, title, hint });
  const notChecked: Capability = { status: 'unknown', summary: 'Not checked' };
  const medianMs = median(raw.rttMs);
  const address = describeAddress(raw.baseUrl);

  let reachable: Capability = notChecked;
  let key: Capability = notChecked;
  let text: Capability = notChecked;
  let models: CompatModel[] = [];
  const listed = raw.routes.compatModels;
  if (listed?.error) {
    const known = networkIssue(
      'the server',
      'Check that the server is running and listens on the network (llama-server --host 0.0.0.0, vllm serve --host 0.0.0.0), and the port: llama-server uses 8080 and vLLM 8000 unless set otherwise.',
      listed,
      raw.baseUrl,
    );
    issue('reachable', 'error', known.title, known.hint);
    reachable = { status: 'error', summary: known.summary };
  } else if (listed) {
    reachable = {
      status: 'ok',
      summary: medianMs !== null ? `RTT ${formatMs(medianMs)}` : 'Answered',
    };
    if (listed.status === 401 || listed.status === 403) {
      issue(
        'key',
        'error',
        raw.keyConfigured ? 'The server refused the API key.' : 'The server asks for an API key.',
        raw.keyConfigured
          ? 'Check the key it was started with (llama-server --api-key, vllm serve --api-key) and paste it again with Edit.'
          : 'It was started with an API key (llama-server --api-key, vllm serve --api-key). Add that key with Edit.',
      );
      key = { status: 'error', summary: raw.keyConfigured ? 'Key refused' : 'Key needed' };
    } else if (listed.status === 200) {
      models = parseCompatModels(listed.body);
      key = { status: 'ok', summary: raw.keyConfigured ? 'Key accepted' : 'No key needed' };
      if (models.length === 0) {
        issue(
          'text',
          'error',
          `${address} lists no models at /v1/models.`,
          'Start the server with a model, or wait until it has loaded one.',
        );
        text = { status: 'error', summary: 'No model' };
      }
    } else if (listed.status === 503) {
      key = { status: 'ok', summary: 'Answered' };
      issue('text', 'error', 'The server is still loading its model.', 'Probe again when it has.');
      text = { status: 'error', summary: 'Loading' };
    } else {
      issue(
        'reachable',
        'error',
        `${address} answered HTTP ${listed.status} at /v1/models, so it is not an OpenAI-compatible server.`,
        'Check the address and port. For Ollama, LM Studio or Unsloth Studio, add the machine as that server instead.',
      );
      reachable = { status: 'error', summary: 'Not OpenAI-compatible' };
    }
  }

  const props =
    raw.routes.compatProps?.status === 200 ? parseCompatProps(raw.routes.compatProps.body) : null;
  const version = str(obj(raw.routes.compatVersion?.body)?.version);
  const status = compatModelStatus(models, props, version);
  if (key.status === 'ok' && text.status === 'unknown' && status.activeModel) {
    const engine = status.engine?.name ?? 'OpenAI-compatible';
    text = {
      status: 'ok',
      summary: `${status.activeModel} on ${engine}${status.contextLength ? ` · ${status.contextLength.toLocaleString('en-US')} context` : ''}`,
    };
    const others = status.engine?.otherLoaded ?? [];
    if (others.length > 0) {
      issue(
        'text',
        'warning',
        `The server serves more than one model: ${[status.activeModel, ...others].join(', ')}.`,
        'Races use the first. Start the server with only the model to race.',
      );
    }
    if (status.engine?.name !== 'llama.cpp') {
      issue(
        'text',
        'info',
        `${engine} reports token counts but not its own timings.`,
        "Model Duel times its runs on this computer, network included; the server's own decode speed is shown only for llama.cpp.",
      );
    }
  }
  return emptyReport(
    issues,
    { reachable, key, text },
    status,
    { loaded: models.length, available: models.length },
    raw,
    status.engine?.name ?? 'The server',
  );
}
