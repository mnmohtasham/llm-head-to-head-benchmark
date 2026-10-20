import {
  metricsFor,
  SERVER_METRICS,
  type Better,
  type MetricKind,
  type MetricUnit,
} from './compare';
import { columnsOf, ratioWords, requestPrompt, settingOf } from './comparison';
import { formatValue } from './format';
import { runMetric, shortDate, type DeviceRun } from './runs';
import type { Statistic } from './stats';

// The history of one machine with one model: its runs over time, the headline numbers of each,
// and what changed between one run and the next, so a slowdown after an update stands out.

/** The numbers a history follows, by the key of Model Duel's own measurement. */
export const HISTORY_METRICS: Readonly<Record<MetricKind, readonly string[]>> = {
  text: ['decode', 'ttft'],
  throughput: ['aggregate', 'ttftMedian'],
  transcribe: ['rtf'],
  image: ['stepsPerSec'],
};

/** Which runs of the machine and model count; each narrows the history to what the first run was asked. */
export interface HistoryFilter {
  /** The same prompt; for transcription and image races, the same settings. */
  samePrompt: boolean;
  sameThinking: boolean;
  /** Throughput only: the same number of requests at once. */
  sameConcurrency: boolean;
}

export const DEFAULT_HISTORY_FILTER: HistoryFilter = {
  samePrompt: true,
  sameThinking: true,
  sameConcurrency: true,
};

const FINISHED = new Set<DeviceRun['state']>(['done', 'partial']);

/** Whether `run` belongs in the history of `anchor`: the same machine, model, quant and engine. */
export function inHistoryOf(anchor: DeviceRun, run: DeviceRun, filter: HistoryFilter): boolean {
  return (
    run.machineId === anchor.machineId &&
    run.kind === anchor.kind &&
    run.model === anchor.model &&
    run.quant === anchor.quant &&
    run.engine === anchor.engine &&
    (!filter.samePrompt ||
      (requestPrompt(run) === requestPrompt(anchor) && run.settings === anchor.settings)) &&
    (!filter.sameThinking || run.thinking === anchor.thinking) &&
    (!filter.sameConcurrency || run.concurrency === anchor.concurrency)
  );
}

export type HistorySource = 'server' | 'measured';

export interface HistoryPoint {
  /** The server's own number where the run has it, Model Duel's measurement otherwise. */
  value: number | null;
  source: HistorySource | null;
  server: number | null;
  measured: number | null;
}

export interface HistorySummary {
  /** Which numbers the latest and the best were compared on. */
  basis: HistorySource;
  /** Indexes into the history's runs. */
  latest: number;
  best: number;
  latestValue: number;
  bestValue: number;
  /** How far the latest is from the best, in percent of the best; 0 when it is the best. */
  percent: number | null;
  text: string;
}

export interface HistorySeries {
  key: string;
  /** The key of the server's own number for the same measurement, if there is one. */
  serverKey: string | null;
  label: string;
  unit: MetricUnit;
  better: Better;
  /** One per run of the history, in the same order. */
  points: HistoryPoint[];
  /** Null with fewer than two numbers to compare. */
  summary: HistorySummary | null;
}

export interface HistoryChange {
  /** The run that came with the change, an index into the history's runs; never 0. */
  index: number;
  field: string;
  label: string;
  from: string;
  to: string;
  /** "llama.cpp b9601 → b9650 on 2026-10-02". */
  text: string;
}

export interface RunHistory {
  anchor: DeviceRun;
  /** Finished runs, oldest first. */
  runs: DeviceRun[];
  series: HistorySeries[];
  changes: HistoryChange[];
}

/**
 * Settings whose change between two runs is worth a mark: versions, hardware, how the model was
 * loaded, and what it was asked when the history is not narrowed to one request.
 */
const CHANGE_FIELDS = [
  'studio',
  'llamaCpp',
  'os',
  'gpu',
  'platform',
  'gpuMemoryMode',
  'kvCache',
  'context',
  'gpuLayers',
  'slots',
  'speculative',
  'prompt',
  'thinking',
  'maxTokens',
  'prefill',
  'concurrency',
  'settings',
] as const;

/** The day of a race, YYYY-MM-DD in local time. */
export const raceDay = (iso: string) => shortDate(iso).slice(0, 10);

/**
 * What changed from one run to the next. A setting one of them does not know, such as a version
 * from a machine that was never probed, is left out: it may not have changed.
 */
export function runChanges(
  previous: DeviceRun,
  next: DeviceRun,
): Array<{ field: string; label: string; from: string; to: string }> {
  const columns = columnsOf(next.kind);
  const out: Array<{ field: string; label: string; from: string; to: string }> = [];
  for (const id of CHANGE_FIELDS) {
    const column = columns.get(id);
    if (!column) continue;
    const before = settingOf(column, previous);
    const after = settingOf(column, next);
    if (before === null || after === null || before === after) continue;
    out.push({
      field: id,
      label: column.label,
      from: column.text(previous),
      to: column.text(next),
    });
  }
  return out;
}

const percentText = (p: number) => (p < 10 ? p.toFixed(1) : String(Math.round(p)));

function summarize(
  points: readonly HistoryPoint[],
  runs: readonly DeviceRun[],
  spec: { unit: MetricUnit; better: Better },
  hasServer: boolean,
): HistorySummary | null {
  const { unit, better } = spec;
  if (better === null) return null;
  // Like the headlines: the servers' numbers only when every run has one.
  const basis: HistorySource =
    hasServer && points.every((p) => p.value === null || p.server !== null) ? 'server' : 'measured';
  const values = points
    .map((p, index) => ({ index, value: basis === 'server' ? p.server : p.measured }))
    .filter((p): p is { index: number; value: number } => p.value !== null);
  const latest = values[values.length - 1];
  if (!latest || values.length < 2) return null;
  let best = latest;
  for (const p of values) {
    if (better === 'higher' ? p.value > best.value : p.value < best.value) best = p;
  }
  const day = (index: number) => raceDay(runs[index]?.createdAt ?? '');
  const percent =
    best.value === 0 ? null : (Math.abs(latest.value - best.value) / Math.abs(best.value)) * 100;
  const shown = `Latest ${formatValue(latest.value, unit)} on ${day(latest.index)}`;
  const versus =
    latest.value === best.value
      ? `${shown} is the best of ${values.length} runs.`
      : `${shown} is ${percent === null ? 'worse' : `${percentText(percent)}% ${ratioWords(unit)[1]}`} than the best, ${formatValue(best.value, unit)} on ${day(best.index)}.`;
  const source = !hasServer
    ? ''
    : basis === 'server'
      ? ' Both are the servers’ own numbers.'
      : ' Both are Model Duel’s measurements, since not every run has the server’s number.';
  return {
    basis,
    latest: latest.index,
    best: best.index,
    latestValue: latest.value,
    bestValue: best.value,
    percent: latest.value === best.value ? 0 : percent,
    text: `${versus}${source}`,
  };
}

const asNumber = (v: number | string | null) => (typeof v === 'number' ? v : null);

/**
 * The history of `anchor`'s machine with its model, quant and engine, from every run given:
 * finished runs only, oldest first, with the median or average of each headline number.
 */
export function runHistory(
  all: readonly DeviceRun[],
  anchor: DeviceRun,
  filter: HistoryFilter = DEFAULT_HISTORY_FILTER,
  statistic: Statistic = 'median',
): RunHistory {
  const runs = all
    .filter((run) => FINISHED.has(run.state) && inHistoryOf(anchor, run, filter))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));

  const series: HistorySeries[] = [];
  for (const key of HISTORY_METRICS[anchor.kind]) {
    const spec = metricsFor(anchor.kind).find((m) => m.key === key);
    if (!spec) continue;
    const serverKey = SERVER_METRICS[key] ?? null;
    const points = runs.map((run): HistoryPoint => {
      const server = serverKey ? asNumber(runMetric(run, serverKey, statistic)) : null;
      const measured = asNumber(runMetric(run, key, statistic));
      return {
        value: server ?? measured,
        source: server !== null ? 'server' : measured !== null ? 'measured' : null,
        server,
        measured,
      };
    });
    series.push({
      key,
      serverKey,
      label: spec.label,
      unit: spec.unit,
      better: spec.better,
      points,
      summary: summarize(points, runs, spec, serverKey !== null),
    });
  }

  const changes: HistoryChange[] = [];
  runs.forEach((run, index) => {
    const previous = runs[index - 1];
    if (!previous) return;
    for (const change of runChanges(previous, run)) {
      changes.push({
        ...change,
        index,
        text: `${change.label} ${change.from} → ${change.to} on ${raceDay(run.createdAt)}`,
      });
    }
  });

  return { anchor, runs, series, changes };
}
