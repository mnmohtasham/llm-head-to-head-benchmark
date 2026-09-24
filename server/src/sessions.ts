import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import {
  chatRequestBody,
  compactEvents,
  computeClientMetrics,
  DEFAULT_SAMPLING,
  describeAddress,
  describeRouteFailure,
  detailOf,
  explainNetworkError,
  isTokenEvent,
  publicRun,
  publicSession,
  SESSION_SCHEMA_VERSION,
  summarizeSession,
  type ClientMetrics,
  type LiveMetrics,
  type MachineProvenance,
  type RunDelta,
  type RunView,
  type SessionRequest,
  type SessionState,
  type SessionStreamMessage,
  type SessionSummary,
  type SessionView,
  type StoredRun,
  type StoredSession,
  type TimedEvent,
  type Timings,
} from '@duel/shared';
import type { FastifyBaseLogger } from 'fastify';
import { streamChatCompletion, type StreamOutcome } from './chat-stream';
import { readModelStatus } from './models';
import { cancelOnMachine, readMonitorRow } from './monitor';
import type { SessionStore } from './session-store';
import type { MachineStore, StoredMachine } from './store';

export interface RunTimings {
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  /** How often text and live numbers go to the browser. */
  flushEveryMs: number;
}

export const DEFAULT_RUN_TIMINGS: RunTimings = {
  idleTimeoutMs: 120_000,
  totalTimeoutMs: 30 * 60_000,
  flushEveryMs: 50,
};

/** Finished sessions kept in memory, so the page does not wait for the disk right after a race. */
const KEEP_RECENT = 5;

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

interface ActiveSession {
  session: StoredSession;
  runs: LiveRun[];
  controller: AbortController;
  listeners: Set<Listener>;
  lag: IntervalHistogram;
  done: Promise<void>;
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

function newRun(machine: StoredMachine, request: SessionRequest): StoredRun {
  const { config } = request;
  return {
    id: randomUUID(),
    machineId: machine.id,
    machineName: machine.name,
    prompt: config.prompt,
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
    raw: null,
  };
}

/**
 * Runs sessions: the same prompt on every chosen machine, sent in the same tick, each machine
 * streaming on its own so that one failure never stops the others. One session runs at a time.
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
    const runs: LiveRun[] = machines.map((machine) => ({
      view: newRun(machine, request),
      machine,
      provenance: this.provenanceOf(machine),
      unsentReasoning: '',
      unsentAnswer: '',
      requestAt: null,
      firstTokenAt: null,
      lastTokenAt: null,
    }));
    const session: StoredSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      workload: 'text',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      state: 'running',
      error: null,
      config: { ...request.config, sampling: { ...DEFAULT_SAMPLING } },
      machines: machines.map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        baseUrl: m.baseUrl,
        notes: m.notes,
      })),
      rounds: [{ index: 0, startedAt: null, sendSkewMs: null, runs: runs.map((r) => r.view) }],
      provenance: runs.map((r) => r.provenance),
      loopLagMs: null,
    };
    const entry: ActiveSession = {
      session,
      runs,
      controller: new AbortController(),
      listeners: new Set(),
      lag: monitorEventLoopDelay({ resolution: 10 }),
      done: Promise.resolve(),
    };
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
    await Promise.allSettled(
      entry.runs
        .filter((run) => run.requestAt !== null && run.view.finishedAt === null)
        .map((run) => cancelOnMachine(run.machine, run.view.id)),
    );
    await entry.done;
    return this.get(id);
  }

  /** Deletes a finished session. */
  async remove(id: string): Promise<'deleted' | 'running' | 'missing'> {
    if (this.active.has(id)) return 'running';
    this.recent.delete(id);
    return (await this.deps.sessions.remove(id)) ? 'deleted' : 'missing';
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
    };
  }

  private broadcast(entry: ActiveSession, message: SessionStreamMessage) {
    for (const listener of entry.listeners) listener(message);
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
    const runs: RunDelta[] = [];
    for (const run of entry.runs) {
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
    if (runs.length > 0) this.broadcast(entry, { type: 'delta', round: 0, runs });
  }

  private onEvent(run: LiveRun, timed: TimedEvent) {
    const { event } = timed;
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
    this.broadcast(entry, { type: 'run', round: 0, run: publicRun(structuredClone(run.view)) });
  }

  /** Reads the model on a machine before the race. Returns the model, or null when the run failed. */
  private async prepare(entry: ActiveSession, run: LiveRun): Promise<string | null> {
    const { machine } = run;
    if (this.deps.isLoading(machine.id)) {
      this.finishRun(
        entry,
        run,
        'failed',
        `A model is loading on ${machine.name}. Wait for it to finish, then start again.`,
      );
      return null;
    }
    const before = await readModelStatus(machine);
    run.provenance.statusBefore = before.status;
    if (before.error !== null) {
      this.finishRun(entry, run, 'failed', before.error);
      return null;
    }
    const model = before.status?.activeModel ?? null;
    run.view.modelBefore = model;
    if (!model) {
      this.finishRun(
        entry,
        run,
        'failed',
        `No model is loaded on ${machine.name}. Load one on the Models tab first.`,
      );
      return null;
    }
    return model;
  }

  private async execute(entry: ActiveSession): Promise<void> {
    const { session, runs, controller } = entry;
    const round = session.rounds[0];
    if (!round) throw new Error('A session needs a round.');
    // A record exists from the start, so a crash leaves an interrupted race instead of nothing.
    await this.deps.sessions.save(session);
    entry.lag.enable();
    const timer = setInterval(() => this.flush(entry), this.deps.timings.flushEveryMs);
    try {
      // Every machine's status first, so the requests themselves can leave together.
      const models = await Promise.all(runs.map((run) => this.prepare(entry, run)));
      if (controller.signal.aborted) {
        for (const run of runs) this.finishRun(entry, run, 'cancelled', null);
      } else {
        const bodies = runs.map((run, i) => {
          const model = models[i];
          return model ? chatRequestBody(session.config, model, run.view.id) : null;
        });
        round.startedAt = new Date().toISOString();
        const pending: Array<Promise<void>> = [];
        // Same tick: nothing in this loop waits.
        for (const [i, run] of runs.entries()) {
          const body = bodies[i];
          if (!body) continue;
          run.provenance.request = body;
          run.view.state = 'streaming';
          run.requestAt = performance.now();
          const outcome = streamChatCompletion(run.machine.baseUrl, run.machine.apiKey, body, {
            signal: controller.signal,
            idleTimeoutMs: this.deps.timings.idleTimeoutMs,
            totalTimeoutMs: this.deps.timings.totalTimeoutMs,
            onEvent: (timed) => this.onEvent(run, timed),
          });
          pending.push(
            outcome
              .then((result) => this.completeRun(entry, run, result))
              .catch((error: unknown) =>
                this.finishRun(
                  entry,
                  run,
                  'failed',
                  `Model Duel stopped this run: ${(error as Error).message}`,
                ),
              ),
          );
        }
        const sent = runs.filter((run) => run.requestAt !== null);
        if (sent.length > 0) {
          const first = Math.min(...sent.map((run) => run.requestAt ?? 0));
          const last = Math.max(...sent.map((run) => run.requestAt ?? 0));
          round.sendSkewMs = round3(last - first);
          for (const run of sent) run.view.sendOffsetMs = round3((run.requestAt ?? 0) - first);
        }
        await Promise.all(pending);
      }
    } finally {
      clearInterval(timer);
      entry.lag.disable();
    }
    session.loopLagMs = lagOf(entry.lag);
    const states = runs.map((run) => run.view.state);
    const state: SessionState = controller.signal.aborted
      ? 'cancelled'
      : states.every((s) => s === 'failed')
        ? 'failed'
        : 'done';
    await this.finishSession(
      entry,
      state,
      state === 'failed' ? 'Every machine in the race failed. Each pane says why.' : null,
    );
  }

  private async completeRun(entry: ActiveSession, run: LiveRun, outcome: StreamOutcome) {
    const { machine } = run;
    const { config } = entry.session;
    this.flush(entry);
    run.view.loopLagMs = lagOf(entry.lag);
    const client = computeClientMetrics(outcome.timeline);
    run.view.client = client;
    const { requestAt, headersAt, endAt, events } = outcome.timeline;
    run.view.raw = {
      headersAtMs: headersAt === null ? null : round3(headersAt - requestAt),
      endAtMs: round3(endAt - requestAt),
      events: compactEvents(events, requestAt),
    };
    const usage = [...events].reverse().find((e) => e.event.type === 'usage')?.event;
    const timings: Timings | null = usage?.type === 'usage' ? usage.timings : null;

    const [monitor, after] = await Promise.all([
      readMonitorRow(machine, config.prompt),
      readModelStatus(machine),
    ]);
    run.view.server = { timings, monitor };
    run.view.modelAfter = after.status?.activeModel ?? null;
    run.provenance.statusAfter = after.status;

    const verdict = this.verdict(machine, outcome, client);
    this.finishRun(entry, run, verdict.state, verdict.error);
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
    for (const run of entry.runs) {
      if (state === 'cancelled') this.finishRun(entry, run, 'cancelled', null);
      else this.finishRun(entry, run, 'failed', error ?? 'The run did not finish.');
    }
    session.state = state;
    session.error = error;
    session.finishedAt = new Date().toISOString();
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
