import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import {
  abbaOrder,
  chatRequestBody,
  compactEvents,
  computeClientMetrics,
  DEFAULT_SAMPLING,
  describeAddress,
  describeRouteFailure,
  detailOf,
  explainNetworkError,
  isTokenEvent,
  newNonce,
  publicRun,
  publicSession,
  roundFlags,
  runEnergy,
  SESSION_SCHEMA_VERSION,
  summarizeSession,
  tokenTimeline,
  withNonce,
  wordErrorRate,
  audioLabel,
  imagePrompt,
  imageRequestBody,
  stepMetrics,
  observeQueue,
  summarizeThroughput,
  type ImageConfig,
  type RequestResult,
  type ModelStatus,
  type RestoreOutcome,
  type RunPhases,
  type TranscribeConfig,
  type WorkloadConfig,
  type ClientMetrics,
  type LiveMetrics,
  type MachineProvenance,
  type RoundView,
  type RunDelta,
  type RunView,
  type SessionPhase,
  type SessionRequest,
  type SessionState,
  type SessionStreamMessage,
  type SessionSummary,
  type SessionView,
  type StoredRound,
  type StoredRun,
  type StoredSession,
  type TextConfig,
  type TimedEvent,
  type Timings,
  type Vote,
} from '@duel/shared';
import type { FastifyBaseLogger } from 'fastify';
import { streamChatCompletion, type StreamOutcome } from './chat-stream';
import { readModelStatus } from './models';
import { cancelOnMachine, readMonitorRow } from './monitor';
import { measureRtt } from './rtt';
import { resolveAudio, warmupAudio, type Audio, type AudioStore } from './audio';
import {
  cancelImage,
  ensureImageModel,
  fetchGalleryImage,
  generateImage,
  readImageStatus,
} from './imagegen';
import type { ImageStore } from './imagestore';
import { watchQueue } from './queue';
import {
  clearMonitor,
  ensureSttModel,
  readSttStatus,
  readTranscriptionMonitor,
  servedEngine,
  transcribe,
} from './stt';
import type { SessionStore } from './session-store';
import type { MachineStore, StoredMachine } from './store';
import type { TelemetryHub } from './telemetry';

export interface RunTimings {
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  /** How often text and live numbers go to the browser. */
  flushEveryMs: number;
  /** Telemetry recorded before the first and after the last run, as a baseline. */
  telemetryBaselineMs: number;
  /** How often an image's progress is read: its step times are good to about this much. */
  imagePollMs: number;
  /** How often the admission queue is read during a throughput batch. */
  queuePollMs: number;
}

export const DEFAULT_RUN_TIMINGS: RunTimings = {
  idleTimeoutMs: 120_000,
  totalTimeoutMs: 30 * 60_000,
  flushEveryMs: 50,
  telemetryBaselineMs: 5000,
  imagePollMs: 100,
  queuePollMs: 250,
};

/** Finished sessions kept in memory, so the page does not wait for the disk right after a race. */
const KEEP_RECENT = 5;

/** The warm-up asks for almost nothing: it only wakes each machine up. */
const WARMUP: TextConfig = {
  preset: 'custom',
  prompt: 'Reply with the single word: ready.',
  maxTokens: 16,
  thinking: false,
  reasoningEffort: null,
  prefill: 'warm',
  sampling: DEFAULT_SAMPLING,
  mode: 'latency',
  concurrency: 1,
};

/** Runs keep only the start of a long prompt; the session's config has all of it. */
const PROMPT_KEPT = 300;

type Listener = (message: SessionStreamMessage) => void;

interface LiveRun {
  view: StoredRun;
  machine: StoredMachine;
  provenance: MachineProvenance;
  unsentReasoning: string;
  unsentAnswer: string;
  requestAt: number | null;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
}

interface LiveRound {
  view: StoredRound;
  runs: LiveRun[];
  warmup: boolean;
  lag: IntervalHistogram;
  /** One cancel id for every machine, so the bodies differ only in `model`. */
  cancelId: string;
  /** Stops this round's runs, when Unsloth cut the prompt on one of them. */
  controller: AbortController;
  /** The machine whose prompt Unsloth cut, if any. */
  truncatedBy: string | null;
}

interface ActiveSession {
  session: StoredSession;
  machines: StoredMachine[];
  /** Why a machine cannot take part, found before the first round; null when it can. */
  unready: Array<string | null>;
  models: Array<string | null>;
  current: LiveRound | null;
  controller: AbortController;
  listeners: Set<Listener>;
  lag: IntervalHistogram;
  done: Promise<void>;
  /** Why the session stopped before its last round, if it did. */
  stopReason: string | null;
  /** When each run's request went out, epoch ms, for lining up telemetry afterwards. */
  starts: Map<string, number>;
  /** Each finished run's phases on the same clock, for telemetry; text or transcription alike. */
  phases: Map<string, { phases: RunPhases; outputTokens: number | null }>;
  /** The audio of a transcription session, resolved once before the first round. */
  audio: Audio | null;
  /** Machines where this session asked for an image load, which pushed the chat model out. */
  imageLoads: boolean[];
  /** Resolves when the rounds are over, before any chat model is loaded again. */
  roundsOver: Promise<void>;
  endRounds: () => void;
}

const EMPTY_LIVE: LiveMetrics = {
  elapsedMs: 0,
  ttftMs: null,
  firstAnswerMs: null,
  chunks: 0,
  decodeTokPerSec: null,
};

function secondsText(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function lagOf(histogram: IntervalHistogram): { max: number; p99: number } {
  return {
    max: Math.round((histogram.max / 1e6) * 10) / 10,
    p99: Math.round((histogram.percentile(99) / 1e6) * 10) / 10,
  };
}

/** Waits, but gives up at once when the session is cancelled. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** What a run records about its request; transcription runs describe their audio instead. */
interface RunLabel {
  prompt: string;
  maxTokens: number;
  thinking: boolean;
  reasoningEffort: TextConfig['reasoningEffort'];
}

const textLabel = (config: TextConfig): RunLabel => config;
const audioRunLabel = (config: TranscribeConfig): RunLabel => ({
  prompt: audioLabel(config),
  maxTokens: 0,
  thinking: false,
  reasoningEffort: null,
});
const imageRunLabel = (config: ImageConfig): RunLabel => ({
  prompt: imagePrompt(config),
  maxTokens: 0,
  thinking: false,
  reasoningEffort: null,
});

function newRun(machine: StoredMachine, config: RunLabel): StoredRun {
  return {
    id: randomUUID(),
    machineId: machine.id,
    machineName: machine.name,
    prompt:
      config.prompt.length > PROMPT_KEPT
        ? `${config.prompt.slice(0, PROMPT_KEPT)}…`
        : config.prompt,
    maxTokens: config.maxTokens,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
    state: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    modelBefore: null,
    modelAfter: null,
    reasoning: '',
    answer: '',
    live: { ...EMPTY_LIVE },
    client: null,
    server: null,
    error: null,
    loopLagMs: null,
    sendOffsetMs: null,
    rtt: null,
    telemetry: null,
    timeline: null,
    requestedAtMs: null,
    transcription: null,
    image: null,
    throughput: null,
    raw: null,
  };
}

function publicRound(round: StoredRound): RoundView {
  return { ...round, runs: round.runs.map((run) => publicRun(run)) };
}

/**
 * Runs sessions: the same prompt on every chosen machine for a number of rounds, after an
 * optional warm-up. Machines go together in the same tick, or one at a time in ABBA order. Each
 * machine streams on its own, so one failure never stops the others. One session runs at a time.
 */
export class SessionManager {
  private readonly active = new Map<string, ActiveSession>();
  private readonly recent = new Map<string, StoredSession>();

  constructor(
    private readonly deps: {
      machines: MachineStore;
      sessions: SessionStore;
      timings: RunTimings;
      log: FastifyBaseLogger;
      /** True while a model load runs on the machine, which would skew a race. */
      isLoading: (machineId: string) => boolean;
      telemetry: TelemetryHub;
      audio: AudioStore;
      images: ImageStore;
      /** Loads a machine's chat model again with the settings it had; for image races. */
      restoreText: (machine: StoredMachine, status: ModelStatus) => Promise<RestoreOutcome>;
    },
  ) {}

  /** The session that is still running, if any. */
  running(): SessionView | null {
    for (const entry of this.active.values()) {
      if (entry.session.state === 'running') return publicSession(entry.session);
    }
    return null;
  }

  list(): SessionSummary[] {
    const summaries = new Map<string, SessionSummary>();
    for (const summary of this.deps.sessions.summaries()) summaries.set(summary.id, summary);
    for (const entry of this.active.values()) {
      summaries.set(entry.session.id, summarizeSession(entry.session));
    }
    return [...summaries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<SessionView | null> {
    const live = this.active.get(id)?.session ?? this.recent.get(id);
    if (live) return publicSession(structuredClone(live));
    const stored = await this.deps.sessions.load(id);
    return stored ? publicSession(stored) : null;
  }

  /**
   * Joins a running session: a snapshot plus every later message, with no text in both. Pending
   * text goes to the existing listeners first, so the snapshot and the next delta never overlap.
   * Null when the session is not running.
   */
  join(id: string, listener: Listener): { snapshot: SessionView; leave: () => void } | null {
    const entry = this.active.get(id);
    if (!entry) return null;
    this.flush(entry);
    const snapshot = publicSession(structuredClone(entry.session));
    entry.listeners.add(listener);
    return { snapshot, leave: () => entry.listeners.delete(listener) };
  }

  /** Waits for a session to end; for tests and shutdown. */
  async settled(id: string): Promise<void> {
    await this.active.get(id)?.done;
  }

  start(machines: StoredMachine[], request: SessionRequest): SessionView {
    const id = randomUUID();
    const workload: WorkloadConfig =
      request.workload === 'text'
        ? { workload: 'text', config: { ...request.config } }
        : request.workload === 'transcribe'
          ? { workload: 'transcribe', config: structuredClone(request.config) }
          : { workload: 'image', config: structuredClone(request.config) };
    const session: StoredSession = {
      ...workload,
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      state: 'running',
      error: null,
      plan: { ...request.plan },
      machines: machines.map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        baseUrl: m.baseUrl,
        notes: m.notes,
      })),
      warmup: null,
      rounds: [],
      progress: { phase: 'preparing', round: null },
      telemetry: { enabled: this.deps.telemetry.enabled },
      votes: [],
      provenance: machines.map((m) => this.provenanceOf(m)),
      loopLagMs: null,
    };
    const entry: ActiveSession = {
      session,
      machines,
      unready: machines.map(() => null),
      models: machines.map(() => null),
      current: null,
      controller: new AbortController(),
      listeners: new Set(),
      lag: monitorEventLoopDelay({ resolution: 10 }),
      done: Promise.resolve(),
      stopReason: null,
      starts: new Map(),
      phases: new Map(),
      audio: null,
      imageLoads: machines.map(() => false),
      roundsOver: Promise.resolve(),
      endRounds: () => undefined,
    };
    entry.roundsOver = new Promise((resolve) => {
      entry.endRounds = resolve;
    });
    this.active.set(id, entry);
    entry.done = this.execute(entry).catch(async (error: unknown) => {
      this.deps.log.error({ err: error, sessionId: id }, 'race stopped by an error');
      await this.finishSession(
        entry,
        'failed',
        `Model Duel stopped the race: ${(error as Error).message}`,
      );
    });
    return publicSession(structuredClone(session));
  }

  async cancel(id: string): Promise<SessionView | null> {
    const entry = this.active.get(id);
    if (!entry) return this.get(id);
    entry.controller.abort();
    // Also ask Unsloth by id, in case a dropped connection is noticed late.
    const inFlight = (entry.current?.runs ?? []).filter(
      (run) => run.requestAt !== null && run.view.finishedAt === null,
    );
    const session = entry.session;
    // A throughput batch gave each request its own id: the round's id and its number.
    const batch =
      session.workload === 'text' && session.config.mode === 'throughput' && !entry.current?.warmup
        ? session.config.concurrency
        : 0;
    const cancelId = (run: LiveRun) => entry.current?.cancelId ?? run.view.id;
    await Promise.allSettled(
      inFlight.flatMap((run) =>
        session.workload === 'image'
          ? [cancelImage(run.machine)]
          : batch > 0
            ? Array.from({ length: batch }, (_unused, k) =>
                cancelOnMachine(run.machine, `${cancelId(run)}-${k + 1}`),
              )
            : [cancelOnMachine(run.machine, cancelId(run))],
      ),
    );
    // An image race still loads the chat models again after this, so do not wait for that.
    await entry.roundsOver;
    return this.get(id);
  }

  /** The whole session as stored, raw events included, for the JSON export. */
  async getStored(id: string): Promise<StoredSession | null> {
    const live = this.active.get(id)?.session ?? this.recent.get(id);
    if (live) return structuredClone(live);
    return this.deps.sessions.load(id);
  }

  /**
   * Records a blind vote on one round of a finished two-machine session; a second vote on the
   * same round replaces the first.
   */
  async vote(id: string, vote: Vote): Promise<SessionView | string> {
    if (this.active.has(id)) return 'The race is still running.';
    const stored = await this.getStored(id);
    if (!stored) return 'There is no race with that id.';
    if (stored.machines.length !== 2) return 'Blind votes need a race between two machines.';
    if (!stored.rounds.some((round) => round.index === vote.round))
      return 'There is no such round.';
    const ids = new Set(stored.machines.map((m) => m.id));
    if (vote.left === vote.right || !ids.has(vote.left) || !ids.has(vote.right)) {
      return 'The vote must name the two machines of the race.';
    }
    stored.votes = [...stored.votes.filter((v) => v.round !== vote.round), vote].sort(
      (a, b) => a.round - b.round,
    );
    await this.deps.sessions.save(stored);
    if (this.recent.has(id)) this.recent.set(id, stored);
    return publicSession(stored);
  }

  /** Deletes a finished session. */
  async remove(id: string): Promise<'deleted' | 'running' | 'missing'> {
    const entry = this.active.get(id);
    if (entry) {
      if (entry.session.finishedAt === null) return 'running';
      // Finished but still being saved: wait, or the save would write the file back.
      await entry.done;
    }
    this.recent.delete(id);
    const removed = await this.deps.sessions.remove(id);
    if (removed) await this.deps.images.removeSession(id);
    return removed ? 'deleted' : 'missing';
  }

  async close(): Promise<void> {
    const entries = [...this.active.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map((entry) => entry.done));
  }

  private provenanceOf(machine: StoredMachine): MachineProvenance {
    const probe = this.deps.machines.lastProbe(machine.id);
    const report = probe?.report ?? null;
    return {
      machineId: machine.id,
      probedAt: probe?.probedAt ?? null,
      versions: {
        unsloth: report?.versions.unsloth ?? null,
        studio: report?.versions.studio ?? null,
        llamaCpp: report?.versions.llamaCpp ?? null,
      },
      platform: {
        os: report?.platform.os ?? null,
        backend: report?.platform.backend ?? null,
        memoryTotalGb: report?.platform.memoryTotalGb ?? null,
      },
      gpus: report?.gpus.map((gpu) => ({ name: gpu.name, memoryGb: gpu.memoryGb })) ?? [],
      statusBefore: null,
      statusAfter: null,
      request: null,
      sttBefore: null,
      sttAfter: null,
      imageBefore: null,
      imageAfter: null,
      restore: null,
    };
  }

  private broadcast(entry: ActiveSession, message: SessionStreamMessage) {
    for (const listener of entry.listeners) listener(message);
  }

  private setProgress(entry: ActiveSession, phase: SessionPhase, round: number | null) {
    entry.session.progress = { phase, round };
    this.broadcast(entry, { type: 'progress', progress: { phase, round } });
  }

  private liveNow(run: LiveRun): LiveMetrics {
    const live = run.view.live;
    const decodeMs =
      run.firstTokenAt !== null && run.lastTokenAt !== null
        ? run.lastTokenAt - run.firstTokenAt
        : 0;
    return {
      ...live,
      elapsedMs: run.requestAt === null ? 0 : performance.now() - run.requestAt,
      decodeTokPerSec:
        live.chunks > 1 && decodeMs > 0 ? ((live.chunks - 1) * 1000) / decodeMs : null,
    };
  }

  /** Sends the text and live numbers gathered since the last flush, for every machine at once. */
  private flush(entry: ActiveSession) {
    const current = entry.current;
    if (!current) return;
    const runs: RunDelta[] = [];
    for (const run of current.runs) {
      if (run.view.finishedAt !== null) continue;
      run.view.live = this.liveNow(run);
      runs.push({
        machineId: run.machine.id,
        state: run.view.state,
        reasoning: run.unsentReasoning,
        answer: run.unsentAnswer,
        live: run.view.live,
      });
      run.unsentReasoning = '';
      run.unsentAnswer = '';
    }
    if (runs.length > 0) {
      this.broadcast(entry, {
        type: 'delta',
        warmup: current.warmup,
        round: current.view.index,
        runs,
      });
    }
  }

  private onEvent(round: LiveRound, run: LiveRun, timed: TimedEvent) {
    const { event } = timed;
    if (event.type === 'truncated' && !round.warmup && round.truncatedBy === null) {
      // The machines would no longer answer the same prompt: stop the round.
      round.truncatedBy = run.machine.name;
      round.controller.abort();
      return;
    }
    if (!isTokenEvent(event)) return;
    run.firstTokenAt ??= timed.t;
    run.lastTokenAt = timed.t;
    const since = run.requestAt === null ? null : timed.t - run.requestAt;
    run.view.live.chunks += 1;
    run.view.live.ttftMs ??= since;
    if (event.type === 'reasoning') {
      run.view.reasoning += event.text;
      run.unsentReasoning += event.text;
    } else {
      run.view.live.firstAnswerMs ??= since;
      run.view.answer += event.text;
      run.unsentAnswer += event.text;
    }
  }

  private finishRun(
    entry: ActiveSession,
    round: LiveRound,
    run: LiveRun,
    state: RunView['state'],
    error: string | null,
  ) {
    if (run.view.finishedAt !== null) return;
    if (run.requestAt !== null && run.view.state === 'streaming') {
      run.view.live = this.liveNow(run);
    }
    run.unsentReasoning = '';
    run.unsentAnswer = '';
    run.view.state = state;
    run.view.error = error;
    run.view.finishedAt = new Date().toISOString();
    this.broadcast(entry, {
      type: 'run',
      warmup: round.warmup,
      round: round.view.index,
      run: publicRun(structuredClone(run.view)),
    });
  }

  /** Reads each machine's model before the first round; a machine without one sits out. */
  private async prepare(entry: ActiveSession, index: number): Promise<void> {
    const machine = entry.machines[index];
    const provenance = entry.session.provenance[index];
    if (!machine || !provenance) return;
    const { session } = entry;
    if (session.workload === 'transcribe') {
      const stt = await readSttStatus(machine);
      provenance.sttBefore = stt.status;
      if (!stt.status) {
        entry.unready[index] = stt.error ?? `${machine.name} did not answer its STT status.`;
        return;
      }
      if (!stt.status.available) {
        entry.unready[index] = `Speech-to-text is not available on ${machine.name}.`;
        return;
      }
      const engine = servedEngine(stt.status, session.config.engine);
      if (!stt.status.engines[engine].available) {
        entry.unready[index] = `The ${engine} engine is not available on ${machine.name}.`;
        return;
      }
      entry.models[index] = session.config.model;
      return;
    }
    if (session.workload === 'image') {
      if (this.deps.isLoading(machine.id)) {
        entry.unready[index] =
          `A model is loading on ${machine.name}. Wait for it to finish, then start again.`;
        return;
      }
      // The chat model is read first, so it can be loaded again after the race.
      const [chat, image] = await Promise.all([readModelStatus(machine), readImageStatus(machine)]);
      provenance.statusBefore = chat.status;
      provenance.imageBefore = image.status;
      if (!image.status) {
        entry.unready[index] =
          `${machine.name} cannot generate images: ${image.error ?? 'no answer'}.`;
        return;
      }
      entry.models[index] = session.config.model;
      return;
    }
    if (this.deps.isLoading(machine.id)) {
      entry.unready[index] =
        `A model is loading on ${machine.name}. Wait for it to finish, then start again.`;
      return;
    }
    const before = await readModelStatus(machine);
    provenance.statusBefore = before.status;
    if (before.error !== null) {
      entry.unready[index] = before.error;
      return;
    }
    const model = before.status?.activeModel ?? null;
    if (!model) {
      entry.unready[index] =
        `No model is loaded on ${machine.name}. Load one on the Models tab first.`;
      return;
    }
    entry.models[index] = model;
  }

  private async execute(entry: ActiveSession): Promise<void> {
    const { session, controller } = entry;
    const { plan } = session;
    const signal = controller.signal;
    // A record exists from the start, so a crash leaves an interrupted race instead of nothing.
    await this.deps.sessions.save(session);
    entry.lag.enable();
    const timer = setInterval(() => this.flush(entry), this.deps.timings.flushEveryMs);
    let releaseTelemetry: (() => void) | null = null;
    const baselineMs = this.deps.timings.telemetryBaselineMs;
    try {
      await Promise.all(entry.machines.map((_machine, i) => this.prepare(entry, i)));
      if (session.workload === 'transcribe') {
        const audio = await resolveAudio(session.config.audio, this.deps.audio);
        if (typeof audio === 'string') entry.stopReason = audio;
        else entry.audio = audio;
      }
      const anyReady = entry.models.some((model) => model !== null) && entry.stopReason === null;
      if (session.telemetry.enabled && anyReady && !signal.aborted) {
        releaseTelemetry = this.deps.telemetry.acquire(entry.machines.map((m) => m.id));
        this.setProgress(entry, 'baseline', null);
        await pause(baselineMs, signal);
      }
      if (plan.warmup && anyReady && !signal.aborted) {
        this.setProgress(entry, 'warmup', null);
        await this.runRound(entry, -1, true);
      }
      for (
        let index = 0;
        index < plan.rounds && !signal.aborted && entry.stopReason === null;
        index += 1
      ) {
        const settle = anyReady && plan.settleMs > 0 && (index > 0 || plan.warmup);
        if (settle) {
          this.setProgress(entry, 'settling', index);
          await pause(plan.settleMs, signal);
          if (signal.aborted) break;
        }
        await this.runRound(entry, index, false);
      }
      if (releaseTelemetry) {
        if (!signal.aborted) {
          this.setProgress(entry, 'baseline', null);
          await pause(baselineMs, signal);
        }
        this.attachTelemetry(entry);
      }
      entry.endRounds();
      if (session.workload === 'image' && session.config.restoreText) {
        await this.restoreChatModels(entry);
      }
    } finally {
      entry.endRounds();
      releaseTelemetry?.();
      clearInterval(timer);
      entry.lag.disable();
    }
    session.loopLagMs = lagOf(entry.lag);
    const counted = session.rounds.flatMap((round) => round.runs);
    const state: SessionState = signal.aborted
      ? 'cancelled'
      : entry.stopReason !== null ||
          (counted.length > 0 && counted.every((run) => run.state === 'failed'))
        ? 'failed'
        : 'done';
    await this.finishSession(
      entry,
      state,
      state !== 'failed'
        ? null
        : (entry.stopReason ?? 'Every machine failed in every round. Each pane says why.'),
    );
  }

  /** Lines each run up with the samples taken around it, and adds up its energy. */
  private attachTelemetry(entry: ActiveSession) {
    const baseline = this.deps.timings.telemetryBaselineMs;
    const rounds = [
      ...(entry.session.warmup ? [entry.session.warmup] : []),
      ...entry.session.rounds,
    ];
    for (const round of rounds) {
      for (const run of round.runs) {
        const recorded = entry.phases.get(run.id);
        if (!recorded) continue;
        const { phases, outputTokens } = recorded;
        const samples = this.deps.telemetry.samplesBetween(
          run.machineId,
          phases.start - baseline,
          phases.end + baseline,
        );
        run.telemetry = { samples, energy: runEnergy(samples, phases, outputTokens) };
      }
    }
  }

  /**
   * Loads each machine's chat model again, where this race's image load pushed it out, with the
   * settings it had. Runs even after a cancel, since the machine is left without its chat model.
   */
  private async restoreChatModels(entry: ActiveSession): Promise<void> {
    const targets = entry.machines
      .map((machine, i) => ({ machine, provenance: entry.session.provenance[i] }))
      .filter(
        (t, i): t is { machine: StoredMachine; provenance: MachineProvenance } =>
          entry.imageLoads[i] === true && !!t.provenance?.statusBefore?.activeModel,
      );
    if (targets.length === 0) return;
    this.setProgress(entry, 'restoring', null);
    await Promise.all(
      targets.map(async ({ machine, provenance }) => {
        try {
          provenance.restore = await this.deps.restoreText(
            machine,
            provenance.statusBefore as ModelStatus,
          );
        } catch (error) {
          provenance.restore = {
            model: provenance.statusBefore?.activeModel ?? 'the chat model',
            quant: provenance.statusBefore?.quant ?? null,
            state: 'failed',
            error: (error as Error).message,
            durationMs: null,
          };
        }
      }),
    );
  }

  private async runRound(entry: ActiveSession, index: number, warmup: boolean): Promise<void> {
    const { session, controller } = entry;
    if (session.workload === 'transcribe') {
      await this.runTranscribeRound(entry, session.config, index, warmup);
      return;
    }
    if (session.workload === 'image') {
      await this.runImageRound(entry, session.config, index, warmup);
      return;
    }
    const signal = controller.signal;
    const config = warmup ? WARMUP : session.config;
    const cold = !warmup && config.prefill === 'cold';
    const view: StoredRound = {
      index,
      startedAt: null,
      finishedAt: null,
      sendSkewMs: null,
      order: [],
      nonce: cold ? newNonce() : null,
      runs: entry.machines.map((machine) => newRun(machine, textLabel(config))),
      loopLagMs: null,
      flags: [],
    };
    const round: LiveRound = {
      view,
      warmup,
      lag: monitorEventLoopDelay({ resolution: 10 }),
      cancelId: randomUUID(),
      controller: new AbortController(),
      truncatedBy: null,
      runs: entry.machines.map((machine, i) => ({
        view: view.runs[i] as StoredRun,
        machine,
        provenance: session.provenance[i] as MachineProvenance,
        unsentReasoning: '',
        unsentAnswer: '',
        requestAt: null,
        firstTokenAt: null,
        lastTokenAt: null,
      })),
    };
    for (const [i, run] of round.runs.entries()) run.view.modelBefore = entry.models[i] ?? null;
    if (warmup) session.warmup = view;
    else session.rounds.push(view);
    entry.current = round;
    this.broadcast(entry, { type: 'round', warmup, round: publicRound(structuredClone(view)) });

    for (const [i, run] of round.runs.entries()) {
      const why = entry.unready[i];
      if (why) this.finishRun(entry, round, run, 'failed', why);
    }
    const ready = round.runs.filter((_run, i) => entry.models[i] !== null);

    if (!warmup && ready.length > 0) {
      this.setProgress(entry, 'rtt', index);
      const rtts = await Promise.all(
        ready.map((run) => measureRtt(run.machine.baseUrl, { signal })),
      );
      ready.forEach((run, i) => {
        run.view.rtt = rtts[i] ?? null;
      });
    }
    if (!signal.aborted && ready.length > 0) {
      this.setProgress(entry, warmup ? 'warmup' : 'running', warmup ? null : index);
      round.lag.enable();
      view.startedAt = new Date().toISOString();
      const bodyFor = (run: LiveRun) => {
        const model = entry.models[round.runs.indexOf(run)] ?? '';
        return chatRequestBody(config, model, round.cancelId, view.nonce);
      };
      // Throughput mode sends a batch per machine; the warm-up stays a single request.
      const batch = !warmup && config.mode === 'throughput' ? config.concurrency : 0;
      const send = (run: LiveRun) =>
        batch > 0
          ? this.streamMany(entry, round, run, bodyFor(run), batch)
          : this.stream(entry, round, run, bodyFor(run));
      if (session.plan.sequencing === 'concurrent') {
        const pending: Array<Promise<void>> = [];
        // Same tick: nothing in this loop waits.
        for (const run of ready) pending.push(send(run));
        view.order = ready.map((run) => run.machine.id);
        const first = Math.min(...ready.map((run) => run.requestAt ?? 0));
        const last = Math.max(...ready.map((run) => run.requestAt ?? 0));
        view.sendSkewMs = round3(last - first);
        for (const run of ready) run.view.sendOffsetMs = round3((run.requestAt ?? 0) - first);
        await Promise.all(pending);
      } else {
        const order = abbaOrder(ready, warmup ? 0 : index);
        view.order = order.map((run) => run.machine.id);
        for (const run of order) run.view.state = 'queued';
        for (const run of order) {
          if (signal.aborted || round.controller.signal.aborted) break;
          await send(run);
        }
      }
      round.lag.disable();
      view.loopLagMs = lagOf(round.lag);
    }
    const cutOn = round.truncatedBy;
    for (const run of round.runs) {
      if (signal.aborted) this.finishRun(entry, round, run, 'cancelled', null);
      else if (cutOn !== null) {
        this.finishRun(
          entry,
          round,
          run,
          'cancelled',
          `Stopped because Unsloth cut the prompt on ${cutOn}.`,
        );
      }
    }
    view.finishedAt = new Date().toISOString();
    if (!warmup) {
      const names = new Map(session.machines.map((m) => [m.id, m.name]));
      view.flags = roundFlags(view.runs, names, view.loopLagMs, {
        fixedLength: session.workload === 'text' && session.config.preset === 'fixed-length',
      });
    }
    if (cutOn !== null) {
      view.flags.push({
        machineId: null,
        kind: 'truncated',
        text: `Unsloth cut the prompt on ${cutOn} to fit its context, so the round was stopped.`,
      });
      entry.stopReason = `Unsloth cut the prompt on ${cutOn} to fit its context, so the race stopped. Pick a shorter prompt, or load the model with a longer context.`;
    }
    this.flush(entry);
    this.broadcast(entry, { type: 'round', warmup, round: publicRound(structuredClone(view)) });
    entry.current = null;
    await this.deps.sessions.save(session);
  }

  /**
   * An image round: every machine gets the image model loaded if it is not (which pushes its chat
   * model out), a round-trip check, then the same prompt and seed together or in turns. The
   * warm-up makes a two-step image at the same size, which also triggers any compilation.
   */
  private async runImageRound(
    entry: ActiveSession,
    config: ImageConfig,
    index: number,
    warmup: boolean,
  ): Promise<void> {
    const { session, controller } = entry;
    const signal = controller.signal;
    const view: StoredRound = {
      index,
      startedAt: null,
      finishedAt: null,
      sendSkewMs: null,
      order: [],
      nonce: null,
      runs: entry.machines.map((machine) => newRun(machine, imageRunLabel(config))),
      loopLagMs: null,
      flags: [],
    };
    const round: LiveRound = {
      view,
      warmup,
      lag: monitorEventLoopDelay({ resolution: 10 }),
      cancelId: randomUUID(),
      controller: new AbortController(),
      truncatedBy: null,
      runs: entry.machines.map((machine, i) => ({
        view: view.runs[i] as StoredRun,
        machine,
        provenance: session.provenance[i] as MachineProvenance,
        unsentReasoning: '',
        unsentAnswer: '',
        requestAt: null,
        firstTokenAt: null,
        lastTokenAt: null,
      })),
    };
    for (const [i, run] of round.runs.entries()) run.view.modelBefore = entry.models[i] ?? null;
    if (warmup) session.warmup = view;
    else session.rounds.push(view);
    entry.current = round;
    this.broadcast(entry, { type: 'round', warmup, round: publicRound(structuredClone(view)) });

    for (const [i, run] of round.runs.entries()) {
      const why = entry.unready[i];
      if (why) this.finishRun(entry, round, run, 'failed', why);
    }
    const ready = round.runs.filter((_run, i) => entry.models[i] !== null);

    this.setProgress(entry, 'loading', warmup ? null : index);
    const loads = new Map<string, number | null>();
    await Promise.all(
      ready.map(async (run) => {
        const i = entry.machines.indexOf(run.machine);
        const loaded = await ensureImageModel(run.machine, config, {
          signal,
          timeoutMs: this.deps.timings.totalTimeoutMs,
          onLoad: () => {
            entry.imageLoads[i] = true;
          },
        });
        if (loaded.error) this.finishRun(entry, round, run, 'failed', loaded.error);
        else loads.set(run.view.id, loaded.loadMs);
      }),
    );
    const sending = ready.filter((run) => run.view.finishedAt === null);
    if (!warmup && sending.length > 0) {
      this.setProgress(entry, 'rtt', index);
      const rtts = await Promise.all(
        sending.map((run) => measureRtt(run.machine.baseUrl, { signal })),
      );
      sending.forEach((run, i) => {
        run.view.rtt = rtts[i] ?? null;
      });
    }
    if (!signal.aborted && sending.length > 0) {
      this.setProgress(entry, warmup ? 'warmup' : 'running', warmup ? null : index);
      round.lag.enable();
      view.startedAt = new Date().toISOString();
      const body = imageRequestBody(
        warmup ? { ...config, steps: Math.min(config.steps, 2) } : config,
      );
      const send = (run: LiveRun) =>
        this.sendImage(entry, round, run, body, loads.get(run.view.id) ?? null);
      if (session.plan.sequencing === 'concurrent') {
        const pending = sending.map((run) => send(run));
        view.order = sending.map((run) => run.machine.id);
        const first = Math.min(...sending.map((run) => run.requestAt ?? 0));
        const last = Math.max(...sending.map((run) => run.requestAt ?? 0));
        view.sendSkewMs = round3(last - first);
        for (const run of sending) run.view.sendOffsetMs = round3((run.requestAt ?? 0) - first);
        await Promise.all(pending);
      } else {
        const order = abbaOrder(sending, warmup ? 0 : index);
        view.order = order.map((run) => run.machine.id);
        for (const run of order) run.view.state = 'queued';
        for (const run of order) {
          if (signal.aborted) break;
          await send(run);
        }
      }
      round.lag.disable();
      view.loopLagMs = lagOf(round.lag);
    }
    for (const run of round.runs) {
      if (signal.aborted) this.finishRun(entry, round, run, 'cancelled', null);
    }
    view.finishedAt = new Date().toISOString();
    if (!warmup) {
      const names = new Map(session.machines.map((m) => [m.id, m.name]));
      view.flags = roundFlags(view.runs, names, view.loopLagMs);
      const splits = view.runs.filter((run) => run.image && run.image.totalSteps > run.image.steps);
      for (const run of splits) {
        view.flags.push({
          kind: 'split',
          machineId: run.machineId,
          text: `${run.machineName} ran short of memory and made the image in parts, so its steps took longer.`,
        });
      }
    }
    this.flush(entry);
    this.broadcast(entry, { type: 'round', warmup, round: publicRound(structuredClone(view)) });
    entry.current = null;
    await this.deps.sessions.save(session);
  }

  /** Sends the prompt to one machine, follows its steps, and keeps the image it made. */
  private async sendImage(
    entry: ActiveSession,
    round: LiveRound,
    run: LiveRun,
    body: Record<string, unknown>,
    loadMs: number | null,
  ): Promise<void> {
    const { machine } = run;
    if (!round.warmup) run.provenance.request ??= body;
    run.view.state = 'streaming';
    run.view.live = { ...run.view.live, steps: { done: 0, total: Number(body.steps) || 0 } };
    run.requestAt = performance.now();
    run.view.requestedAtMs = performance.timeOrigin + run.requestAt;
    entry.starts.set(run.view.id, run.view.requestedAtMs);
    const outcome = await generateImage(machine, body, {
      signal: AbortSignal.any([entry.controller.signal, round.controller.signal]),
      timeoutMs: this.deps.timings.totalTimeoutMs,
      pollMs: this.deps.timings.imagePollMs,
      onStep: (done, total) => {
        run.view.live = { ...run.view.live, steps: { done, total } };
      },
    });
    if (outcome.cancelled) {
      this.finishRun(entry, round, run, 'cancelled', null);
      return;
    }
    if (outcome.error) {
      this.finishRun(entry, round, run, 'failed', `${machine.name}: ${outcome.error}`);
      return;
    }
    if (outcome.status !== 200) {
      this.finishRun(
        entry,
        round,
        run,
        'failed',
        detailOf(outcome.body) || `The image request answered HTTP ${outcome.status ?? 'nothing'}.`,
      );
      return;
    }
    const totalMs = outcome.endAt - outcome.requestAt;
    const first = ((outcome.body as { images?: unknown[] } | null)?.images?.[0] ?? {}) as {
      id?: unknown;
      seed?: unknown;
      width?: unknown;
      height?: unknown;
    };
    const galleryId = typeof first.id === 'string' ? first.id : null;
    const steps = Number(body.steps) || 0;
    const metrics = stepMetrics(outcome.timeline, Math.max(outcome.totalSteps, steps), totalMs);
    // The image and the settings that served are read after the timing is done.
    const [png, after] = await Promise.all([
      galleryId && !round.warmup ? fetchGalleryImage(machine, galleryId) : Promise.resolve(null),
      round.warmup ? Promise.resolve(null) : readImageStatus(machine),
    ]);
    const stored = png
      ? await this.deps.images.save(entry.session.id, run.view.id, png).catch(() => false)
      : false;
    if (after?.status) run.provenance.imageAfter = after.status;
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    run.view.image = {
      galleryId,
      stored,
      width: num(first.width),
      height: num(first.height),
      seed: num(first.seed),
      steps,
      loadMs: loadMs === null ? null : round3(loadMs),
      timeline: outcome.timeline,
      totalSteps: Math.max(outcome.totalSteps, steps),
      firstStepMs: metrics.firstStepMs === null ? null : round3(metrics.firstStepMs),
      lastStepMs: metrics.lastStepMs === null ? null : round3(metrics.lastStepMs),
      stepsPerSec: metrics.stepsPerSec,
      decodeTailMs: metrics.decodeTailMs === null ? null : round3(metrics.decodeTailMs),
      resolutionMs: metrics.resolutionMs,
      totalMs: round3(totalMs),
      engine: after?.status?.engine ?? null,
      device: after?.status?.device ?? null,
      dtype: after?.status?.dtype ?? null,
      speedMode: after?.status?.speedMode ?? null,
    };
    run.view.live = {
      ...run.view.live,
      elapsedMs: totalMs,
      steps: { done: steps, total: Math.max(outcome.totalSteps, steps) },
    };
    run.view.loopLagMs = lagOf(round.lag);
    const start = performance.timeOrigin + outcome.requestAt;
    entry.phases.set(run.view.id, {
      phases: {
        start,
        firstToken: metrics.firstStepMs === null ? null : start + metrics.firstStepMs,
        lastToken: metrics.lastStepMs === null ? null : start + metrics.lastStepMs,
        end: start + totalMs,
      },
      outputTokens: null,
    });
    this.finishRun(entry, round, run, 'done', null);
  }

  /**
   * A transcription round: every machine gets the model loaded if it is not, a clean monitor, a
   * round-trip check, then the same audio together or in turns.
   */
  private async runTranscribeRound(
    entry: ActiveSession,
    config: TranscribeConfig,
    index: number,
    warmup: boolean,
  ): Promise<void> {
    const { session, controller } = entry;
    const signal = controller.signal;
    const audio = warmup ? await warmupAudio() : entry.audio;
    if (!audio) return;
    const view: StoredRound = {
      index,
      startedAt: null,
      finishedAt: null,
      sendSkewMs: null,
      order: [],
      nonce: null,
      runs: entry.machines.map((machine) => newRun(machine, audioRunLabel(config))),
      loopLagMs: null,
      flags: [],
    };
    const round: LiveRound = {
      view,
      warmup,
      lag: monitorEventLoopDelay({ resolution: 10 }),
      cancelId: randomUUID(),
      controller: new AbortController(),
      truncatedBy: null,
      runs: entry.machines.map((machine, i) => ({
        view: view.runs[i] as StoredRun,
        machine,
        provenance: session.provenance[i] as MachineProvenance,
        unsentReasoning: '',
        unsentAnswer: '',
        requestAt: null,
        firstTokenAt: null,
        lastTokenAt: null,
      })),
    };
    for (const [i, run] of round.runs.entries()) run.view.modelBefore = entry.models[i] ?? null;
    if (warmup) session.warmup = view;
    else session.rounds.push(view);
    entry.current = round;
    this.broadcast(entry, { type: 'round', warmup, round: publicRound(structuredClone(view)) });

    for (const [i, run] of round.runs.entries()) {
      const why = entry.unready[i];
      if (why) this.finishRun(entry, round, run, 'failed', why);
    }
    const ready = round.runs.filter((_run, i) => entry.models[i] !== null);

    // The sidecar unloads after idle minutes, so every round makes sure the model is there.
    this.setProgress(entry, 'loading', warmup ? null : index);
    const loads = new Map<string, number | null>();
    await Promise.all(
      ready.map(async (run) => {
        const loaded = await ensureSttModel(run.machine, config);
        if (loaded.error) this.finishRun(entry, round, run, 'failed', loaded.error);
        else loads.set(run.view.id, loaded.loadMs);
      }),
    );
    const sending = ready.filter((run) => run.view.finishedAt === null);
    await Promise.all(sending.map((run) => clearMonitor(run.machine)));
    if (!warmup && sending.length > 0) {
      this.setProgress(entry, 'rtt', index);
      const rtts = await Promise.all(
        sending.map((run) => measureRtt(run.machine.baseUrl, { signal })),
      );
      sending.forEach((run, i) => {
        run.view.rtt = rtts[i] ?? null;
      });
    }
    if (!signal.aborted && sending.length > 0) {
      this.setProgress(entry, warmup ? 'warmup' : 'running', warmup ? null : index);
      round.lag.enable();
      view.startedAt = new Date().toISOString();
      const fields = {
        model: config.model,
        language: config.language,
        response_format: 'verbose_json',
      };
      const send = (run: LiveRun) =>
        this.sendAudio(entry, round, run, audio, fields, loads.get(run.view.id) ?? null);
      if (session.plan.sequencing === 'concurrent') {
        const pending = sending.map((run) => send(run));
        view.order = sending.map((run) => run.machine.id);
        const first = Math.min(...sending.map((run) => run.requestAt ?? 0));
        const last = Math.max(...sending.map((run) => run.requestAt ?? 0));
        view.sendSkewMs = round3(last - first);
        for (const run of sending) run.view.sendOffsetMs = round3((run.requestAt ?? 0) - first);
        await Promise.all(pending);
      } else {
        const order = abbaOrder(sending, warmup ? 0 : index);
        view.order = order.map((run) => run.machine.id);
        for (const run of order) run.view.state = 'queued';
        for (const run of order) {
          if (signal.aborted) break;
          await send(run);
        }
      }
      round.lag.disable();
      view.loopLagMs = lagOf(round.lag);
    }
    for (const run of round.runs) {
      if (signal.aborted) this.finishRun(entry, round, run, 'cancelled', null);
    }
    view.finishedAt = new Date().toISOString();
    if (!warmup) {
      for (const run of view.runs) {
        if (run.transcription && audio.reference) {
          run.transcription.wer = wordErrorRate(audio.reference, run.transcription.text);
        }
      }
      const names = new Map(session.machines.map((m) => [m.id, m.name]));
      view.flags = roundFlags(view.runs, names, view.loopLagMs);
    }
    this.flush(entry);
    this.broadcast(entry, { type: 'round', warmup, round: publicRound(structuredClone(view)) });
    entry.current = null;
    await this.deps.sessions.save(session);
  }

  /** Sends the audio to one machine and turns its answer into a transcription result. */
  private async sendAudio(
    entry: ActiveSession,
    round: LiveRound,
    run: LiveRun,
    audio: Audio,
    fields: Record<string, string>,
    loadMs: number | null,
  ): Promise<void> {
    const { machine } = run;
    if (!round.warmup) {
      run.provenance.request ??= { ...fields, file: `${audio.name}, ${audio.bytes.length} bytes` };
    }
    run.view.state = 'streaming';
    run.requestAt = performance.now();
    run.view.requestedAtMs = performance.timeOrigin + run.requestAt;
    entry.starts.set(run.view.id, run.view.requestedAtMs);
    const outcome = await transcribe(machine, audio, fields, {
      signal: AbortSignal.any([entry.controller.signal, round.controller.signal]),
      timeoutMs: this.deps.timings.totalTimeoutMs,
    });
    if (outcome.cancelled) {
      this.finishRun(entry, round, run, 'cancelled', null);
      return;
    }
    if (outcome.error) {
      this.finishRun(entry, round, run, 'failed', `${machine.name}: ${outcome.error}`);
      return;
    }
    if (outcome.status !== 200) {
      this.finishRun(
        entry,
        round,
        run,
        'failed',
        detailOf(outcome.body) || `The transcription answered HTTP ${outcome.status ?? 'nothing'}.`,
      );
      return;
    }
    const body = (outcome.body ?? {}) as { text?: unknown; language?: unknown; duration?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const audioSeconds =
      typeof body.duration === 'number' && body.duration > 0 ? body.duration : audio.seconds;
    const bodySentAt = outcome.bodySentAt ?? outcome.requestAt;
    const headersAt = outcome.headersAt ?? outcome.endAt;
    const uploadMs = bodySentAt - outcome.requestAt;
    const processingMs = headersAt - bodySentAt;
    const [serverProcessingMs, after] = round.warmup
      ? [null, null]
      : await Promise.all([readTranscriptionMonitor(machine), readSttStatus(machine)]);
    if (after?.status) run.provenance.sttAfter = after.status;
    const rate = (ms: number | null) =>
      audioSeconds && ms !== null && ms > 0 ? audioSeconds / (ms / 1000) : null;
    run.view.answer = text;
    run.view.transcription = {
      text,
      language: typeof body.language === 'string' ? body.language : null,
      audioSeconds,
      bytes: audio.bytes.length,
      uploadMs: round3(uploadMs),
      processingMs: round3(processingMs),
      serverProcessingMs,
      rtf: rate(processingMs),
      serverRtf: rate(serverProcessingMs),
      loadMs: loadMs === null ? null : round3(loadMs),
      // Scored after the round: aligning a long transcript would block the other machines' timing.
      wer: null,
      engine: after?.status?.loadedEngine ?? null,
      device: after?.status?.device ?? null,
    };
    run.view.live = { ...run.view.live, elapsedMs: outcome.endAt - outcome.requestAt };
    run.view.loopLagMs = lagOf(round.lag);
    const start = performance.timeOrigin + outcome.requestAt;
    entry.phases.set(run.view.id, {
      phases: {
        start,
        firstToken: start + uploadMs,
        lastToken: start + uploadMs + processingMs,
        end: start + (outcome.endAt - outcome.requestAt),
      },
      outputTokens: null,
    });
    this.finishRun(entry, round, run, 'done', null);
  }

  /** Sends one machine's request; the moment it leaves is stamped before this returns. */
  private stream(
    entry: ActiveSession,
    round: LiveRound,
    run: LiveRun,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!round.warmup) run.provenance.request ??= body;
    run.view.state = 'streaming';
    run.requestAt = performance.now();
    run.view.requestedAtMs = performance.timeOrigin + run.requestAt;
    entry.starts.set(run.view.id, run.view.requestedAtMs);
    return streamChatCompletion(run.machine.baseUrl, run.machine.apiKey, body, {
      signal: AbortSignal.any([entry.controller.signal, round.controller.signal]),
      idleTimeoutMs: this.deps.timings.idleTimeoutMs,
      totalTimeoutMs: this.deps.timings.totalTimeoutMs,
      onEvent: (timed) => this.onEvent(round, run, timed),
    })
      .then((outcome) => this.completeRun(entry, round, run, outcome))
      .catch((error: unknown) =>
        this.finishRun(
          entry,
          round,
          run,
          'failed',
          `Model Duel stopped this run: ${(error as Error).message}`,
        ),
      );
  }

  /**
   * Throughput mode: the same request several times at once to one machine. The first streams
   * into the pane; every one is measured on its own, the queue is watched, and the batch is added
   * up. Each request has its own cancel id, so a cancel reaches all of them.
   */
  private async streamMany(
    entry: ActiveSession,
    round: LiveRound,
    run: LiveRun,
    body: Record<string, unknown>,
    count: number,
  ): Promise<void> {
    const { machine } = run;
    if (!round.warmup) run.provenance.request ??= body;
    run.view.state = 'streaming';
    run.requestAt = performance.now();
    run.view.requestedAtMs = performance.timeOrigin + run.requestAt;
    entry.starts.set(run.view.id, run.view.requestedAtMs);
    run.view.live = { ...run.view.live, requests: { done: 0, total: count } };
    const signal = AbortSignal.any([entry.controller.signal, round.controller.signal]);
    const queue = watchQueue(machine, this.deps.timings.queuePollMs);
    const sentAt: number[] = [];
    let finished = 0;
    const outcomes = await Promise.all(
      Array.from({ length: count }, (_unused, k) => {
        sentAt.push(performance.now());
        return streamChatCompletion(
          machine.baseUrl,
          machine.apiKey,
          { ...body, cancel_id: `${String(body.cancel_id)}-${k + 1}` },
          {
            signal,
            idleTimeoutMs: this.deps.timings.idleTimeoutMs,
            totalTimeoutMs: this.deps.timings.totalTimeoutMs,
            onEvent: (timed) => {
              const last = run.lastTokenAt;
              if (k === 0) this.onEvent(round, run, timed);
              else if (isTokenEvent(timed.event)) {
                run.firstTokenAt = Math.min(run.firstTokenAt ?? timed.t, timed.t);
                run.view.live.chunks += 1;
              }
              // The live speed counts every request's tokens over the whole batch.
              if (isTokenEvent(timed.event)) run.lastTokenAt = Math.max(last ?? timed.t, timed.t);
            },
          },
        )
          .then((outcome) => ({ outcome, error: null as string | null }))
          .catch((error: unknown) => ({ outcome: null, error: (error as Error).message }))
          .finally(() => {
            finished += 1;
            run.view.live = { ...run.view.live, requests: { done: finished, total: count } };
          });
      }),
    );
    const samples = await queue.stop();
    const first = sentAt[0] ?? run.requestAt;
    const requests: RequestResult[] = outcomes.map(({ outcome, error }, k) => {
      const sendOffsetMs = round3((sentAt[k] ?? first) - first);
      if (!outcome) {
        return {
          index: k,
          state: 'failed',
          error: `Model Duel stopped this request: ${error ?? 'unknown error'}`,
          sendOffsetMs,
          ttftMs: null,
          totalMs: null,
          outputTokens: null,
          decodeTokPerSec: null,
        };
      }
      const client = computeClientMetrics(outcome.timeline);
      const verdict = this.verdict(machine, outcome, client);
      return {
        index: k,
        state: verdict.state,
        error: verdict.error,
        sendOffsetMs,
        ttftMs: client.ttftMs,
        totalMs: client.totalMs,
        outputTokens: client.outputTokens ?? client.chunks,
        decodeTokPerSec: client.decodeTokPerSec,
      };
    });
    const throughput = summarizeThroughput(requests, count, observeQueue(samples));
    run.view.throughput = throughput;
    run.view.live = { ...run.view.live, requests: { done: count, total: count } };
    const lead = outcomes[0]?.outcome;
    if (!lead) {
      this.finishRun(entry, round, run, 'failed', requests[0]?.error ?? 'The requests failed.');
      return;
    }
    const start = performance.timeOrigin + first;
    const done = requests.filter((r) => r.state === 'done');
    const firsts = done
      .filter((r) => r.ttftMs !== null)
      .map((r) => r.sendOffsetMs + (r.ttftMs ?? 0));
    const failures = requests.filter((r) => r.state === 'failed');
    await this.completeRun(entry, round, run, lead, {
      phases: {
        start,
        firstToken: firsts.length > 0 ? start + Math.min(...firsts) : null,
        lastToken: throughput.totalMs === null ? null : start + throughput.totalMs,
        end: start + (throughput.totalMs ?? performance.now() - first),
      },
      outputTokens: throughput.outputTokens,
      verdict:
        done.length === 0
          ? {
              state: failures.length > 0 ? 'failed' : 'cancelled',
              error: failures[0]?.error ?? null,
            }
          : // Some requests failing leaves the batch done; its request table says which.
            failures.length > 0
            ? { state: 'done', error: null }
            : null,
    });
  }

  private async completeRun(
    entry: ActiveSession,
    round: LiveRound,
    run: LiveRun,
    outcome: StreamOutcome,
    batch: {
      phases: RunPhases;
      outputTokens: number;
      verdict: { state: RunView['state']; error: string | null } | null;
    } | null = null,
  ) {
    const { machine } = run;
    this.flush(entry);
    run.view.loopLagMs = lagOf(round.lag);
    const client = computeClientMetrics(outcome.timeline);
    run.view.client = client;
    const { requestAt, headersAt, endAt, events } = outcome.timeline;
    run.view.timeline = tokenTimeline(events, requestAt);
    const start = performance.timeOrigin + requestAt;
    const firstToken = client.ttftMs === null ? null : start + client.ttftMs;
    entry.phases.set(
      run.view.id,
      batch
        ? { phases: batch.phases, outputTokens: batch.outputTokens }
        : {
            phases: {
              start,
              firstToken,
              lastToken:
                firstToken === null || client.decodeMs === null
                  ? null
                  : firstToken + client.decodeMs,
              end: start + client.totalMs,
            },
            outputTokens: client.outputTokens,
          },
    );
    run.view.raw = {
      headersAtMs: headersAt === null ? null : round3(headersAt - requestAt),
      endAtMs: round3(endAt - requestAt),
      events: compactEvents(events, requestAt),
    };
    const usage = [...events].reverse().find((e) => e.event.type === 'usage')?.event;
    const timings: Timings | null = usage?.type === 'usage' ? usage.timings : null;

    if (round.warmup) {
      run.view.server = { timings, monitor: null };
    } else {
      const prompt = entry.session.workload === 'text' ? entry.session.config.prompt : '';
      const sent = withNonce(prompt, round.view.nonce);
      const [monitor, after] = await Promise.all([
        readMonitorRow(machine, sent),
        readModelStatus(machine),
      ]);
      run.view.server = { timings, monitor };
      run.view.modelAfter = after.status?.activeModel ?? null;
      run.provenance.statusAfter = after.status;
    }

    const verdict = batch?.verdict ?? this.verdict(machine, outcome, client);
    if (round.truncatedBy === machine.name && client.truncated) {
      this.finishRun(entry, round, run, 'failed', 'Unsloth cut the prompt to fit the context.');
      return;
    }
    if (
      verdict.state === 'cancelled' &&
      round.truncatedBy !== null &&
      !entry.controller.signal.aborted
    ) {
      this.finishRun(
        entry,
        round,
        run,
        'cancelled',
        `Stopped because Unsloth cut the prompt on ${round.truncatedBy}.`,
      );
      return;
    }
    this.finishRun(entry, round, run, verdict.state, verdict.error);
  }

  private verdict(
    machine: StoredMachine,
    outcome: StreamOutcome,
    client: ClientMetrics,
  ): { state: RunView['state']; error: string | null } {
    const failed = (error: string) => ({ state: 'failed' as const, error });
    if (outcome.failure === 'cancelled') return { state: 'cancelled', error: null };
    if (outcome.failure === 'idle-timeout') {
      return failed(
        `${machine.name} sent nothing for ${secondsText(this.deps.timings.idleTimeoutMs)}, so the run was stopped.`,
      );
    }
    if (outcome.failure === 'total-timeout') {
      return failed(
        `The run took longer than ${secondsText(this.deps.timings.totalTimeoutMs)} and was stopped.`,
      );
    }
    if (outcome.failure === 'network' && outcome.networkError) {
      if (outcome.timeline.headersAt !== null) {
        return failed(
          `The stream from ${describeAddress(machine.baseUrl)} broke after ${client.chunks} chunks (${outcome.networkError.message}).`,
        );
      }
      const { title, hint } = explainNetworkError(outcome.networkError, machine.baseUrl);
      return failed(`${title} ${hint}`);
    }
    if (outcome.failure === 'http') {
      const route = {
        path: '/v1/chat/completions',
        status: outcome.status,
        ms: null,
        contentType: null,
        body: outcome.errorBody,
        error: null,
      };
      return failed(detailOf(outcome.errorBody) || describeRouteFailure(route, machine.baseUrl));
    }
    const inBandError = outcome.timeline.events.find((e) => e.event.type === 'error')?.event;
    if (inBandError?.type === 'error') return failed(`Unsloth reported: ${inBandError.message}`);
    if (!client.sawDone && client.finishReason === null) {
      return failed('The stream ended before Unsloth said it was done.');
    }
    return { state: 'done', error: null };
  }

  private async finishSession(entry: ActiveSession, state: SessionState, error: string | null) {
    const { session } = entry;
    if (session.finishedAt !== null) return;
    // Normally every run has ended by now; this only closes runs an unexpected error left open.
    const current = entry.current;
    if (current) {
      for (const run of current.runs) {
        if (state === 'cancelled') this.finishRun(entry, current, run, 'cancelled', null);
        else this.finishRun(entry, current, run, 'failed', error ?? 'The run did not finish.');
      }
    }
    session.state = state;
    session.error = error;
    session.finishedAt = new Date().toISOString();
    session.progress = { phase: 'finished', round: null };
    try {
      await this.deps.sessions.save(session);
    } catch (failure) {
      this.deps.log.error({ err: failure, sessionId: session.id }, 'could not save the race');
      session.error ??= `The race could not be saved: ${(failure as Error).message}`;
    }
    this.recent.set(session.id, session);
    while (this.recent.size > KEEP_RECENT) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
    this.active.delete(session.id);
    this.broadcast(entry, { type: 'finished', session: publicSession(structuredClone(session)) });
    entry.listeners.clear();
    this.deps.log.info({ sessionId: session.id, state }, 'race finished');
  }
}
