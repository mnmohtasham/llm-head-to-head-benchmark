/**
 * Live hardware readings from Unsloth's own routes, and what a run cost in energy. Every derived
 * number is approximate: board power on NVIDIA, the GPU rail on Apple, sampled twice a second.
 */

export interface TelemetrySample {
  /** When the reading was taken: the middle of the request, on the controller's clock, epoch ms. */
  at: number;
  gpuUtilPct: number | null;
  gpuPowerW: number | null;
  gpuTempC: number | null;
  /** Only on GPUs with their own memory; null on Apple's unified memory. */
  vramUsedGb: number | null;
  vramTotalGb: number | null;
  cpuPct: number | null;
  ramUsedGb: number | null;
  ramTotalGb: number | null;
}

export type TelemetryState = 'off' | 'waiting' | 'ok' | 'backoff';

export interface TelemetryStatus {
  machineId: string;
  state: TelemetryState;
  /** Why the last poll failed, while backing off. */
  error: string | null;
  /** When the next attempt is due, while backing off. */
  retryInMs: number | null;
  latest: TelemetrySample | null;
}

/** Messages on the controller-to-browser telemetry stream. */
export type TelemetryStreamMessage =
  | { type: 'status'; enabled: boolean; statuses: TelemetryStatus[] }
  | { type: 'sample'; machineId: string; sample: TelemetrySample };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const sum = (values: Array<number | null>): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
};
const max = (values: Array<number | null>): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : Math.max(...present);
};

/**
 * One sample from `/api/train/hardware` and `/api/system`; either may be missing. Several GPUs
 * add up their power and memory, and report the busiest and hottest.
 */
export function parseTelemetry(hardware: unknown, system: unknown, at: number): TelemetrySample {
  const hw = obj(hardware);
  const devices = (Array.isArray(hw?.devices) ? hw.devices : hw ? [hw] : [])
    .map(obj)
    .filter((d): d is Json => d !== null && d.available !== false);
  const unified = ['mps', 'mlx', 'metal'].includes(String(hw?.backend ?? '').toLowerCase());
  const sys = obj(system);
  const cpu = obj(sys?.cpu);
  const memory = obj(sys?.memory);
  const ramTotal = num(memory?.total_gb);
  const ramAvailable = num(memory?.available_gb);
  return {
    at,
    gpuUtilPct: max(devices.map((d) => num(d.gpu_utilization_pct))),
    gpuPowerW: sum(devices.map((d) => num(d.power_draw_w))),
    gpuTempC: max(devices.map((d) => num(d.temperature_c))),
    vramUsedGb: unified ? null : sum(devices.map((d) => num(d.vram_used_gb))),
    vramTotalGb: unified ? null : sum(devices.map((d) => num(d.vram_total_gb))),
    cpuPct: num(cpu?.usage_percent),
    ramUsedGb: ramTotal !== null && ramAvailable !== null ? ramTotal - ramAvailable : null,
    ramTotalGb: ramTotal,
  };
}

/** Power samples further apart than this are not joined: the gap is left out, not guessed. */
export const MAX_GAP_MS = 2000;

/**
 * Energy between two moments, by the trapezoid rule over the power samples, with the edges
 * interpolated. Pairs with a null reading or a gap over `maxGapMs` are skipped, and `coveredMs`
 * says how much of the interval the result stands for.
 */
export function integratePower(
  samples: ReadonlyArray<{ at: number; watts: number | null }>,
  from: number,
  to: number,
  maxGapMs = MAX_GAP_MS,
): { joules: number; coveredMs: number } {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  let joules = 0;
  let coveredMs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (!a || !b || a.watts === null || b.watts === null) continue;
    if (b.at - a.at > maxGapMs || b.at <= a.at) continue;
    const start = Math.max(a.at, from);
    const end = Math.min(b.at, to);
    if (end <= start) continue;
    const at = (t: number) =>
      (a.watts ?? 0) + ((b.watts ?? 0) - (a.watts ?? 0)) * ((t - a.at) / (b.at - a.at));
    joules += ((at(start) + at(end)) / 2) * ((end - start) / 1000);
    coveredMs += end - start;
  }
  return { joules, coveredMs };
}

/** Moments of a run on the controller's clock, epoch ms. */
export interface RunPhases {
  start: number;
  firstToken: number | null;
  lastToken: number | null;
  end: number;
}

export interface RunEnergy {
  /** Samples inside the run itself, baseline excluded. */
  samples: number;
  /** Energy from request to end, or null when under half the run had power readings. */
  energyJ: number | null;
  /** Energy between the first and the last token. */
  decodeEnergyJ: number | null;
  meanDecodePowerW: number | null;
  tokensPerJoule: number | null;
  /** Share of the run the energy stands for. */
  coverage: number;
  peakGpuPct: number | null;
  peakPowerW: number | null;
  peakTempC: number | null;
  peakVramGb: number | null;
  peakRamGb: number | null;
}

/** Below this share of a run covered by power readings, its energy is not reported. */
export const MIN_COVERAGE = 0.5;

/** Energy, power and peaks for one run, from the samples around it. */
export function runEnergy(
  samples: readonly TelemetrySample[],
  phases: RunPhases,
  outputTokens: number | null,
): RunEnergy {
  const power = samples.map((s) => ({ at: s.at, watts: s.gpuPowerW }));
  const inside = samples.filter((s) => s.at >= phases.start && s.at <= phases.end);
  const whole = integratePower(power, phases.start, phases.end);
  const duration = phases.end - phases.start;
  const coverage = duration > 0 ? whole.coveredMs / duration : 0;
  const energyJ = coverage >= MIN_COVERAGE ? whole.joules : null;
  let decodeEnergyJ: number | null = null;
  let meanDecodePowerW: number | null = null;
  if (
    phases.firstToken !== null &&
    phases.lastToken !== null &&
    phases.lastToken > phases.firstToken
  ) {
    const decode = integratePower(power, phases.firstToken, phases.lastToken);
    const span = phases.lastToken - phases.firstToken;
    if (decode.coveredMs / span >= MIN_COVERAGE) {
      decodeEnergyJ = decode.joules;
      meanDecodePowerW = decode.joules / (decode.coveredMs / 1000);
    }
  }
  const peak = (pick: (s: TelemetrySample) => number | null) => max(inside.map(pick));
  return {
    samples: inside.length,
    energyJ,
    decodeEnergyJ,
    meanDecodePowerW,
    tokensPerJoule: energyJ && outputTokens ? outputTokens / energyJ : null,
    coverage,
    peakGpuPct: peak((s) => s.gpuUtilPct),
    peakPowerW: peak((s) => s.gpuPowerW),
    peakTempC: peak((s) => s.gpuTempC),
    peakVramGb: peak((s) => s.vramUsedGb),
    peakRamGb: peak((s) => s.ramUsedGb),
  };
}
