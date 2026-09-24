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
 * A session is one benchmark: the same request on one or more machines, sent together. Phase 4
 * runs one round; the shape already holds many rounds and many machines.
 */
export const SESSION_SCHEMA_VERSION = 1;
export const MAX_RACE_MACHINES = 8;

export const sessionRequestSchema = z.object({
  workload: z.literal('text'),
  machineIds: z
    .array(z.string().min(1))
    .min(1, 'Pick at least one machine.')
    .max(MAX_RACE_MACHINES, `Pick at most ${MAX_RACE_MACHINES} machines.`)
    .refine((ids) => new Set(ids).size === ids.length, 'Pick each machine only once.'),
  config: textConfigSchema,
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

export interface RoundView {
  index: number;
  /** When the requests went out. */
  startedAt: string | null;
  /** Time between the first and the last request leaving the controller. */
  sendSkewMs: number | null;
  /** One run per machine, in the order of `machines`. */
  runs: RunView[];
}

export interface SessionView {
  schemaVersion: number;
  id: string;
  workload: 'text';
  createdAt: string;
  finishedAt: string | null;
  state: SessionState;
  error: string | null;
  config: TextConfig & { sampling: Record<string, number> };
  machines: SessionMachine[];
  rounds: RoundView[];
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
export type StoredSession = Omit<SessionView, 'rounds'> & { rounds: StoredRound[] };

export interface SessionSummary {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  state: SessionState;
  prompt: string;
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
  | { type: 'delta'; round: number; runs: RunDelta[] }
  | { type: 'run'; round: number; run: RunView }
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

/** The view without raw events, as the API sends it. */
export function publicSession(session: StoredSession | SessionView): SessionView {
  return {
    ...session,
    rounds: session.rounds.map((round) => ({
      ...round,
      runs: round.runs.map((run) => publicRun(run)),
    })),
  };
}

export function publicRun(run: RunView | StoredRun): RunView {
  if (!('raw' in run)) return run;
  const { raw: _raw, ...view } = run;
  return view;
}

export function summarizeSession(session: StoredSession | SessionView): SessionSummary {
  const runs = session.rounds[0]?.runs ?? [];
  return {
    id: session.id,
    createdAt: session.createdAt,
    finishedAt: session.finishedAt,
    state: session.state,
    prompt: session.config.prompt.slice(0, 160),
    machines: session.machines.map((machine) => {
      const run = runs.find((r) => r.machineId === machine.id);
      return {
        id: machine.id,
        name: machine.name,
        color: machine.color,
        state: run?.state ?? 'failed',
        firstAnswerMs: run?.client?.firstAnswerMs ?? null,
        decodeTokPerSec: run?.client?.decodeTokPerSec ?? null,
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

/**
 * Differences between the machines of a race that make it compare more than the hardware. None
 * of them blocks a race; the user decides.
 */
export function raceWarnings(
  entries: ReadonlyArray<{ name: string; status: ModelStatus | null }>,
): string[] {
  const loaded = entries.filter(
    (e): e is { name: string; status: ModelStatus } => !!e.status?.activeModel,
  );
  if (loaded.length < 2) return [];
  const warnings: string[] = [];
  const differs = (pick: (s: ModelStatus) => string | null) =>
    new Set(loaded.map((e) => pick(e.status) ?? '')).size > 1;
  const each = (pick: (s: ModelStatus) => string | null) =>
    loaded.map((e) => `${e.name} has ${pick(e.status) ?? 'unknown'}`).join(', ');

  if (differs((s) => s.activeModel)) {
    warnings.push(`The machines run different models: ${each((s) => s.activeModel)}.`);
  } else if (differs((s) => s.quant)) {
    warnings.push(`The machines run different quants: ${each((s) => s.quant)}.`);
  }
  if (differs((s) => s.backend)) {
    warnings.push(`The machines use different backends: ${each((s) => backendLabel(s.backend))}.`);
  }
  const speculative = loaded.filter((e) => speculativeOn(e.status));
  if (speculative.length > 0) {
    const names = speculative.map((e) => e.name).join(' and ');
    warnings.push(
      `Speculative decoding is on for ${names}, so tokens arrive in groups there. Load with speculative decoding off for a like-for-like race.`,
    );
  }
  return warnings;
}
