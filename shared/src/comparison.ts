import { metricsFor, type Better, type MetricKind, type MetricUnit } from './compare';
import { formatValue } from './format';
import { KIND_LABELS, runColumns, runMetric, type DeviceRun, type RunColumn } from './runs';
import type { Statistic } from './stats';

// Runs from the Results tab side by side: one column per run, the first run the baseline. Every
// setting that differs from the first run is marked, and every metric gives each run's ratio to
// the first.

/** How many runs a comparison takes. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 6;

/** The setup rows of a comparison, in order, by Results column; a kind without the column skips it. */
const SETUP_ROWS = [
  'machine',
  'gpu',
  'gpuMemory',
  'platform',
  'memory',
  'os',
  'server',
  'studio',
  'llamaCpp',
  'model',
  'quant',
  'engine',
  'context',
  'kvCache',
  'gpuLayers',
  'slots',
  'speculative',
  'gpuMemoryMode',
  'prompt',
  'thinking',
  'maxTokens',
  'prefill',
  'concurrency',
  'settings',
  'rounds',
] as const;

/** The whole prompt where there is one, so two custom prompts that start alike still differ. */
export function requestPrompt(run: DeviceRun): string | null {
  return run.promptText ?? run.prompt;
}

/** What decides whether two runs had the same setting: the shown text, or the whole prompt. */
export function settingOf(column: RunColumn, run: DeviceRun): string | number | null {
  return column.id === 'prompt' ? requestPrompt(run) : column.value(run);
}

const columnCache = new Map<MetricKind, Map<string, RunColumn>>();

/** The Results columns of a kind by id. Setup columns do not depend on median or average. */
export function columnsOf(kind: MetricKind): Map<string, RunColumn> {
  let columns = columnCache.get(kind);
  if (!columns) {
    columns = new Map(runColumns(kind).map((c) => [c.id, c]));
    columnCache.set(kind, columns);
  }
  return columns;
}

/** "a", "a and b", "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Why these runs cannot be compared, in words; null when they can. */
export function cannotCompare(runs: readonly DeviceRun[]): string | null {
  if (runs.length === 0) return `Tick ${COMPARE_MIN} to ${COMPARE_MAX} runs to compare them.`;
  if (runs.length < COMPARE_MIN) return 'Tick at least one more run to compare.';
  if (runs.length > COMPARE_MAX)
    return `Compare at most ${COMPARE_MAX} runs at once; ${runs.length} are ticked.`;
  const kinds = new Map<MetricKind, number>();
  for (const run of runs) kinds.set(run.kind, (kinds.get(run.kind) ?? 0) + 1);
  if (kinds.size > 1) {
    const counts = [...kinds.entries()].map(([kind, n]) => `${n} ${KIND_LABELS[kind]}`);
    return `These runs are of different workloads (${listWords(counts)}), which measure different things. Tick runs of one workload.`;
  }
  return null;
}

/** How a run compares with the first: how many times, and whether that is better. */
export interface Ratio {
  times: number;
  better: boolean;
}

/** `value` against `base`, always 1 or more times; null for a metric without a direction or a zero. */
export function ratioTo(base: number, value: number, better: Better): Ratio | null {
  if (better === null || !(base > 0) || !(value > 0)) return null;
  const up = value / base;
  return { times: up >= 1 ? up : 1 / up, better: better === 'higher' ? up >= 1 : up <= 1 };
}

/** The words for better and worse in a metric's unit: faster times and speeds, less energy. */
export function ratioWords(unit: MetricUnit): readonly [string, string] {
  if (unit === 'J') return ['less energy', 'more energy'];
  if (unit === 'tok/J') return ['more efficient', 'less efficient'];
  if (unit === '%') return ['fewer errors', 'more errors'];
  return ['faster', 'slower'];
}

/** "1.84× faster", "2.10× slower", or "same" within half a percent. */
export function ratioText(ratio: Ratio, unit: MetricUnit): string {
  if (ratio.times < 1.005) return 'same';
  const [up, down] = ratioWords(unit);
  return `${ratio.times.toFixed(ratio.times < 10 ? 2 : 1)}× ${ratio.better ? up : down}`;
}

export interface ComparisonSetupCell {
  text: string;
  /** Not the same as the first run's. */
  differs: boolean;
}

export interface ComparisonSetupRow {
  id: string;
  label: string;
  cells: ComparisonSetupCell[];
  differs: boolean;
}

export interface ComparisonMetricCell {
  value: number | string | null;
  text: string;
  /** The best value of the row, when the runs' values are not all the same. */
  best: boolean;
  /** Against the first run; null for the first run itself and for metrics without a direction. */
  ratio: Ratio | null;
  versus: string | null;
}

export interface ComparisonMetricRow {
  key: string;
  label: string;
  unit: MetricUnit;
  better: Better;
  cells: ComparisonMetricCell[];
}

export interface RunComparison {
  kind: MetricKind;
  statistic: Statistic;
  runs: DeviceRun[];
  setup: ComparisonSetupRow[];
  /** Every metric of the kind that at least one of the runs has. */
  metrics: ComparisonMetricRow[];
  /** What the runs were asked differently, such as "prompt" or "Max tokens"; empty when like for like. */
  requestDiffers: string[];
}

/** What a run was asked to do. When these differ, the numbers differ for more than the hardware. */
const REQUEST: ReadonlyArray<{ label: string; of: (run: DeviceRun) => string | number | null }> = [
  { label: 'prompt', of: requestPrompt },
  { label: 'thinking', of: (r) => r.thinking },
  { label: 'Max tokens', of: (r) => r.maxTokens },
  { label: 'prefill', of: (r) => r.prefill },
  { label: 'requests at once', of: (r) => r.concurrency },
  { label: 'settings', of: (r) => r.settings },
];

/** The parts of the request in which some run differs from the first. */
export function requestDifferences(runs: readonly DeviceRun[]): string[] {
  const first = runs[0];
  if (!first) return [];
  return REQUEST.filter((part) => runs.some((run) => part.of(run) !== part.of(first))).map(
    (part) => part.label,
  );
}

/** The warning a comparison shows when its runs did not answer the same request. */
export function likeForLikeNote(differences: readonly string[]): string | null {
  if (differences.length === 0) return null;
  return `Not like for like: these runs did not answer the same request, since their ${listWords(differences)} ${differences.length === 1 ? 'differs' : 'differ'}. That moves the numbers as much as the hardware does.`;
}

const isNumber = (v: unknown): v is number => typeof v === 'number';

/** The comparison of 2 to 6 runs of one kind, with each metric's median or average. */
export function compareRuns(
  runs: readonly DeviceRun[],
  statistic: Statistic = 'median',
): RunComparison {
  const kind = runs[0]?.kind ?? 'text';
  const columns = columnsOf(kind);
  const first = runs[0];

  const setup: ComparisonSetupRow[] = [];
  for (const id of SETUP_ROWS) {
    const column = columns.get(id);
    if (!column || !first) continue;
    // A row no run has a value for says nothing.
    if (runs.every((run) => column.value(run) === null)) continue;
    const base = settingOf(column, first);
    const cells = runs.map((run, i) => ({
      text: column.text(run),
      differs: i > 0 && settingOf(column, run) !== base,
    }));
    setup.push({ id, label: column.label, cells, differs: cells.some((cell) => cell.differs) });
  }

  const metrics: ComparisonMetricRow[] = [];
  for (const spec of metricsFor(kind)) {
    const values = runs.map((run) => runMetric(run, spec.key, statistic));
    if (values.every((v) => v === null)) continue;
    const numbers = values.filter(isNumber);
    const best =
      spec.better && numbers.length >= 2 && new Set(numbers).size > 1
        ? spec.better === 'lower'
          ? Math.min(...numbers)
          : Math.max(...numbers)
        : null;
    const base = values[0];
    metrics.push({
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      better: spec.better,
      cells: values.map((value, i) => {
        const ratio =
          i > 0 && isNumber(value) && isNumber(base) ? ratioTo(base, value, spec.better) : null;
        return {
          value,
          text: isNumber(value) ? formatValue(value, spec.unit) : (value ?? 'n/a'),
          best: best !== null && value === best,
          ratio,
          versus: ratio ? ratioText(ratio, spec.unit) : null,
        };
      }),
    });
  }

  return {
    kind,
    statistic,
    runs: [...runs],
    setup,
    metrics,
    requestDiffers: requestDifferences(runs),
  };
}

/** What the Results tab's address can open: runs to compare, and a run whose history to show. */
export interface ResultsLink {
  compare: string[];
  history: string | null;
}

// Keys are `sessionId/machineId`; the slash stays readable.
const keyPart = (key: string) => encodeURIComponent(key).replace(/%2F/gi, '/');

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part).trim();
  } catch {
    return '';
  }
}

/** The hash that opens a comparison or a history: `#/results?compare=<key>,<key>&history=<key>`. */
export function resultsLink(link: Partial<ResultsLink>): string {
  const parts: string[] = [];
  if (link.compare && link.compare.length > 0)
    parts.push(`compare=${link.compare.map(keyPart).join(',')}`);
  if (link.history) parts.push(`history=${keyPart(link.history)}`);
  return parts.length > 0 ? `#/results?${parts.join('&')}` : '#/results';
}

/** The comparison and history a Results hash asks for; anything else in it is ignored. */
export function parseResultsLink(hash: string): ResultsLink {
  const link: ResultsLink = { compare: [], history: null };
  const prefix = '#/results?';
  if (!hash.startsWith(prefix)) return link;
  for (const pair of hash.slice(prefix.length).split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name === 'compare')
      link.compare = [...new Set(value.split(',').map(decodePart).filter(Boolean))];
    else if (name === 'history') link.history = decodePart(value) || null;
  }
  return link;
}
