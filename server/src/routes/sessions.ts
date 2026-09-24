import {
  hasErrors,
  hasWarnings,
  MAX_RACE_MACHINES,
  sessionRequestSchema,
  textConfigSchema,
  type ApiErrorBody,
  type PreflightIssue,
  type SessionStreamMessage,
} from '@duel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { runPreflight } from '../preflight';
import { presetViews, resolvePrompt } from '../presets';
import type { SessionManager } from '../sessions';
import type { MachineStore, StoredMachine } from '../store';

const preflightRequestSchema = z.object({
  machineIds: z
    .array(z.string().min(1))
    .min(1, 'Pick at least one machine.')
    .max(MAX_RACE_MACHINES),
  config: textConfigSchema,
});

interface IdParams {
  Params: { id: string };
}

function fail(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  issues?: PreflightIssue[],
) {
  const body: ApiErrorBody = issues ? { error, message, issues } : { error, message };
  return reply.code(status).send(body);
}

const HEARTBEAT_MS = 15_000;
const NO_SESSION = 'There is no race with that id.';

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: {
    store: MachineStore;
    sessions: SessionManager;
    isLoading: (machineId: string) => boolean;
  },
): void {
  const { store, sessions, isLoading } = deps;

  app.get('/api/presets', async () => ({ presets: presetViews() }));

  /** The fairness checks for a race that has not started, for the form to show as it changes. */
  app.post('/api/preflight', async (request, reply) => {
    const parsed = preflightRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'validation', parsed.error.issues[0]?.message ?? 'Not valid.');
    }
    const machines = parsed.data.machineIds.map((id) => store.get(id));
    if (machines.some((machine) => !machine)) {
      return fail(reply, 404, 'not_found', 'There is no machine with that id.');
    }
    return runPreflight(machines as StoredMachine[], parsed.data.config, isLoading);
  });

  app.post('/api/sessions', async (request, reply) => {
    const parsed = sessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        reply,
        400,
        'validation',
        parsed.error.issues[0]?.message ?? 'The race request is not valid.',
      );
    }
    const machines = parsed.data.machineIds.map((id) => store.get(id));
    if (machines.some((machine) => !machine)) {
      return fail(reply, 404, 'not_found', 'There is no machine with that id.');
    }
    if (sessions.running()) {
      return fail(
        reply,
        409,
        'busy',
        'A race is already running. Wait for it to finish or cancel it first.',
      );
    }
    const preflight = await runPreflight(
      machines as StoredMachine[],
      parsed.data.config,
      isLoading,
    );
    if (hasErrors(preflight.issues)) {
      const first = preflight.issues.find((issue) => issue.level === 'error');
      return fail(reply, 400, 'preflight', first?.text ?? 'Pre-flight failed.', preflight.issues);
    }
    if (hasWarnings(preflight.issues) && !parsed.data.acknowledgeWarnings) {
      return fail(
        reply,
        409,
        'preflight_warnings',
        'Pre-flight found differences between the machines. Race anyway to start.',
        preflight.issues,
      );
    }
    const config = { ...parsed.data.config, prompt: resolvePrompt(parsed.data.config) };
    const view = sessions.start(machines as StoredMachine[], { ...parsed.data, config });
    request.log.info({ sessionId: view.id, machines: parsed.data.machineIds }, 'race started');
    return reply.code(201).send(view);
  });

  app.get('/api/sessions', async () => ({ sessions: sessions.list() }));

  app.get<IdParams>('/api/sessions/:id', async (request, reply) => {
    const view = await sessions.get(request.params.id);
    return view ?? fail(reply, 404, 'not_found', NO_SESSION);
  });

  app.post<IdParams>('/api/sessions/:id/cancel', async (request, reply) => {
    const view = await sessions.cancel(request.params.id);
    return view ?? fail(reply, 404, 'not_found', NO_SESSION);
  });

  app.delete<IdParams>('/api/sessions/:id', async (request, reply) => {
    const result = await sessions.remove(request.params.id);
    if (result === 'running') {
      return fail(reply, 409, 'running', 'This race is still running. Cancel it first.');
    }
    if (result === 'missing') return fail(reply, 404, 'not_found', NO_SESSION);
    return reply.code(204).send();
  });

  /** Server-sent events: a snapshot first, so a reloaded page picks up a running race. */
  app.get<IdParams>('/api/sessions/:id/stream', async (request, reply) => {
    const { id } = request.params;
    const known = await sessions.get(id);
    if (!known) return fail(reply, 404, 'not_found', NO_SESSION);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (message: SessionStreamMessage) =>
      raw.write(`data: ${JSON.stringify(message)}\n\n`);
    let heartbeat: NodeJS.Timeout | null = null;
    let leave: (() => void) | null = null;
    const close = () => {
      if (heartbeat) clearInterval(heartbeat);
      leave?.();
      if (!raw.writableEnded) raw.end();
    };
    const joined = sessions.join(id, (message) => {
      send(message);
      if (message.type === 'finished') close();
    });
    if (!joined) {
      // A finished race: replay it whole.
      const view = (await sessions.get(id)) ?? known;
      send({ type: 'snapshot', session: view });
      send({ type: 'finished', session: view });
      close();
      return reply;
    }
    leave = joined.leave;
    send({ type: 'snapshot', session: joined.snapshot });
    heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
    request.raw.on('close', close);
    return reply;
  });
}
