import {
  availabilityOf,
  interpretLoadResponse,
  loadRequestSchema,
  type ApiErrorBody,
  type LoadStartResult,
  type MachineStatusView,
} from '@duel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { LoadManager, LoadTimings } from '../loads';
import { readModelStatus, type ModelCatalog } from '../models';
import { startChatReload } from '../restore';
import type { MachineStore, StoredMachine } from '../store';
import { UnslothClient } from '../unsloth';

interface IdParams {
  Params: { id: string };
}

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  const body: ApiErrorBody = { error, message };
  return reply.code(status).send(body);
}

export function registerModelRoutes(
  app: FastifyInstance,
  deps: { store: MachineStore; catalog: ModelCatalog; loads: LoadManager; timings: LoadTimings },
): void {
  const { store, catalog, loads, timings } = deps;

  const statusView = async (machine: StoredMachine): Promise<MachineStatusView> => {
    if (machine.cloud) {
      // A cloud model has no Unsloth status; its model is the one chosen for it.
      return {
        machineId: machine.id,
        status: null,
        error: null,
        job: null,
        checkedAt: new Date().toISOString(),
      };
    }
    const { status, error } = await readModelStatus(machine);
    return {
      machineId: machine.id,
      status,
      error,
      job: loads.job(machine.id),
      checkedAt: new Date().toISOString(),
    };
  };

  /**
   * Loads the machine's chat model again with more request slots, keeping its other settings:
   * pre-flight's shortcut when a throughput race asks for more requests than the model serves.
   */
  app.post<IdParams>('/api/machines/:id/reload-slots', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return fail(reply, 404, 'not_found', 'There is no machine with that id.');
    const parsed = z.object({ slots: z.number().int().min(1).max(64) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'Ask for 1 to 64 slots.');
    const { status, error } = await readModelStatus(machine);
    if (!status?.activeModel) {
      return fail(reply, 409, 'no_model', error ?? `No model is loaded on ${machine.name}.`);
    }
    const started = await startChatReload({ catalog, loads, store }, machine, status, {
      parallelSlots: parsed.data.slots,
    });
    if ('error' in started) return fail(reply, 409, 'reload', started.error);
    return reply.code(202).send({ job: started.job });
  });

  app.get<IdParams & { Querystring: { refresh?: string } }>(
    '/api/machines/:id/models',
    async (request, reply) => {
      const machine = store.get(request.params.id);
      if (!machine) return fail(reply, 404, 'not_found', 'There is no machine with that id.');
      return catalog.list(machine, { refresh: request.query.refresh === '1' });
    },
  );

  app.get<IdParams>('/api/machines/:id/status', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return fail(reply, 404, 'not_found', 'There is no machine with that id.');
    return statusView(machine);
  });

  // serverTime lets a browser on another computer show elapsed times despite clock drift.
  app.get('/api/loads', async () => ({ jobs: loads.jobs(), serverTime: new Date().toISOString() }));

  app.post('/api/models/load', async (request, reply) => {
    const parsed = loadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        reply,
        400,
        'validation',
        issue ? issue.message : 'The load request is not valid.',
      );
    }
    const { machineIds, modelId, quant, settings } = parsed.data;
    const results = await Promise.all(
      [...new Set(machineIds)].map(async (machineId): Promise<LoadStartResult> => {
        const skip = (reason: string): LoadStartResult => ({
          machineId,
          started: false,
          job: null,
          reason,
        });
        const machine = store.get(machineId);
        if (!machine) return skip('There is no machine with that id.');
        if (loads.isActive(machineId)) return skip('A load is already running on this machine.');
        const view = await catalog.list(machine);
        if (view.error !== null) return skip(view.error);
        const availability = availabilityOf(view.models, modelId, quant);
        if (availability.state !== 'ready' || !availability.model)
          return skip(availability.message);
        const job = loads.start(machine, availability.model, quant, settings);
        catalog.invalidate(machineId);
        return { machineId, started: true, job, reason: null };
      }),
    );
    request.log.info(
      { modelId, quant, started: results.filter((r) => r.started).length, asked: results.length },
      'model load requested',
    );
    return { results };
  });

  app.post<IdParams>('/api/machines/:id/load/cancel', async (request, reply) => {
    if (!store.get(request.params.id))
      return fail(reply, 404, 'not_found', 'There is no machine with that id.');
    const job = await loads.cancel(request.params.id);
    if (!job) return fail(reply, 409, 'no_load', 'No load is running on this machine.');
    return { job };
  });

  app.post<IdParams>('/api/machines/:id/unload', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return fail(reply, 404, 'not_found', 'There is no machine with that id.');
    if (loads.isActive(machine.id)) {
      return fail(
        reply,
        409,
        'load_running',
        'A load is running on this machine. Cancel it first.',
      );
    }
    const before = await readModelStatus(machine);
    if (before.error !== null) return fail(reply, 502, 'unreachable', before.error);
    if (!before.status?.modelIdentifier)
      return fail(reply, 409, 'nothing_loaded', 'No model is loaded on this machine.');
    const client = new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 5000 });
    try {
      const answer = await client.postJson(
        '/api/inference/unload',
        { model_path: before.status.modelIdentifier },
        { timeoutMs: timings.unloadTimeoutMs, headersTimeoutMs: 60_000, bodyTimeoutMs: 120_000 },
      );
      const outcome = interpretLoadResponse(answer, machine.baseUrl);
      if (outcome.kind === 'failed') return fail(reply, 502, 'unload_failed', outcome.message);
    } finally {
      await client.close();
    }
    catalog.invalidate(machine.id);
    request.log.info({ machineId: machine.id }, 'model unloaded');
    return statusView(machine);
  });
}
