import {
  comparisonTable,
  hasErrors,
  hasWarnings,
  roundTable,
  tallyVotes,
  toCsv,
  toMarkdown,
  preflightRequestSchema,
  sessionRequestSchema,
  type ApiErrorBody,
  type PreflightRequest,
  type PreflightIssue,
  type SessionStreamMessage,
} from '@duel/shared';
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AUDIO_UPLOAD_LIMIT, type AudioStore, CLIP_PATH } from '../audio';
import { runPreflight, runTranscribePreflight } from '../preflight';
import { readSttStatus } from '../stt';
import { presetViews, resolvePrompt } from '../presets';
import type { SessionManager } from '../sessions';
import type { MachineStore, StoredMachine } from '../store';

const voteSchema = z.object({
  round: z.number().int().min(0),
  left: z.string().min(1),
  right: z.string().min(1),
  choice: z.enum(['left', 'right', 'tie']),
});

/** A file name like `model-duel-2026-09-25-1a2b3c4d.md`. */
function fileName(session: { id: string; createdAt: string }, extension: string): string {
  return `model-duel-${session.createdAt.slice(0, 10)}-${session.id.slice(0, 8)}.${extension}`;
}

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
    audio: AudioStore;
  },
): void {
  const { store, sessions, isLoading, audio } = deps;
  const preflight = (machines: StoredMachine[], request: PreflightRequest) =>
    request.workload === 'text'
      ? runPreflight(machines, request.config, isLoading)
      : runTranscribePreflight(machines, request.config, isLoading, audio);

  /** Audio for a transcription race, sent as the raw file; stored by its hash. */
  app.post<{ Querystring: { name?: string } }>(
    '/api/audio',
    { bodyLimit: AUDIO_UPLOAD_LIMIT },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return fail(reply, 400, 'validation', 'Send the audio file as the request body.');
      }
      const saved = await audio.save(
        String(request.query.name ?? 'audio'),
        String(request.headers['content-type'] ?? ''),
        new Uint8Array(body.buffer, body.byteOffset, body.length),
      );
      return reply.code(201).send(saved);
    },
  );

  /** A machine's speech-to-text: engines, what is on disk and what is in memory. */
  app.get<IdParams>('/api/machines/:id/stt', async (request, reply) => {
    const machine = store.get(request.params.id);
    if (!machine) return fail(reply, 404, 'not_found', 'There is no machine with that id.');
    return { machineId: machine.id, ...(await readSttStatus(machine)) };
  });

  /** The bundled LibriSpeech clip, to listen to. */
  app.get('/api/audio/clip.wav', async (_request, reply) =>
    reply
      .header('content-type', 'audio/wav')
      .header('cache-control', 'public, max-age=86400')
      .send(createReadStream(CLIP_PATH)),
  );

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
    return preflight(machines as StoredMachine[], parsed.data);
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
    const checked = await preflight(machines as StoredMachine[], parsed.data);
    if (hasErrors(checked.issues)) {
      const first = checked.issues.find((issue) => issue.level === 'error');
      return fail(reply, 400, 'preflight', first?.text ?? 'Pre-flight failed.', checked.issues);
    }
    if (hasWarnings(checked.issues) && !parsed.data.acknowledgeWarnings) {
      return fail(
        reply,
        409,
        'preflight_warnings',
        'Pre-flight found differences between the machines. Race anyway to start.',
        checked.issues,
      );
    }
    const view = sessions.start(
      machines as StoredMachine[],
      parsed.data.workload === 'text'
        ? {
            ...parsed.data,
            config: { ...parsed.data.config, prompt: resolvePrompt(parsed.data.config) },
          }
        : parsed.data,
    );
    request.log.info({ sessionId: view.id, machines: parsed.data.machineIds }, 'race started');
    return reply.code(201).send(view);
  });

  app.get('/api/sessions', async () => ({ sessions: sessions.list() }));

  /** Blind votes added up per pair of models, across every saved race. */
  app.get('/api/votes/tally', async () => ({
    tally: tallyVotes(sessions.list().flatMap((summary) => summary.votes)),
  }));

  app.post<IdParams>('/api/sessions/:id/vote', async (request, reply) => {
    const parsed = voteSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'The vote is not valid.');
    const result = await sessions.vote(request.params.id, {
      ...parsed.data,
      at: new Date().toISOString(),
    });
    if (typeof result === 'string') {
      const status = result.startsWith('There is no race') ? 404 : 400;
      return fail(reply, status, status === 404 ? 'not_found' : 'bad_vote', result);
    }
    return result;
  });

  /** The full session, raw events included; API keys never enter a session. */
  app.get<IdParams>('/api/sessions/:id/export.json', async (request, reply) => {
    const stored = await sessions.getStored(request.params.id);
    if (!stored) return fail(reply, 404, 'not_found', NO_SESSION);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fileName(stored, 'json')}"`)
      .send(`${JSON.stringify(stored, null, 2)}\n`);
  });

  /** The comparison and round tables as the page shows them, one after the other. */
  app.get<IdParams>('/api/sessions/:id/export.csv', async (request, reply) => {
    const view = await sessions.get(request.params.id);
    if (!view) return fail(reply, 404, 'not_found', NO_SESSION);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fileName(view, 'csv')}"`)
      .send(toCsv([comparisonTable(view), roundTable(view)]));
  });

  /** A summary that reads on its own. */
  app.get<IdParams>('/api/sessions/:id/export.md', async (request, reply) => {
    const view = await sessions.get(request.params.id);
    if (!view) return fail(reply, 404, 'not_found', NO_SESSION);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fileName(view, 'md')}"`)
      .send(toMarkdown(view));
  });

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
