import type { RunView } from './chat';
import { metricsFor, type Better, type MetricUnit } from './compare';
import type { RoundFlag, SessionView } from './session';

export interface Summary {
  /** Rounds that gave a value. */
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Sample standard deviation; null below two values. */
  stdev: number | null;
}

export function summarize(values: readonly number[]): Summary {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) return { n, median: null, min: null, max: null, mean: null, stdev: null };
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  const mean = finite.reduce((sum, v) => sum + v, 0) / n;
  const stdev =
    n < 2 ? null : Math.sqrt(finite.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1));
  return { n, median, min: sorted[0] ?? null, max: sorted[n - 1] ?? null, mean, stdev };
}

/** A clear winner needs a gap of more than this between the medians. */
export const GATE_RATIO = 1.1;

export interface Verdict {
  /** `none` when fewer than two machines have a value. */
  kind: 'win' | 'tie' | 'none';
  /** Index of the winner, or of the leader in a tie. */
  leader: number | null;
  /** Index of the runner-up. */
  runnerUp: number | null;
  /** Leader's median against the runner-up's, as "times better": always 1 or more. */
  ratio: number | null;
  /** Why it is a win: ranges apart, or the medians more than 10 percent apart. */
  reason: 'ranges' | 'gap' | null;
}

/**
 * The winner gate: the best median wins only when its per-round range does not overlap the
 * runner-up's, or the medians differ by more than 10 percent. Otherwise it is a tie. Ranges
 * need two rounds on both sides; a single round can only win on the gap.
 */
export function gate(summaries: readonly Summary[], better: Better): Verdict {
  const none: Verdict = { kind: 'none', leader: null, runnerUp: null, ratio: null, reason: null };
  if (better === null) return none;
  const ranked = summaries
    .map((summary, index) => ({ summary, index }))
    .filter((entry) => entry.summary.median !== null)
    .sort((a, b) =>
      better === 'lower'
        ? (a.summary.median ?? 0) - (b.summary.median ?? 0)
        : (b.summary.median ?? 0) - (a.summary.median ?? 0),
    );
  const [first, second] = ranked;
  if (!first || !second) return none;
  const a = first.summary;
  const b = second.summary;
  const low = Math.min(Math.abs(a.median ?? 0), Math.abs(b.median ?? 0));
  const high = Math.max(Math.abs(a.median ?? 0), Math.abs(b.median ?? 0));
  const ratio = low === 0 ? (high === 0 ? 1 : Infinity) : high / low;
  const base = { leader: first.index, runnerUp: second.index, ratio };
  if (ratio > GATE_RATIO) return { ...base, kind: 'win', reason: 'gap' };
  const apart =
    a.n >= 2 &&
    b.n >= 2 &&
    (better === 'lower' ? (a.max ?? 0) < (b.min ?? 0) : (a.min ?? 0) > (b.max ?? 0));
  if (apart) return { ...base, kind: 'win', reason: 'ranges' };
  return { ...base, kind: 'tie', reason: null };
}

/**
 * The order machines take in a round when they run one after another: forward, then backward,
 * then forward again, so no machine always goes first. For two machines this is ABBA.
 */
export function abbaOrder<T>(items: readonly T[], roundIndex: number): T[] {
  return roundIndex % 2 === 0 ? [...items] : [...items].reverse();
}

export interface StatRow {
  key: string;
  label: string;
  unit: MetricUnit;
  better: Better;
  /** One summary per machine, in the order of `session.machines`. */
  summaries: Summary[];
  verdict: Verdict;
}

/** The runs of one machine across the counted rounds; the warm-up never counts. */
export function runsOf(session: SessionView, machineId: string): RunView[] {
  return session.rounds
    .map((round) => round.runs.find((run) => run.machineId === machineId))
    .filter((run): run is RunView => !!run);
}

/** Per metric and machine, over the rounds that finished. Failed rounds do not count. */
export function sessionStats(session: SessionView): StatRow[] {
  return metricsFor(session.workload).map((metric) => {
    const summaries = session.machines.map((machine) =>
      summarize(
        runsOf(session, machine.id)
          .filter((run) => run.state === 'done')
          .map((run) => metric.pick(run))
          .filter((v): v is number => typeof v === 'number'),
      ),
    );
    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      better: metric.better,
      summaries,
      verdict: gate(summaries, metric.better),
    };
  });
}

/** Share of chunks that arrived together with the previous one, above which a run is flagged. */
export const COALESCED_LIMIT = 0.3;
/** Event-loop delay above which a round's timings are flagged. */
export const LAG_LIMIT_MS = 50;
/** Cached prompt tokens above which a run counts as a cache hit; chat templates stay below it. */
export const CACHE_HIT_TOKENS = 64;

/** Cached prompt tokens of a run, from usage or from the timings. */
export function cachedTokensOf(run: RunView): number {
  return run.client?.cachedTokens ?? run.server?.timings?.cacheN ?? 0;
}

/** What makes a round's numbers less trustworthy, or not like for like. */
export function roundFlags(
  runs: readonly RunView[],
  names: ReadonlyMap<string, string>,
  loopLagMs: { max: number } | null,
  options: { fixedLength?: boolean; cacheThreshold?: number } = {},
): RoundFlag[] {
  const flags: RoundFlag[] = [];
  if (loopLagMs && loopLagMs.max > LAG_LIMIT_MS) {
    flags.push({
      machineId: null,
      kind: 'lag',
      text: `The controller was busy: its event loop ran up to ${Math.round(loopLagMs.max)} ms late.`,
    });
  }
  for (const run of runs) {
    const name = names.get(run.machineId) ?? run.machineName;
    if (run.state === 'failed') {
      flags.push({ machineId: run.machineId, kind: 'failed', text: `${name} failed.` });
    }
    const c = run.client;
    if (c?.truncated) {
      flags.push({
        machineId: run.machineId,
        kind: 'truncated',
        text: `Unsloth cut the prompt on ${name} to fit its context.`,
      });
    }
    const cached = cachedTokensOf(run);
    if (cached > (options.cacheThreshold ?? CACHE_HIT_TOKENS)) {
      flags.push({
        machineId: run.machineId,
        kind: 'cache',
        text: `${name} reused ${cached.toLocaleString('en-US')} cached prompt tokens, so its first token came early.`,
      });
    }
    if (run.state === 'done' && c) {
      if (options.fixedLength && c.finishReason !== 'length') {
        flags.push({
          machineId: run.machineId,
          kind: 'length',
          text: `${name} stopped before Max tokens (${c.finishReason ?? 'no reason'}), so its output length differs.`,
        });
      } else if (!options.fixedLength && c.finishReason === 'length') {
        flags.push({
          machineId: run.machineId,
          kind: 'length',
          text: `${name} stopped at Max tokens.`,
        });
      }
    }
    if (c && c.chunks >= 10 && c.coalescedChunks / c.chunks > COALESCED_LIMIT) {
      flags.push({
        machineId: run.machineId,
        kind: 'coalesced',
        text: `${Math.round((c.coalescedChunks / c.chunks) * 100)} percent of ${name}'s chunks arrived together, so its gaps are unreliable.`,
      });
    }
  }
  return flags;
}
