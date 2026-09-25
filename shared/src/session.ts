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
import { labelVotes, type LabeledVote } from './blind';
import type { ModelStatus } from './models';
import {
  LIBRISPEECH_CLIP,
  repeatsFor,
  transcribeConfigSchema,
  type SttStatus,
  type TranscribeConfig,
} from './transcribe';
import { imageConfigSchema, imagePrompt, type ImageConfig, type ImageStatus } from './images';

/**
 * A session is one benchmark: the same request on one or more machines, over one or more rounds.
 * Version 2 added the run plan, the warm-up and per-round RTT; version 3 the preset, prefill mode,
 * full sampling and per-round nonce; version 4 telemetry; version 5 blind votes and each run's
 * token timeline; version 6 the transcription workload; version 7 the image workload. Older files
 * are migrated on read.
 */
export const SESSION_SCHEMA_VERSION = 7;
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

const sessionRequestBase = {
  machineIds: z
    .array(z.string().min(1))
    .min(1, 'Pick at least one machine.')
    .max(MAX_RACE_MACHINES, `Pick at most ${MAX_RACE_MACHINES} machines.`)
    .refine((ids) => new Set(ids).size === ids.length, 'Pick each machine only once.'),
  plan: runPlanSchema.prefault({}),
  /** Start even though pre-flight has warnings; errors can never be overridden. */
  acknowledgeWarnings: z.boolean().default(false),
};

/** Requests from before transcription had no workload, and were text. */
const textByDefault = (value: unknown) =>
  value !== null && typeof value === 'object' && !('workload' in value)
    ? { ...value, workload: 'text' }
    : value;

export const sessionRequestSchema = z.preprocess(
  textByDefault,
  z.discriminatedUnion('workload', [
    z.object({ workload: z.literal('text'), config: textConfigSchema, ...sessionRequestBase }),
    z.object({
      workload: z.literal('transcribe'),
      config: transcribeConfigSchema,
      ...sessionRequestBase,
    }),
    z.object({ workload: z.literal('image'), config: imageConfigSchema, ...sessionRequestBase }),
  ]),
);

/** The fairness checks for a race that has not started. */
export const preflightRequestSchema = z.preprocess(
  textByDefault,
  z.discriminatedUnion('workload', [
    z.object({
      workload: z.literal('text'),
      machineIds: sessionRequestBase.machineIds,
      config: textConfigSchema,
    }),
    z.object({
      workload: z.literal('transcribe'),
      machineIds: sessionRequestBase.machineIds,
      config: transcribeConfigSchema,
    }),
    z.object({
      workload: z.literal('image'),
      machineIds: sessionRequestBase.machineIds,
      config: imageConfigSchema,
    }),
  ]),
);
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;
export type SessionRequest = z.infer<typeof sessionRequestSchema>;
export type Workload = SessionRequest['workload'];

/** A workload and its settings; the rest of a session is the same for every workload. */
export type WorkloadConfig =
  | { workload: 'text'; config: TextConfig }
  | { workload: 'transcribe'; config: TranscribeConfig }
  | { workload: 'image'; config: ImageConfig };

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
  /** The exact body sent to Unsloth; for transcription, the form fields without the file. */
  request: Record<string, unknown> | null;
  /** Speech-to-text status before and after, for transcription sessions. */
  sttBefore: SttStatus | null;
  sttAfter: SttStatus | null;
  /** Image model status before and after, for image sessions. */
  imageBefore: ImageStatus | null;
  imageAfter: ImageStatus | null;
  /** The chat model the image load pushed out, and whether it came back after the race. */
  restore: RestoreOutcome | null;
}

export interface RestoreOutcome {
  model: string;
  quant: string | null;
  state: 'loaded' | 'failed' | 'skipped';
  error: string | null;
  durationMs: number | null;
}

/** A blind vote on one round's two answers; the machines were hidden until it was cast. */
export interface Vote {
  round: number;
  /** Machine ids as the two answers were shown, left and right. */
  left: string;
  right: string;
  choice: 'left' | 'right' | 'tie';
  at: string;
}

export interface RoundFlag {
  /** The machine it concerns, or null for the whole round. */
  machineId: string | null;
  kind: 'lag' | 'coalesced' | 'failed' | 'cache' | 'length' | 'truncated' | 'split';
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
  | 'preparing'
  | 'baseline'
  | 'loading'
  | 'restoring'
  | 'warmup'
  | 'rtt'
  | 'running'
  | 'settling'
  | 'finished';

export interface SessionProgress {
  phase: SessionPhase;
  /** Index of the round the phase belongs to. */
  round: number | null;
}

interface SessionCommon<Round> {
  schemaVersion: number;
  id: string;
  createdAt: string;
  finishedAt: string | null;
  state: SessionState;
  error: string | null;
  plan: RunPlan;
  machines: SessionMachine[];
  /** The discarded warm-up round, if the plan has one. */
  warmup: Round | null;
  rounds: Round[];
  progress: SessionProgress;
  /** Whether hardware was polled during the session. */
  telemetry: { enabled: boolean };
  /** Blind votes on the answers, one per round at most. */
  votes: Vote[];
  provenance: MachineProvenance[];
  loopLagMs: { max: number; p99: number } | null;
}

export type SessionView = SessionCommon<RoundView> & WorkloadConfig;

export function isTextSession<S extends WorkloadConfig>(
  session: S,
): session is S & { workload: 'text'; config: TextConfig } {
  return session.workload === 'text';
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
export type StoredSession = SessionCommon<StoredRound> & WorkloadConfig;

export interface SessionSummary {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  state: SessionState;
  workload: Workload;
  /** The prompt, or a line about the audio and model. */
  prompt: string;
  rounds: number;
  /** Blind votes cast on this session, with the models named. */
  votes: LabeledVote[];
  machines: Array<{
    id: string;
    name: string;
    color: string;
    state: RunState;
    firstAnswerMs: number | null;
    decodeTokPerSec: number | null;
    /** Transcription only: audio seconds per processing second, and the word error rate. */
    rtf: number | null;
    wer: number | null;
    /** Image only: time for one image, and denoising steps per second. */
    imageMs: number | null;
    stepsPerSec: number | null;
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
  // Every session before version 6 was a text session.
  const oldConfig = (old.config ?? {}) as Partial<TextConfig>;
  const oldSampling = (oldConfig.sampling ?? {}) as unknown as Record<string, number | undefined>;
  const round = (r: StoredRound): StoredRound => ({
    ...r,
    finishedAt: r.finishedAt ?? null,
    order: r.order ?? r.runs.map((run) => run.machineId),
    nonce: r.nonce ?? null,
    loopLagMs: r.loopLagMs ?? value.loopLagMs ?? null,
    flags: r.flags ?? [],
    runs: r.runs.map((run) => ({
      ...run,
      rtt: run.rtt ?? null,
      telemetry: run.telemetry ?? null,
      timeline: run.timeline ?? null,
      requestedAtMs: run.requestedAtMs ?? null,
      transcription: run.transcription ?? null,
      image: run.image ?? null,
    })),
  });
  const provenance = (old.provenance ?? []).map((p) => ({
    ...p,
    sttBefore: p.sttBefore ?? null,
    sttAfter: p.sttAfter ?? null,
    imageBefore: p.imageBefore ?? null,
    imageAfter: p.imageAfter ?? null,
    restore: p.restore ?? null,
  }));
  if (value.workload === 'transcribe' || value.workload === 'image') {
    return {
      ...value,
      schemaVersion: SESSION_SCHEMA_VERSION,
      provenance,
      rounds: value.rounds.map(round),
      warmup: value.warmup ? round(value.warmup) : null,
    };
  }
  return {
    ...value,
    workload: 'text',
    schemaVersion: SESSION_SCHEMA_VERSION,
    provenance,
    config: {
      ...(oldConfig as TextConfig),
      preset: oldConfig.preset ?? 'custom',
      prefill: oldConfig.prefill ?? 'warm',
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
    votes: old.votes ?? [],
    rounds: (old.rounds ?? []).map(round),
  };
}

export function publicRun(run: RunView | StoredRun): RunView {
  if (!('raw' in run)) return run;
  const { raw: _raw, ...view } = run;
  return view;
}

/** A few words about an image session's prompt, model and size, for the results log. */
export function imageLabel(config: ImageConfig): string {
  const prompt = imagePrompt(config);
  const model = config.model.split('/').pop() ?? config.model;
  const quant = config.ggufFilename?.match(/(I?Q\d\w*|BF16|F16|F32)(?=\.gguf$)/i)?.[1];
  return `Image "${prompt.length > 60 ? `${prompt.slice(0, 60).trimEnd()}…` : prompt}" with ${model}${quant ? ` ${quant}` : ''}, ${config.width}×${config.height}, ${config.steps} steps`;
}

/** The line the results log shows for a session. */
export function sessionLabel(session: WorkloadConfig): string {
  if (session.workload === 'text') return session.config.prompt.slice(0, 160);
  if (session.workload === 'transcribe') return audioLabel(session.config);
  return imageLabel(session.config);
}

/** A few words about a transcription session's audio and model, for the results log. */
export function audioLabel(config: TranscribeConfig): string {
  const audio =
    config.audio.kind === 'clip'
      ? `LibriSpeech clip, ${Math.round(LIBRISPEECH_CLIP.seconds)} s`
      : config.audio.kind === 'long'
        ? `LibriSpeech clip repeated ${repeatsFor(config.audio.minutes)} times, ${config.audio.minutes}+ min`
        : `${config.audio.name}${config.audio.reference ? ', with a reference' : ''}`;
  return `Transcribe ${audio} with ${config.model} on ${config.engine}`;
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
    workload: session.workload,
    prompt: sessionLabel(session),
    rounds: session.rounds.length,
    votes: labelVotes(session),
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
        state:
          done.length > 0
            ? 'done'
            : (last?.state ?? (session.state === 'running' ? 'starting' : 'failed')),
        firstAnswerMs: pick((run) => run.client?.firstAnswerMs),
        decodeTokPerSec: pick((run) => run.client?.decodeTokPerSec),
        rtf: pick((run) => run.transcription?.rtf),
        wer: pick((run) => run.transcription?.wer?.wer),
        imageMs: pick((run) => run.image?.totalMs),
        stepsPerSec: pick((run) => run.image?.stepsPerSec),
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

/** At most this many points per run in the race chart's timeline. */
export const TIMELINE_POINTS = 400;

/** Tokens against time from a run's events, thinned evenly, keeping the last point. */
export function tokenTimeline(
  events: ReadonlyArray<{ t: number; event: { type: string } }>,
  requestAt: number,
): Array<[number, number, 0 | 1]> {
  const points: Array<[number, number, 0 | 1]> = [];
  let count = 0;
  for (const { t, event } of events) {
    if (event.type !== 'reasoning' && event.type !== 'content') continue;
    count += 1;
    points.push([Math.round((t - requestAt) * 10) / 10, count, event.type === 'reasoning' ? 1 : 0]);
  }
  if (points.length <= TIMELINE_POINTS) return points;
  const step = points.length / TIMELINE_POINTS;
  const thinned: Array<[number, number, 0 | 1]> = [];
  for (let i = 0; i < TIMELINE_POINTS - 1; i += 1) {
    const point = points[Math.floor(i * step)];
    if (point) thinned.push(point);
  }
  const last = points[points.length - 1];
  if (last) thinned.push(last);
  return thinned;
}
