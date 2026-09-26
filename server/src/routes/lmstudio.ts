import type { ApiErrorBody } from '@duel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { lmLoad, lmUnload, readLmModels } from '../lmstudio';
import type { MachineStore, StoredMachine } from '../store';

interface IdParams {
  Params: { id: string };
}

const fail = (reply: FastifyReply, status: number, error: string, message: string) => {
  const body: ApiErrorBody = { error, message };
  return reply.code(status).send(body);
};

const loadSchema = z
  .object({
    model: z.string().min(1).max(300),
    contextLength: z.number().int().min(256).max(10_000_000).optional(),
    flashAttention: z.boolean().optional(),
    parallel: z.number().int().min(1).max(64).optional(),
  })
  .strict();

/**
 * LM Studio's models on the Models tab: what is downloaded and loaded, and loading and unloading
 * through LM Studio's own REST API.
 */
export function registerLmStudioRoutes(
  app: FastifyInstance,
  deps: { store: MachineStore; loadTimeoutMs: number },
): void {
  const { store } = deps;
  /** Loads in flight, one per machine, so a double click does not load twice. */
  const loading = new Map<string, string>();

  const lmMachine = (id: string, reply: FastifyReply): StoredMachine | null => {
    const machine = store.get(id);
    if (!machine) {
      void fail(reply, 404, 'not_found', 'There is no machine with that id.');
      return null;
    }
    if (machine.server !== 'lmstudio' || machine.cloud) {
      void fail(reply, 400, 'not_lmstudio', `${machine.name} does not run LM Studio.`);
      return null;
    }
    return machine;
  };

  app.get<IdParams>('/api/machines/:id/lmstudio/models', async (request, reply) => {
    const machine = lmMachine(request.params.id, reply);
    if (!machine) return reply;
    const { models, error } = await readLmModels(machine);
    return {
      machineId: machine.id,
      models: models ?? [],
      loading: loading.get(machine.id) ?? null,
      error,
      fetchedAt: new Date().toISOString(),
    };
  });

  app.post<IdParams>('/api/machines/:id/lmstudio/load', async (request, reply) => {
    const machine = lmMachine(request.params.id, reply);
    if (!machine) return reply;
    const parsed = loadSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'That is not a model to load.');
    if (loading.has(machine.id)) {
      return fail(
        reply,
        409,
        'loading',
        `${loading.get(machine.id)} is loading on ${machine.name}.`,
      );
    }
    loading.set(machine.id, parsed.data.model);
    try {
      const outcome = await lmLoad(machine, parsed.data, deps.loadTimeoutMs);
      if (!outcome.ok) return fail(reply, 502, 'load_failed', outcome.error);
      request.log.info(
        { machineId: machine.id, model: parsed.data.model, seconds: outcome.seconds },
        'LM Studio model loaded',
      );
      return { loaded: parsed.data.model, seconds: outcome.seconds };
    } finally {
      loading.delete(machine.id);
    }
  });

  app.post<IdParams>('/api/machines/:id/lmstudio/unload', async (request, reply) => {
    const machine = lmMachine(request.params.id, reply);
    if (!machine) return reply;
    const parsed = z
      .object({ instanceId: z.string().min(1).max(300) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'Name the loaded model to unload.');
    const outcome = await lmUnload(machine, parsed.data.instanceId);
    if (!outcome.ok) return fail(reply, 502, 'unload_failed', outcome.error);
    request.log.info(
      { machineId: machine.id, instanceId: parsed.data.instanceId },
      'LM Studio model unloaded',
    );
    return { unloaded: parsed.data.instanceId };
  });
}
