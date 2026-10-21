import {
  hasErrors,
  hasWarnings,
  imagePrompt,
  type PreflightIssue,
  type PreflightRequest,
  type PreflightResult,
  type SessionRequest,
  type SessionView,
} from '@duel/shared';
import type { AudioStore } from './audio';
import { platformName, runImagePreflight, runPreflight, runTranscribePreflight } from './preflight';
import { resolvePrompt } from './presets';
import type { SessionManager } from './sessions';
import type { MachineStore, StoredMachine } from './store';

/** Why a race or a suite did not start, as the API answers it. */
export interface Refusal {
  status: number;
  error: string;
  message: string;
  issues?: PreflightIssue[];
}

export type RaceStart = { ok: true; session: SessionView } | ({ ok: false } & Refusal);

const refuse = (
  status: number,
  error: string,
  message: string,
  issues?: PreflightIssue[],
): { ok: false } & Refusal => ({
  ok: false,
  status,
  error,
  message,
  ...(issues ? { issues } : {}),
});

export const RACE_RUNNING = 'A race is already running. Wait for it to finish or cancel it first.';
export const SUITE_RUNNING =
  'A suite is running its races one after another. Wait for it to finish, or cancel it on the Suites tab.';

/**
 * The one race slot. Every race starts here, from the Text, Transcribe and Image tabs and from a
 * suite: the machine check, the busy check, pre-flight and its refusals are the same for all.
 * While a suite runs the slot is the suite's, and only its own races start.
 */
export class RaceStarter {
  /** Pre-flight waits on the machines, so the slot is held from the first request. */
  private starting = false;
  private suiteId: string | null = null;
  private closed = false;

  constructor(
    private readonly deps: {
      store: MachineStore;
      sessions: SessionManager;
      /** True while a model load runs on the machine. */
      isLoading: (machineId: string) => boolean;
      audio: AudioStore;
    },
  ) {}

  /** The fairness checks for a race that has not started. */
  preflight(machines: StoredMachine[], request: PreflightRequest): Promise<PreflightResult> {
    const { store, isLoading, audio } = this.deps;
    return request.workload === 'text'
      ? runPreflight(machines, request.config, isLoading)
      : request.workload === 'transcribe'
        ? runTranscribePreflight(machines, request.config, isLoading, audio)
        : runImagePreflight(machines, request.config, isLoading, (id) =>
            platformName(store.lastProbe(id)?.report ?? null),
          );
  }

  /** True while a race runs or is in pre-flight. */
  private raceBusy(): boolean {
    return this.deps.sessions.running() !== null || this.starting;
  }

  /** Holds the slot for a suite until it is released; a refusal when it is taken. */
  claimForSuite(suiteId: string): Refusal | null {
    if (this.suiteId !== null) {
      return {
        status: 409,
        error: 'suite_running',
        message: 'A suite is already running. Wait for it to finish or cancel it first.',
      };
    }
    if (this.raceBusy()) {
      return {
        status: 409,
        error: 'busy',
        message: 'A race is running. Wait for it to finish or cancel it, then start the suite.',
      };
    }
    this.suiteId = suiteId;
    return null;
  }

  releaseSuite(suiteId: string): void {
    if (this.suiteId === suiteId) this.suiteId = null;
  }

  /** Starts nothing more: Model Duel is stopping. */
  close(): void {
    this.closed = true;
  }

  /**
   * Pre-flight, then the race. A suite passes its id, which lets its own races through while it
   * holds the slot.
   */
  async start(request: SessionRequest, suiteId: string | null = null): Promise<RaceStart> {
    const machines = request.machineIds.map((id) => this.deps.store.get(id));
    if (machines.some((machine) => !machine)) {
      return refuse(404, 'not_found', 'There is no machine with that id.');
    }
    if (this.suiteId !== null && this.suiteId !== suiteId) {
      return refuse(409, 'suite_running', SUITE_RUNNING);
    }
    if (this.raceBusy()) return refuse(409, 'busy', RACE_RUNNING);
    if (this.closed) return refuse(503, 'closing', 'Model Duel is stopping.');
    this.starting = true;
    try {
      const ready = machines as StoredMachine[];
      const checked = await this.preflight(ready, request);
      if (hasErrors(checked.issues)) {
        const first = checked.issues.find((issue) => issue.level === 'error');
        return refuse(400, 'preflight', first?.text ?? 'Pre-flight failed.', checked.issues);
      }
      if (hasWarnings(checked.issues) && !request.acknowledgeWarnings) {
        return refuse(
          409,
          'preflight_warnings',
          'Pre-flight found differences between the machines. Race anyway to start.',
          checked.issues,
        );
      }
      if (this.closed) return refuse(503, 'closing', 'Model Duel is stopping.');
      const session = this.deps.sessions.start(
        ready,
        request.workload === 'text'
          ? { ...request, config: { ...request.config, prompt: resolvePrompt(request.config) } }
          : request.workload === 'image'
            ? { ...request, config: { ...request.config, prompt: imagePrompt(request.config) } }
            : request,
      );
      return { ok: true, session };
    } finally {
      this.starting = false;
    }
  }
}
