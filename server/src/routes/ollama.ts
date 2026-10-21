import type { ApiErrorBody } from '@duel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ollamaLoad, ollamaUnload, readOllamaModels } from '../engines';
import type { MachineStore, StoredMachine } from '../store';

interface IdParams {
  Params: { id: string };
}

const fail = (reply: FastifyReply, status: number, error: string, message: string) => {
  const body: ApiErrorBody = { error, message };
  return reply.code(status).send(body);
};

const modelSchema = z.object({ model: z.string().min(1).max(300) }).strict();

/**
 * Ollama's models on the Models tab: what is downloaded and loaded, and loading and unloading
 * through Ollama's own API.
 */
export function registerOllamaRoutes(
  app: FastifyInstance,
  deps: {
    store: MachineStore;
    loadTimeoutMs: number;
    /** Whether a race is running on the machine: its model must not change under it. */
    isRacing?: (machineId: string) => boolean;
  },
): void {
  const { store } = deps;
  const isRacing = deps.isRacing ?? (() => false);
  /** Loads and unloads wait for a race on the machine to end. */
  const racing = (machine: StoredMachine, reply: FastifyReply): boolean => {
    if (!isRacing(machine.id)) return false;
    void fail(
      reply,
      409,
      'racing',
      `A race is running on ${machine.name}. Cancel it or wait for it to finish, so its runs all use one model.`,
    );
    return true;
  };
  /** Loads in flight, one per machine, so a double click does not load twice. */
  const loading = new Map<string, string>();

  const ollamaMachine = (id: string, reply: FastifyReply): StoredMachine | null => {
    const machine = store.get(id);
    if (!machine) {
      void fail(reply, 404, 'not_found', 'There is no machine with that id.');
      return null;
    }
    if (machine.server !== 'ollama' || machine.cloud) {
      void fail(reply, 400, 'not_ollama', `${machine.name} does not run Ollama.`);
      return null;
    }
    return machine;
  };

  app.get<IdParams>('/api/machines/:id/ollama/models', async (request, reply) => {
    const machine = ollamaMachine(request.params.id, reply);
    if (!machine) return reply;
    const { downloaded, loaded, error } = await readOllamaModels(machine);
    return {
      machineId: machine.id,
      downloaded: downloaded ?? [],
      loaded: loaded ?? [],
      loading: loading.get(machine.id) ?? null,
      error,
      fetchedAt: new Date().toISOString(),
    };
  });

  app.post<IdParams>('/api/machines/:id/ollama/load', async (request, reply) => {
    const machine = ollamaMachine(request.params.id, reply);
    if (!machine) return reply;
    if (racing(machine, reply)) return reply;
    const parsed = modelSchema.safeParse(request.body);
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
      const outcome = await ollamaLoad(machine, parsed.data.model, deps.loadTimeoutMs);
      if (!outcome.ok) return fail(reply, 502, 'load_failed', outcome.error);
      request.log.info(
        { machineId: machine.id, model: parsed.data.model, seconds: outcome.seconds },
        'Ollama model loaded',
      );
      return { loaded: parsed.data.model, seconds: outcome.seconds };
    } finally {
      loading.delete(machine.id);
    }
  });

  app.post<IdParams>('/api/machines/:id/ollama/unload', async (request, reply) => {
    const machine = ollamaMachine(request.params.id, reply);
    if (!machine) return reply;
    if (racing(machine, reply)) return reply;
    const parsed = modelSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'Name the loaded model to unload.');
    const outcome = await ollamaUnload(machine, parsed.data.model);
    if (!outcome.ok) return fail(reply, 502, 'unload_failed', outcome.error);
    request.log.info({ machineId: machine.id, model: parsed.data.model }, 'Ollama model unloaded');
    return { unloaded: parsed.data.model };
  });
}
