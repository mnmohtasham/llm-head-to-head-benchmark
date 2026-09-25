import { randomUUID } from 'node:crypto';
import {
  interpretLoadResponse,
  localQuantName,
  normalizeLoadProgress,
  unslothLoadBody,
  type LoadJob,
  type LoadSettings,
  type LocalModel,
} from '@duel/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { MachineStore, StoredMachine } from './store';
import { UnslothClient } from './unsloth';

export interface LoadTimings {
  /** A load of a large model from a slow disk can take many minutes. */
  loadTimeoutMs: number;
  progressEveryMs: number;
  unloadTimeoutMs: number;
}

export const DEFAULT_LOAD_TIMINGS: LoadTimings = {
  loadTimeoutMs: 30 * 60_000,
  progressEveryMs: 500,
  unloadTimeoutMs: 5 * 60_000,
};

// Unsloth answers a load within 15 s or starts padding every 20 s, so these only catch a dead link.
const HEADERS_TIMEOUT_MS = 60_000;
const BODY_SILENCE_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Running {
  job: LoadJob;
  machine: StoredMachine;
  loadId: string;
  client: UnslothClient;
  stopPolling: () => void;
  done: Promise<void>;
}

/** Runs at most one load per machine and remembers the last one. */
export class LoadManager {
  private readonly running = new Map<string, Running>();
  /** Finished loads, kept here until the store has them, so a reader never sees a stale one. */
  private readonly finished = new Map<string, LoadJob>();
  /** Every load until its result is saved, which is after it leaves `running`. */
  private readonly unsaved = new Set<Promise<void>>();

  constructor(
    private readonly store: MachineStore,
    private readonly timings: LoadTimings,
    private readonly log: FastifyBaseLogger,
  ) {}

  isActive(machineId: string): boolean {
    return this.running.has(machineId);
  }

  /** The running load, or the last finished one. */
  job(machineId: string): LoadJob | null {
    const run = this.running.get(machineId);
    if (run) return structuredClone(run.job);
    const last = this.finished.get(machineId) ?? this.store.lastLoad(machineId);
    return last ? structuredClone(last) : null;
  }

  jobs(): LoadJob[] {
    return this.store
      .list()
      .map((machine) => this.job(machine.id))
      .filter((job): job is LoadJob => job !== null);
  }

  /** Wait for a running load to finish; used by tests and shutdown. */
  async settled(machineId: string): Promise<void> {
    await this.running.get(machineId)?.done;
  }

  start(
    machine: StoredMachine,
    model: LocalModel,
    quant: string | null,
    settings: LoadSettings,
  ): LoadJob {
    if (this.running.has(machine.id)) throw new Error('A load is already running on this machine.');
    const job: LoadJob = {
      id: `duel-${randomUUID()}`,
      machineId: machine.id,
      modelId: model.modelId,
      displayName: model.displayName,
      format: model.format,
      quant: localQuantName(model, quant),
      settings,
      state: 'loading',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      progress: null,
      alreadyLoaded: false,
      memoryWarning: null,
      error: null,
    };
    const client = new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 5000 });
    const started = performance.now();
    let polling = true;

    const poll = (async () => {
      while (polling) {
        const answer = await client.getJson('/api/inference/load-progress', { timeoutMs: 5000 });
        const progress = answer.status === 200 ? normalizeLoadProgress(answer.body) : null;
        if (polling && progress && progress.phase !== null) job.progress = progress;
        await sleep(this.timings.progressEveryMs);
      }
    })();

    const done = (async () => {
      let end: Pick<LoadJob, 'state' | 'alreadyLoaded' | 'memoryWarning' | 'error'>;
      try {
        const answer = await client.postJson(
          '/api/inference/load',
          unslothLoadBody(model, quant, settings, job.id),
          {
            timeoutMs: this.timings.loadTimeoutMs,
            headersTimeoutMs: HEADERS_TIMEOUT_MS,
            bodyTimeoutMs: BODY_SILENCE_TIMEOUT_MS,
          },
        );
        const outcome = interpretLoadResponse(answer, machine.baseUrl);
        end =
          outcome.kind === 'loaded'
            ? {
                state: 'loaded',
                alreadyLoaded: outcome.alreadyLoaded,
                memoryWarning: outcome.memoryWarning,
                error: null,
              }
            : outcome.kind === 'cancelled'
              ? { state: 'cancelled', alreadyLoaded: false, memoryWarning: null, error: null }
              : {
                  state: 'failed',
                  alreadyLoaded: false,
                  memoryWarning: null,
                  error: outcome.message,
                };
      } catch (error) {
        end = {
          state: 'failed',
          alreadyLoaded: false,
          memoryWarning: null,
          error: `Model Duel could not finish the load: ${(error as Error).message}`,
        };
      }
      // The load time ends when Unsloth answers. Everything about the end is set in one step.
      polling = false;
      Object.assign(job, end, {
        durationMs: Math.round(performance.now() - started),
        finishedAt: new Date().toISOString(),
      });
      if (job.state === 'loaded' && job.progress) {
        job.progress = {
          ...job.progress,
          phase: 'ready',
          fraction: 1,
          bytesLoaded: job.progress.bytesTotal,
        };
      }
      this.finished.set(machine.id, structuredClone(job));
      this.running.delete(machine.id);
      await poll;
      await client.close();
      try {
        await this.store.saveLoad(structuredClone(job));
        if (this.finished.get(machine.id)?.id === job.id) this.finished.delete(machine.id);
      } catch (error) {
        this.log.error({ err: error, machineId: machine.id }, 'could not save the load result');
      }
      this.log.info(
        { machineId: machine.id, state: job.state, durationMs: job.durationMs },
        'model load finished',
      );
    })();

    this.running.set(machine.id, {
      job,
      machine,
      loadId: model.loadId,
      client,
      stopPolling: () => {
        polling = false;
      },
      done,
    });
    this.unsaved.add(done);
    void done.finally(() => this.unsaved.delete(done)).catch(() => undefined);
    return structuredClone(job);
  }

  /** Asks Unsloth to cancel this app's load. The load call then ends with "Model load cancelled". */
  async cancel(machineId: string): Promise<LoadJob | null> {
    const run = this.running.get(machineId);
    if (!run) return null;
    run.job.state = 'cancelling';
    const client = new UnslothClient(run.machine.baseUrl, run.machine.apiKey, {
      connectTimeoutMs: 5000,
    });
    try {
      await client.postJson(
        '/api/inference/unload',
        { model_path: run.loadId, cancel_load_request_id: run.job.id },
        { timeoutMs: this.timings.unloadTimeoutMs },
      );
    } finally {
      await client.close();
    }
    return structuredClone(run.job);
  }

  /** Stops watching every load. A load already sent keeps running on its machine. */
  async close(): Promise<void> {
    const runs = [...this.running.values()];
    for (const run of runs) {
      run.stopPolling();
      await run.client.close();
    }
    // Also the loads that just finished, so their results are on disk before the app stops.
    await Promise.allSettled([...this.unsaved]);
  }
}
