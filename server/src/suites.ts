import { randomUUID } from 'node:crypto';
import {
  comboRequest,
  expandSuite,
  SUITE_SCHEMA_VERSION,
  suiteResults,
  summarizeSuite,
  type Suite,
  type SuiteRace,
  type SuiteRequest,
  type SuiteSummary,
} from '@duel/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { RaceStart, RaceStarter, Refusal } from './races';
import type { SessionManager } from './sessions';
import type { MachineStore, StoredMachine } from './store';
import type { SuiteStore } from './suite-store';

interface ActiveSuite {
  suite: Suite;
  cancelled: boolean;
  /** The session of the race running now. */
  sessionId: string | null;
  done: Promise<void>;
}

export type SuiteStart = { ok: true; suite: Suite } | ({ ok: false } & Refusal);

/**
 * Runs suites: one text race per combination, one after another, each through `RaceStarter` like
 * a race from the Text tab. A race pre-flight refuses is skipped and a race that fails is kept as
 * failed; either way the suite goes on. One suite runs at a time, and while it runs it holds the
 * race slot. Cancelling stops the race in progress and the rest.
 */
export class SuiteManager {
  private active: ActiveSuite | null = null;
  private closing = false;

  constructor(
    private readonly deps: {
      suites: SuiteStore;
      races: RaceStarter;
      sessions: SessionManager;
      machines: MachineStore;
      log: FastifyBaseLogger;
    },
  ) {}

  list(): SuiteSummary[] {
    const summaries = new Map<string, SuiteSummary>();
    for (const summary of this.deps.suites.summaries()) summaries.set(summary.id, summary);
    if (this.active) summaries.set(this.active.suite.id, summarizeSuite(this.active.suite));
    return [...summaries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<Suite | null> {
    if (this.active?.suite.id === id) return structuredClone(this.active.suite);
    return this.deps.suites.load(id);
  }

  start(request: SuiteRequest): SuiteStart {
    const machines = request.machineIds.map((id) => this.deps.machines.get(id));
    if (machines.some((machine) => !machine)) {
      return {
        ok: false,
        status: 404,
        error: 'not_found',
        message: 'There is no machine with that id.',
      };
    }
    if (this.closing) {
      return { ok: false, status: 503, error: 'closing', message: 'Model Duel is stopping.' };
    }
    const id = randomUUID();
    const refused = this.deps.races.claimForSuite(id);
    if (refused) return { ok: false, ...refused };
    const { machineIds: _ids, ...settings } = request;
    const suite: Suite = {
      schemaVersion: SUITE_SCHEMA_VERSION,
      id,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      state: 'running',
      error: null,
      machines: (machines as StoredMachine[]).map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
      })),
      settings: structuredClone(settings),
      races: expandSuite(settings).map((combo, index) => ({
        index,
        combo,
        state: 'queued',
        sessionId: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        issues: [],
        results: [],
      })),
    };
    const entry: ActiveSuite = {
      suite,
      cancelled: false,
      sessionId: null,
      done: Promise.resolve(),
    };
    this.active = entry;
    entry.done = this.execute(entry)
      .catch(async (error: unknown) => {
        this.deps.log.error({ err: error, suiteId: id }, 'suite stopped by an error');
        if (this.closing) return;
        suite.state = 'failed';
        suite.error = `Model Duel stopped the suite: ${(error as Error).message}`;
        suite.finishedAt = new Date().toISOString();
        await this.save(entry);
      })
      .finally(() => {
        if (this.active === entry) this.active = null;
        this.deps.races.releaseSuite(id);
      });
    return { ok: true, suite: structuredClone(suite) };
  }

  /** Stops the race in progress through the race's own cancel, and every race after it. */
  async cancel(id: string): Promise<Suite | null> {
    const entry = this.active;
    if (!entry || entry.suite.id !== id) return this.get(id);
    entry.cancelled = true;
    if (entry.sessionId) await this.deps.sessions.cancel(entry.sessionId);
    await entry.done;
    return this.get(id);
  }

  /** Deletes a suite's record. Its races stay in the results log. */
  async remove(id: string): Promise<'deleted' | 'running' | 'missing'> {
    if (this.active?.suite.id === id) return 'running';
    return (await this.deps.suites.remove(id)) ? 'deleted' : 'missing';
  }

  /** Waits for a suite to end; for tests. */
  async settled(id: string): Promise<void> {
    if (this.active?.suite.id === id) await this.active.done;
  }

  /**
   * Stops a running suite where it is, without starting another race. Its file still says
   * running, so the next start marks it interrupted; the race in progress is stopped with every
   * other race when the sessions close.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.deps.races.close();
    await this.active?.done;
  }

  private async save(entry: ActiveSuite): Promise<void> {
    try {
      await this.deps.suites.save(entry.suite);
    } catch (failure) {
      this.deps.log.error({ err: failure, suiteId: entry.suite.id }, 'could not save the suite');
      entry.suite.error ??= `The suite could not be saved: ${(failure as Error).message}`;
    }
  }

  private async execute(entry: ActiveSuite): Promise<void> {
    const { suite } = entry;
    // A record exists from the start, so a crash leaves an interrupted suite instead of nothing.
    await this.save(entry);
    for (const race of suite.races) {
      if (entry.cancelled || this.closing) break;
      await this.runRace(entry, race);
    }
    if (this.closing) return;
    const now = new Date().toISOString();
    for (const race of suite.races) {
      if (race.state !== 'queued') continue;
      race.state = 'cancelled';
      race.error = 'The suite was cancelled before this race started.';
    }
    suite.state = entry.cancelled ? 'cancelled' : 'done';
    suite.finishedAt = now;
    await this.save(entry);
    this.deps.log.info({ suiteId: suite.id, state: suite.state }, 'suite finished');
  }

  private async runRace(entry: ActiveSuite, race: SuiteRace): Promise<void> {
    const { suite } = entry;
    race.state = 'running';
    race.startedAt = new Date().toISOString();
    await this.save(entry);
    let started: RaceStart;
    try {
      started = await this.deps.races.start(comboRequest(suite, race.combo), suite.id);
    } catch (error) {
      this.deps.log.error({ err: error, suiteId: suite.id }, 'a suite race did not start');
      started = {
        ok: false,
        status: 500,
        error: 'internal',
        message: `Model Duel could not start this race: ${(error as Error).message}`,
      };
    }
    if (this.closing) return;
    if (!started.ok) {
      // Refused before it began: pre-flight said no, or a machine is gone.
      race.state = started.status === 500 ? 'failed' : 'skipped';
      race.error = started.message;
      race.issues = (started.issues ?? []).filter((issue) => issue.level !== 'note');
      race.finishedAt = new Date().toISOString();
      await this.save(entry);
      return;
    }
    const sessionId = started.session.id;
    race.sessionId = sessionId;
    entry.sessionId = sessionId;
    await this.save(entry);
    // Cancelled while pre-flight ran: stop the race that has just started.
    if (entry.cancelled) await this.deps.sessions.cancel(sessionId);
    await this.deps.sessions.settled(sessionId);
    entry.sessionId = null;
    if (this.closing) return;
    const view = await this.deps.sessions.get(sessionId);
    race.finishedAt = view?.finishedAt ?? new Date().toISOString();
    race.results = view ? suiteResults(view) : [];
    race.state = !view
      ? 'failed'
      : view.state === 'done' || view.state === 'cancelled' || view.state === 'interrupted'
        ? view.state
        : 'failed';
    race.error = view ? view.error : 'The race was deleted before it finished.';
    await this.save(entry);
  }
}
