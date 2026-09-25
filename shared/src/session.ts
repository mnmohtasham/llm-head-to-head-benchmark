import { z } from 'zod';
import {
  textConfigSchema,
  type ChatEvent,
  type LiveMetrics,
  type RunState,
  type RunView,
  type TextConfig,
  type TimedEvent,
} from './chat';
import type { ModelStatus } from './models';

/**
 * A session is one benchmark: the same request on one or more machines, over one or more rounds.
 * Version 2 added the run plan, the warm-up and per-round RTT; version 3 the preset, prefill mode,
 * full sampling and per-round nonce; version 4 telemetry. Older files are migrated on read.
 */
export const SESSION_SCHEMA_VERSION = 4;
export const MAX_RACE_MACHINES = 8;
export const MAX_ROUNDS = 10;

/** How a session runs: rounds, warm-up, pause between rounds, and whether machines take turns. */
export const runPlanSchema = z.object({
  rounds: z
    .number()
    .int('Use a whole number of rounds.')
    .min(1, 'Run at least 1 round.')
    .max(MAX_ROUNDS, `Run at most ${MAX_ROUNDS} rounds.`)
    .default(3),
  warmup: z.boolean().default(true),
  settleMs: z
    .number()
    .int()
    .min(0, 'The pause cannot be negative.')
    .max(60_000, 'Pause at most 60 seconds between rounds.')
    .default(2000),
  /** `sequential` runs one machine at a time, in ABBA order. */
  sequencing: z.enum(['concurrent', 'sequential']).default('concurrent'),
});
export type RunPlan = z.infer<typeof runPlanSchema>;
export const DEFAULT_PLAN: RunPlan = runPlanSchema.parse({});

export const sessionRequestSchema = z.object({
  workload: z.literal('text'),
  machineIds: z
    .array(z.string().min(1))
    .min(1, 'Pick at least one machine.')
    .max(MAX_RACE_MACHINES, `Pick at most ${MAX_RACE_MACHINES} machines.`)
    .refine((ids) => new Set(ids).size === ids.length, 'Pick each machine only once.'),
  config: textConfigSchema,
  plan: runPlanSchema.prefault({}),
  /** Start even though pre-flight has warnings; errors can never be overridden. */
  acknowledgeWarnings: z.boolean().default(false),
});
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

export type SessionState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** A machine as it was when the session ran, so a later rename or delete does not rewrite it. */
export interface SessionMachine {
  id: string;
  name: string;
  color: string;
  baseUrl: string;
  notes: string;
}

/** What each machine was running, recorded with the results. Never holds an API key. */
export interface MachineProvenance {
  machineId: string;
  probedAt: string | null;
  versions: { unsloth: string | null; studio: string | null; llamaCpp: string | null };
  platform: { os: string | null; backend: string | null; memoryTotalGb: number | null };
  gpus: Array<{ name: string; memoryGb: number | null }>;
  statusBefore: ModelStatus | null;
  statusAfter: ModelStatus | null;
  /** The exact body sent to Unsloth. */
  request: Record<string, unknown> | null;
}

export interface RoundFlag {
  /** The machine it concerns, or null for the whole round. */
  machineId: string | null;
  kind: 'lag' | 'coalesced' | 'failed' | 'cache' | 'length' | 'truncated';
  text: string;
}

export interface RoundView {
  index: number;
  /** When the requests went out. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Time between the first and the last request leaving the controller; null when sequential. */
  sendSkewMs: number | null;
  /** Machine ids in the order their requests went out. */
  order: string[];
  /** The line that started this round's prompt with cold prefill; null with warm. */
  nonce: string | null;
  /** One run per machine, in the order of `machines`. */
  runs: RunView[];
  /** Controller event-loop delay during the round. */
  loopLagMs: { max: number; p99: number } | null;
  flags: RoundFlag[];
}

export type SessionPhase =
  'preparing' | 'baseline' | 'warmup' | 'rtt' | 'running' | 'settling' | 'finished';

export interface SessionProgress {
  phase: SessionPhase;
  /** Index of the round the phase belongs to. */
  round: number | null;
}

export interface SessionView {
  schemaVersion: number;
  id: string;
  workload: 'text';
  createdAt: string;
  finishedAt: string | null;
  state: SessionState;
  error: string | null;
  config: TextConfig;
  plan: RunPlan;
  machines: SessionMachine[];
  /** The discarded warm-up round, if the plan has one. */
  warmup: RoundView | null;
  rounds: RoundView[];
  progress: SessionProgress;
  /** Whether hardware was polled during the session. */
  telemetry: { enabled: boolean };
  provenance: MachineProvenance[];
  loopLagMs: { max: number; p99: number } | null;
}

/**
 * Raw events in a compact form: `[t, read, 'r' | 'c', text]` for thinking and answer tokens,
 * `[t, read, event]` for everything else. Times are milliseconds from the run's request.
 */
export type CompactEvent = [number, number, 'r' | 'c', string] | [number, number, ChatEvent];

export interface RawRun {
  headersAtMs: number | null;
  endAtMs: number;
  events: CompactEvent[];
}

export type StoredRun = RunView & { raw: RawRun | null };
export type StoredRound = Omit<RoundView, 'runs'> & { runs: StoredRun[] };
/** The file `data/sessions/<id>.json`: the view plus every run's raw events. */
export type StoredSession = Omit<SessionView, 'rounds' | 'warmup'> & {
  rounds: StoredRound[];
  warmup: StoredRound | null;
};

export interface SessionSummary {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  state: SessionState;
  prompt: string;
  rounds: number;
  machines: Array<{
    id: string;
    name: string;
    color: string;
    state: RunState;
    firstAnswerMs: number | null;
    decodeTokPerSec: number | null;
  }>;
}

export interface RunDelta {
  machineId: string;
  state: RunState;
  reasoning: string;
  answer: string;
  live: LiveMetrics;
}

/** Messages on the controller-to-browser event stream of a session. */
export type SessionStreamMessage =
  | { type: 'snapshot'; session: SessionView }
  | { type: 'progress'; progress: SessionProgress }
  | { type: 'round'; warmup: boolean; round: RoundView }
  | { type: 'delta'; warmup: boolean; round: number; runs: RunDelta[] }
  | { type: 'run'; warmup: boolean; round: number; run: RunView }
  | { type: 'finished'; session: SessionView };

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function compactEvents(events: readonly TimedEvent[], requestAt: number): CompactEvent[] {
  return events.map(({ t, read, event }) => {
    const at = round3(t - requestAt);
    if (event.type === 'reasoning') return [at, read, 'r', event.text];
    if (event.type === 'content') return [at, read, 'c', event.text];
    return [at, read, event];
  });
}

export function expandEvents(events: readonly CompactEvent[]): TimedEvent[] {
  return events.map((entry) => {
    if (entry.length === 4) {
      const [t, read, kind, text] = entry;
      return {
        t,
        read,
        event: kind === 'r' ? { type: 'reasoning', text } : { type: 'content', text },
      };
    }
    const [t, read, event] = entry;
    return { t, read, event };
  });
}

function publicRound(round: StoredRound | RoundView): RoundView {
  return { ...round, runs: round.runs.map((run) => publicRun(run)) };
}

/** The view without raw events, as the API sends it. */
export function publicSession(session: StoredSession | SessionView): SessionView {
  return {
    ...session,
    warmup: session.warmup ? publicRound(session.warmup) : null,
    rounds: session.rounds.map((round) => publicRound(round)),
  };
}

/**
 * Brings a stored session of any earlier schema up to the current one. Version 1 had one round,
 * no plan, no warm-up and no RTT. Versions 1 and 2 sent the same prompt every round without a seed,
 * which is warm prefill, with four sampling fields.
 */
export function migrateSession(value: StoredSession): StoredSession {
  if (value.schemaVersion >= SESSION_SCHEMA_VERSION) return value;
  const old = value as Partial<StoredSession>;
  const oldSampling = (old.config?.sampling ?? {}) as unknown as Record<string, number | undefined>;
  const round = (r: StoredRound): StoredRound => ({
    ...r,
    finishedAt: r.finishedAt ?? null,
    order: r.order ?? r.runs.map((run) => run.machineId),
    nonce: r.nonce ?? null,
    loopLagMs: r.loopLagMs ?? value.loopLagMs ?? null,
    flags: r.flags ?? [],
    runs: r.runs.map((run) => ({ ...run, rtt: run.rtt ?? null, telemetry: run.telemetry ?? null })),
  });
  return {
    ...value,
    schemaVersion: SESSION_SCHEMA_VERSION,
    config: {
      ...value.config,
      preset: value.config.preset ?? 'custom',
      prefill: value.config.prefill ?? 'warm',
      sampling: {
        temperature: oldSampling.temperature ?? 0.6,
        topP: oldSampling.topP ?? oldSampling.top_p ?? 0.95,
        topK: oldSampling.topK ?? oldSampling.top_k ?? 20,
        minP: oldSampling.minP ?? oldSampling.min_p ?? 0,
        repetitionPenalty: oldSampling.repetitionPenalty ?? 1,
        seed: oldSampling.seed ?? 42,
      },
    },
    plan: old.plan ?? { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' },
    warmup: old.warmup ? round(old.warmup) : null,
    progress: old.progress ?? { phase: 'finished', round: null },
    telemetry: old.telemetry ?? { enabled: false },
    rounds: (old.rounds ?? []).map(round),
  };
}

export function publicRun(run: RunView | StoredRun): RunView {
  if (!('raw' in run)) return run;
  const { raw: _raw, ...view } = run;
  return view;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** One line per machine for the results log: medians over the rounds that finished. */
export function summarizeSession(session: StoredSession | SessionView): SessionSummary {
  return {
    id: session.id,
    createdAt: session.createdAt,
    finishedAt: session.finishedAt,
    state: session.state,
    prompt: session.config.prompt.slice(0, 160),
    rounds: session.rounds.length,
    machines: session.machines.map((machine) => {
      const runs = session.rounds
        .map((round) => round.runs.find((r) => r.machineId === machine.id))
        .filter((run): run is RunView => !!run);
      const done = runs.filter((run) => run.state === 'done');
      const pick = (get: (run: RunView) => number | null | undefined) =>
        medianOf(done.map(get).filter((v): v is number => typeof v === 'number'));
      const last = runs[runs.length - 1];
      return {
        id: machine.id,
        name: machine.name,
        color: machine.color,
        state: done.length > 0 ? 'done' : (last?.state ?? 'failed'),
        firstAnswerMs: pick((run) => run.client?.firstAnswerMs),
        decodeTokPerSec: pick((run) => run.client?.decodeTokPerSec),
      };
    }),
  };
}

/** True when a speculative method is set and did not fall back to plain decoding. */
export function speculativeOn(status: ModelStatus | null): boolean {
  const type = status?.speculativeType?.toLowerCase() ?? null;
  if (type === null || type === 'off' || type === 'none' || type === '') return false;
  return !status?.specFallbackReason;
}

export function backendLabel(backend: ModelStatus['backend']): string {
  if (backend === 'gguf') return 'GGUF';
  if (backend === 'mlx') return 'MLX';
  return backend ?? 'unknown';
}
