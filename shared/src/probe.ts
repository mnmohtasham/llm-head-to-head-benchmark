import { describeAddress } from './url';

export const PROBE_SCHEMA_VERSION = 1;

/** Every Unsloth route the probe reads. */
export const PROBE_ROUTES = {
  health: '/api/health',
  status: '/api/inference/status',
  system: '/api/system',
  hardware: '/api/system/hardware?include_details=true',
  models: '/v1/models',
  props: '/v1/props',
  stt: '/api/inference/audio/stt/status',
  image: '/api/inference/images/status',
  telemetry: '/api/train/hardware',
} as const;
export type RouteKey = keyof typeof PROBE_ROUTES;

export interface NetworkError {
  code: string;
  message: string;
}

/** One HTTP exchange as the probe saw it. */
export interface RouteResult {
  path: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** Time until the whole body arrived. */
  ms: number | null;
  contentType: string | null;
  /** Parsed JSON, or the start of the text when the answer was not JSON. */
  body: unknown;
  error: NetworkError | null;
}

/** Everything a probe recorded. The report is always derived from this, so it can be re-derived. */
export interface ProbeRaw {
  schemaVersion: number;
  baseUrl: string;
  keyConfigured: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  routes: Partial<Record<RouteKey, RouteResult>>;
  /** Unauthenticated health round trips on the same keep-alive connection. */
  rttMs: number[];
}

export type CapabilityKey = 'reachable' | 'key' | 'text' | 'stt' | 'image' | 'telemetry';
export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  'reachable',
  'key',
  'text',
  'stt',
  'image',
  'telemetry',
];
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  reachable: 'Reachable',
  key: 'Key',
  text: 'Text',
  stt: 'STT',
  image: 'Image',
  telemetry: 'Telemetry',
};

/**
 * ok: works. missing: this machine or Unsloth version does not have it.
 * error: it failed. unknown: not checked, because an earlier step failed.
 */
export type CapabilityStatus = 'ok' | 'missing' | 'error' | 'unknown';
export interface Capability {
  status: CapabilityStatus;
  summary: string;
}

export type IssueSeverity = 'error' | 'warning' | 'info';
export interface ProbeIssue {
  capability: CapabilityKey;
  severity: IssueSeverity;
  title: string;
  hint: string;
}

export interface SttEngine {
  name: 'transformers' | 'gguf' | 'mtmd';
  label: string;
  available: boolean;
  loadedModel: string | null;
}

export interface ProbeReport {
  overall: 'ok' | 'warning' | 'error';
  capabilities: Record<CapabilityKey, Capability>;
  issues: ProbeIssue[];
  versions: {
    unsloth: string | null;
    studio: string | null;
    llamaCpp: string | null;
    torch: string | null;
    cuda: string | null;
  };
  platform: {
    os: string | null;
    deviceType: string | null;
    backend: string | null;
    appleSilicon: boolean | null;
    cpuCores: number | null;
    memoryTotalGb: number | null;
  };
  gpus: Array<{ name: string; memoryGb: number | null }>;
  text: {
    activeModel: string | null;
    backend: 'gguf' | 'mlx' | 'other' | null;
    quant: string | null;
    contextLength: number | null;
    supportsReasoning: boolean | null;
    loadedCount: number | null;
    availableCount: number | null;
    slots: number | null;
  };
  stt: { engines: SttEngine[] };
  image: {
    loaded: boolean | null;
    model: string | null;
    engine: string | null;
    device: string | null;
  };
  telemetry: {
    backend: string | null;
    devices: number;
    gpuUtilPct: number | null;
    powerW: number | null;
    temperatureC: number | null;
    vramUsedGb: number | null;
    vramTotalGb: number | null;
  };
  rtt: { samplesMs: number[]; medianMs: number | null; minMs: number | null };
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function list(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
function ok200(route: RouteResult | undefined): Json | null {
  return route && route.status === 200 ? obj(route.body) : null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

export function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/** `unsloth/Qwen3-8B-GGUF` becomes `Qwen3-8B-GGUF`. */
export function shortModelName(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** Whether a health answer came from Unsloth Studio. */
export function isUnslothHealth(route: RouteResult | undefined): boolean {
  const body = ok200(route);
  if (!body) return false;
  const service = str(body.service);
  if (service !== null && service.toLowerCase().includes('unsloth')) return true;
  return body.status === 'healthy' && typeof body.studio_root_id === 'string';
}

/** The human-readable part of an error body from FastAPI or an OpenAI-style route. */
export function detailOf(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  const b = obj(body);
  if (!b) return '';
  if (typeof b.detail === 'string') return b.detail;
  const error = obj(b.error);
  if (error && typeof error.message === 'string') return error.message;
  if (typeof b.message === 'string') return b.message;
  return '';
}

function httpText(route: RouteResult): string {
  const html = route.contentType?.includes('text/html') ?? false;
  const detail = html ? '' : detailOf(route.body);
  return `HTTP ${route.status}${html ? ' (a web page)' : ''}${detail ? `: ${detail}` : ''}`;
}

function routeProblem(route: RouteResult): string {
  return route.error ? route.error.message : httpText(route);
}

export type NetworkCategory =
  'refused' | 'timeout' | 'unreachable' | 'dns' | 'reset' | 'tls' | 'other';

const CATEGORY_BY_CODE: Record<string, NetworkCategory> = {
  ECONNREFUSED: 'refused',
  TIMEOUT: 'timeout',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  UND_ERR_BODY_TIMEOUT: 'timeout',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  EHOSTDOWN: 'unreachable',
  ENETDOWN: 'unreachable',
  EADDRNOTAVAIL: 'unreachable',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EAI_NONAME: 'dns',
  EAI_FAIL: 'dns',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  UND_ERR_SOCKET: 'reset',
  UND_ERR_CLOSED: 'reset',
  EPROTO: 'tls',
};

export function networkCategory(code: string): NetworkCategory {
  const known = CATEGORY_BY_CODE[code];
  if (known) return known;
  // HPE_ codes come from the HTTP parser: the other side does not speak HTTP.
  if (code.startsWith('HPE_')) return 'reset';
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || code.includes('CERT'))
    return 'tls';
  return 'other';
}

const NETWORK_SUMMARY: Record<NetworkCategory, string> = {
  refused: 'Nothing listening',
  timeout: 'No answer',
  unreachable: 'Unreachable',
  dns: 'Unknown host',
  reset: 'Connection cut',
  tls: 'TLS failed',
  other: 'Failed',
};

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/** A plain-language title and hint for a request that got no HTTP answer. */
export function explainNetworkError(
  error: NetworkError,
  baseUrl: string,
): { title: string; hint: string } {
  const address = describeAddress(baseUrl);
  switch (networkCategory(error.code)) {
    case 'refused':
      return {
        title: `Nothing is listening at ${address}.`,
        hint: 'Check that Unsloth is running on that machine and that LAN access is on: Settings → API → Remote & LAN → Start. If Unsloth uses a port other than 8888, include it in the address.',
      };
    case 'timeout':
      return {
        title: `${address} did not answer in time.`,
        hint: 'Check the IP address, that both computers are on the same network, and that no firewall blocks the port.',
      };
    case 'unreachable':
      return {
        title: `${address} cannot be reached from this computer.`,
        hint: 'Check the IP address and that both computers are on the same network.',
      };
    case 'dns':
      return {
        title: `The name ${hostOf(baseUrl)} could not be found.`,
        hint: "Use the machine's IP address instead, or check the spelling. Names ending in .local need working mDNS on this computer.",
      };
    case 'reset':
      return {
        title: `The connection to ${address} was cut off.`,
        hint: 'A firewall on that machine may be refusing Unsloth: on a Mac, allow incoming connections for Unsloth under System Settings → Network → Firewall → Options. Otherwise something other than Unsloth may be using this port, or the address needs https:// instead of http://.',
      };
    case 'tls':
      return {
        title: `The secure connection to ${address} failed.`,
        hint: 'Use http:// for an address on your network. For an https:// address, check its certificate.',
      };
    default:
      return { title: `Could not connect to ${address}.`, hint: `The error was: ${error.message}` };
  }
}

function networkIssue(capability: CapabilityKey, error: NetworkError, baseUrl: string): ProbeIssue {
  return { capability, severity: 'error', ...explainNetworkError(error, baseUrl) };
}

const NOT_CHECKED: Capability = { status: 'unknown', summary: 'Not checked' };

function classifyReachable(
  raw: ProbeRaw,
  medianRtt: number | null,
  issues: ProbeIssue[],
): Capability {
  const route = raw.routes.health;
  if (!route) return NOT_CHECKED;
  if (route.error) {
    issues.push(networkIssue('reachable', route.error, raw.baseUrl));
    return { status: 'error', summary: NETWORK_SUMMARY[networkCategory(route.error.code)] };
  }
  if (!isUnslothHealth(route)) {
    issues.push({
      capability: 'reachable',
      severity: 'error',
      title: `Something answered at ${describeAddress(raw.baseUrl)}, but it is not Unsloth Studio.`,
      hint: `It returned ${httpText(route)}. Check the port: Unsloth uses 8888 unless it was started with another one.`,
    });
    return { status: 'error', summary: 'Not Unsloth' };
  }
  return { status: 'ok', summary: medianRtt !== null ? `RTT ${formatMs(medianRtt)}` : 'Answered' };
}

function classifyKey(raw: ProbeRaw, issues: ProbeIssue[]): Capability {
  let route = raw.routes.status;
  // An older Unsloth without the status route: any key-protected route answers the question.
  if (route?.status === 404 && raw.routes.system) route = raw.routes.system;
  if (!route) return NOT_CHECKED;
  const issue = (severity: IssueSeverity, title: string, hint: string) =>
    issues.push({ capability: 'key', severity, title, hint });

  if (route.error) {
    issue(
      'error',
      'Unsloth stopped answering during the probe.',
      `${route.error.message} Probe again.`,
    );
    return { status: 'error', summary: 'No answer' };
  }
  if (route.status === 200) {
    if (!raw.keyConfigured) {
      issue(
        'info',
        'This machine answers without an API key.',
        'Keyless access is on in Unsloth, so anyone on your network can use it.',
      );
      return { status: 'ok', summary: 'Not needed' };
    }
    return { status: 'ok', summary: 'Accepted' };
  }
  if (route.status === 401) {
    if (!raw.keyConfigured) {
      issue(
        'error',
        'This machine needs an API key.',
        'In Unsloth on that machine, open Settings → API and create a key. Then use Edit here to paste it.',
      );
      return { status: 'error', summary: 'Key needed' };
    }
    issue(
      'error',
      'The API key was rejected.',
      'It may have been deleted or mistyped. Create a new key in Unsloth under Settings → API, then use Edit here to paste it.',
    );
    return { status: 'error', summary: 'Rejected' };
  }
  if (route.status === 403) {
    const detail = detailOf(route.body);
    if (/password/i.test(detail)) {
      issue(
        'error',
        'Unsloth is waiting for its first-run setup.',
        'Open Unsloth on that machine once and finish setting the password, then probe again.',
      );
      return { status: 'error', summary: 'Setup pending' };
    }
    issue(
      'error',
      'Unsloth refused the request.',
      detail ? `Unsloth said: "${detail}".` : 'HTTP 403.',
    );
    return { status: 'error', summary: 'Refused' };
  }
  if (route.status === 404) {
    issue(
      'warning',
      'The key could not be checked.',
      'This Unsloth version answers neither the status route nor the system route. Update Unsloth on that machine.',
    );
    return { status: 'unknown', summary: 'Could not check' };
  }
  issue('error', 'Unsloth returned an error while checking the key.', httpText(route));
  return { status: 'error', summary: `HTTP ${route.status}` };
}

const EMPTY_TEXT: ProbeReport['text'] = {
  activeModel: null,
  backend: null,
  quant: null,
  contextLength: null,
  supportsReasoning: null,
  loadedCount: null,
  availableCount: null,
  slots: null,
};

function classifyText(
  raw: ProbeRaw,
  issues: ProbeIssue[],
): { capability: Capability; details: ProbeReport['text'] } {
  const details = { ...EMPTY_TEXT };
  const statusRoute = raw.routes.status;
  const status = ok200(statusRoute);
  if (!status) {
    if (statusRoute?.status === 404) {
      issues.push({
        capability: 'text',
        severity: 'warning',
        title: 'This Unsloth version has no inference status route.',
        hint: 'Update Unsloth on that machine, then probe again.',
      });
      return { capability: { status: 'missing', summary: 'Status route missing' }, details };
    }
    issues.push({
      capability: 'text',
      severity: 'error',
      title: 'Could not read the text model status.',
      hint: statusRoute ? routeProblem(statusRoute) : 'The status route was not called.',
    });
    return { capability: { status: 'error', summary: 'Status failed' }, details };
  }

  const activeModel = str(status.active_model);
  details.activeModel = activeModel;
  if (activeModel) {
    details.backend = status.is_gguf === true ? 'gguf' : status.is_mlx === true ? 'mlx' : 'other';
    details.quant = str(status.gguf_variant);
    details.contextLength = num(status.context_length);
    details.supportsReasoning = bool(status.supports_reasoning);
    details.slots = num(ok200(raw.routes.props)?.total_slots) ?? num(status.parallel_slots);
  }

  const modelsRoute = raw.routes.models;
  const data = list(ok200(modelsRoute)?.data);
  if (data) {
    details.availableCount = data.length;
    details.loadedCount = data.filter((entry) => obj(entry)?.loaded === true).length;
  } else if (modelsRoute?.status === 404) {
    issues.push({
      capability: 'text',
      severity: 'warning',
      title: 'This Unsloth version has no /v1/models route.',
      hint: 'Model Duel needs it to list and load models. Update Unsloth on that machine.',
    });
  } else if (modelsRoute) {
    issues.push({
      capability: 'text',
      severity: 'warning',
      title: 'Listing the models failed.',
      hint: modelsRoute.error
        ? `${modelsRoute.error.message} Scanning large model folders can be slow, so probe again.`
        : httpText(modelsRoute),
    });
  }

  const memoryWarning = str(status.memory_warning);
  if (memoryWarning) {
    issues.push({
      capability: 'text',
      severity: 'warning',
      title: 'The loaded model does not fit in memory.',
      hint: memoryWarning,
    });
  }

  const loaded = activeModel
    ? `${shortModelName(activeModel)}${details.quant ? ` ${details.quant}` : ''} loaded`
    : 'No model loaded';
  const summary =
    details.availableCount !== null ? `${loaded} · ${details.availableCount} available` : loaded;
  return { capability: { status: 'ok', summary }, details };
}

const STT_ENGINES: ReadonlyArray<readonly [SttEngine['name'], string]> = [
  ['transformers', 'Transformers'],
  ['gguf', 'whisper.cpp'],
  ['mtmd', 'llama.cpp'],
];

function classifyStt(
  raw: ProbeRaw,
  issues: ProbeIssue[],
): { capability: Capability; engines: SttEngine[] } {
  const route = raw.routes.stt;
  if (!route) return { capability: NOT_CHECKED, engines: [] };
  if (route.status === 404) {
    issues.push({
      capability: 'stt',
      severity: 'info',
      title: 'This Unsloth version has no speech-to-text API.',
      hint: 'Update Unsloth on that machine to benchmark transcription.',
    });
    return { capability: { status: 'missing', summary: 'Not in this version' }, engines: [] };
  }
  const body = ok200(route);
  if (!body) {
    issues.push({
      capability: 'stt',
      severity: 'warning',
      title: 'Could not read the speech-to-text status.',
      hint: routeProblem(route),
    });
    return { capability: { status: 'error', summary: 'Status failed' }, engines: [] };
  }

  const engines: SttEngine[] = STT_ENGINES.map(([name, label]) => {
    const engine = obj(body[name]);
    const fallback = name === 'transformers';
    return {
      name,
      label,
      available: engine ? engine.available === true : fallback && body.available === true,
      loadedModel: engine ? str(engine.loaded_model) : fallback ? str(body.loaded_model) : null,
    };
  });
  const available = engines.filter((engine) => engine.available);
  if (available.length === 0) {
    issues.push({
      capability: 'stt',
      severity: 'info',
      title: 'No speech-to-text engine is available on this machine.',
      hint: 'Transcription benchmarks need one. Check the speech-to-text setup of Unsloth on that machine.',
    });
    return { capability: { status: 'missing', summary: 'No engine' }, engines };
  }
  if (!engines.some((engine) => engine.name === 'gguf' && engine.available)) {
    issues.push({
      capability: 'stt',
      severity: 'info',
      title: 'whisper.cpp is not installed on this machine.',
      hint: "Whisper then runs on the slower Transformers engine. The whisper.cpp engine needs the whisper-server binary, which Unsloth's scripts/build_whisper_cpp.sh builds.",
    });
  }
  return {
    capability: { status: 'ok', summary: available.map((engine) => engine.label).join(', ') },
    engines,
  };
}

function classifyImage(
  raw: ProbeRaw,
  issues: ProbeIssue[],
): { capability: Capability; details: ProbeReport['image'] } {
  const details: ProbeReport['image'] = { loaded: null, model: null, engine: null, device: null };
  const route = raw.routes.image;
  if (!route) return { capability: NOT_CHECKED, details };
  if (route.status === 404) {
    issues.push({
      capability: 'image',
      severity: 'info',
      title: 'This Unsloth version has no image generation API.',
      hint: 'Update Unsloth on that machine to benchmark image generation.',
    });
    return { capability: { status: 'missing', summary: 'Not in this version' }, details };
  }
  const body = ok200(route);
  if (!body) {
    issues.push({
      capability: 'image',
      severity: 'warning',
      title: 'Could not read the image generation status.',
      hint: routeProblem(route),
    });
    return { capability: { status: 'error', summary: 'Status failed' }, details };
  }
  details.loaded = body.loaded === true;
  details.model = details.loaded ? str(body.repo_id) : null;
  details.engine = str(body.engine);
  details.device = str(body.device);
  const summary = details.loaded
    ? `${details.model ? shortModelName(details.model) : 'A model'} loaded${details.engine ? ` · ${details.engine}` : ''}`
    : 'No model loaded';
  return { capability: { status: 'ok', summary }, details };
}

function classifyTelemetry(
  raw: ProbeRaw,
  issues: ProbeIssue[],
): { capability: Capability; details: ProbeReport['telemetry'] } {
  const details: ProbeReport['telemetry'] = {
    backend: null,
    devices: 0,
    gpuUtilPct: null,
    powerW: null,
    temperatureC: null,
    vramUsedGb: null,
    vramTotalGb: null,
  };
  const route = raw.routes.telemetry;
  if (!route) return { capability: NOT_CHECKED, details };
  if (route.status === 404) {
    issues.push({
      capability: 'telemetry',
      severity: 'info',
      title: 'This Unsloth version has no GPU telemetry route.',
      hint: 'Update Unsloth on that machine to see live GPU readings.',
    });
    return { capability: { status: 'missing', summary: 'Not in this version' }, details };
  }
  const body = ok200(route);
  if (!body) {
    issues.push({
      capability: 'telemetry',
      severity: 'warning',
      title: 'Could not read GPU telemetry.',
      hint: routeProblem(route),
    });
    return { capability: { status: 'error', summary: 'Read failed' }, details };
  }
  const devices = list(body.devices) ?? [];
  const first = obj(devices[0]);
  details.backend = str(body.backend);
  details.devices = devices.length;
  if (body.available !== true || !first) {
    issues.push({
      capability: 'telemetry',
      severity: 'info',
      title: 'No GPU telemetry on this machine.',
      hint: 'Unsloth reports GPU readings for NVIDIA, AMD and Apple Silicon GPUs. A CPU-only machine has none.',
    });
    return { capability: { status: 'missing', summary: 'No GPU' }, details };
  }
  details.gpuUtilPct = num(first.gpu_utilization_pct);
  details.powerW = num(first.power_draw_w);
  details.temperatureC = num(first.temperature_c);
  details.vramUsedGb = num(first.vram_used_gb);
  details.vramTotalGb = num(first.vram_total_gb);
  const parts = [
    details.gpuUtilPct !== null ? `GPU ${Math.round(details.gpuUtilPct)}%` : 'GPU n/a',
    details.powerW !== null ? `${details.powerW.toFixed(1)} W` : 'power n/a',
    details.temperatureC !== null ? `${Math.round(details.temperatureC)} °C` : 'temp n/a',
  ];
  return { capability: { status: 'ok', summary: parts.join(' · ') }, details };
}

function versionsOf(raw: ProbeRaw): ProbeReport['versions'] {
  const health = ok200(raw.routes.health);
  const hardware = ok200(raw.routes.hardware);
  const status = ok200(raw.routes.status);
  const packages = obj(hardware?.versions);
  return {
    unsloth: str(health?.version) ?? str(packages?.unsloth),
    studio: str(health?.studio_version),
    llamaCpp: str(hardware?.llama_cpp) ?? str(status?.llama_cpp_installed_tag),
    torch: str(packages?.torch),
    cuda: str(packages?.cuda),
  };
}

function platformOf(raw: ProbeRaw): ProbeReport['platform'] {
  const health = ok200(raw.routes.health);
  const system = ok200(raw.routes.system);
  const cpu = obj(system?.cpu);
  const memory = obj(system?.memory);
  return {
    os: str(system?.platform),
    deviceType: str(health?.device_type),
    backend: str(system?.device_backend),
    appleSilicon: bool(health?.apple_silicon),
    cpuCores: num(cpu?.logical_count) ?? num(system?.cpu_count),
    memoryTotalGb: num(memory?.total_gb),
  };
}

function gpusOf(raw: ProbeRaw): ProbeReport['gpus'] {
  const hardware = ok200(raw.routes.hardware);
  const system = ok200(raw.routes.system);
  const collect = (
    entries: unknown[] | null,
    memoryKeys: readonly string[],
  ): ProbeReport['gpus'] => {
    const gpus: ProbeReport['gpus'] = [];
    for (const entry of entries ?? []) {
      const gpu = obj(entry);
      if (!gpu) continue;
      const memory = memoryKeys.map((k) => num(gpu[k])).find((v) => v !== null) ?? null;
      gpus.push({ name: str(gpu.name) ?? 'Unknown GPU', memoryGb: memory });
    }
    return gpus;
  };
  const detailed = collect(list(hardware?.gpus), ['vram_total_gb']);
  if (detailed.length > 0) return detailed;
  const visible = collect(list(obj(system?.gpu)?.devices), ['memory_total_gb', 'vram_total_gb']);
  if (visible.length > 0) return visible;
  const summary = obj(hardware?.gpu);
  const name = str(summary?.gpu_name);
  return name ? [{ name, memoryGb: num(summary?.vram_total_gb) }] : [];
}

/** Derives the capability chips, details and plain-language issues from a recorded probe. */
export function classifyProbe(raw: ProbeRaw): ProbeReport {
  const issues: ProbeIssue[] = [];
  const medianMs = median(raw.rttMs);
  const rtt = {
    samplesMs: [...raw.rttMs],
    medianMs,
    minMs: raw.rttMs.length > 0 ? Math.min(...raw.rttMs) : null,
  };

  const reachable = classifyReachable(raw, medianMs, issues);
  const key = reachable.status === 'ok' ? classifyKey(raw, issues) : NOT_CHECKED;
  const keyOk = key.status === 'ok';
  const text = keyOk ? classifyText(raw, issues) : { capability: NOT_CHECKED, details: EMPTY_TEXT };
  const stt = keyOk ? classifyStt(raw, issues) : { capability: NOT_CHECKED, engines: [] };
  const image = keyOk ? classifyImage(raw, issues) : undefined;
  const telemetry = keyOk ? classifyTelemetry(raw, issues) : undefined;

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
      text: text.capability,
      stt: stt.capability,
      image: image?.capability ?? NOT_CHECKED,
      telemetry: telemetry?.capability ?? NOT_CHECKED,
    },
    issues,
    versions: versionsOf(raw),
    platform: platformOf(raw),
    gpus: gpusOf(raw),
    text: { ...text.details },
    stt: { engines: stt.engines },
    image: image?.details ?? { loaded: null, model: null, engine: null, device: null },
    telemetry: telemetry?.details ?? {
      backend: null,
      devices: 0,
      gpuUtilPct: null,
      powerW: null,
      temperatureC: null,
      vramUsedGb: null,
      vramTotalGb: null,
    },
    rtt,
  };
}

export const PROBE_EXPORT_KIND = 'model-duel-probe';

/** The file behind "Export probe". Recorded fixtures use the same format. */
export interface ProbeExport {
  kind: typeof PROBE_EXPORT_KIND;
  schemaVersion: number;
  exportedAt: string;
  app: { name: string; version: string };
  machine: { name: string; baseUrl: string; notes: string; keyConfigured: boolean };
  probedAt: string;
  durationMs: number;
  raw: ProbeRaw;
  report: ProbeReport;
}
