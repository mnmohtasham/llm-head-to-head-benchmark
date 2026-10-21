import { textOnlyServer, type TelemetryStreamMessage } from '@duel/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { STREAM_HEADERS } from '../headers';
import { sseData, type LiveStreams } from '../live';
import type { MachineStore } from '../store';
import type { TelemetryHub } from '../telemetry';

const HEARTBEAT_MS = 15_000;
const settingsSchema = z.object({ telemetry: z.boolean() });

export function registerTelemetryRoutes(
  app: FastifyInstance,
  deps: { store: MachineStore; telemetry: TelemetryHub; streams: LiveStreams },
): void {
  const { store, telemetry, streams } = deps;

  app.get('/api/settings', async () => ({ telemetry: telemetry.enabled }));

  app.put('/api/settings', async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'validation', message: 'Send {"telemetry": true} or false.' });
    }
    await telemetry.setEnabled(parsed.data.telemetry);
    return { telemetry: telemetry.enabled };
  });

  /**
   * Live readings for the machines in `?machines=a,b`, or all of them. They are polled while this
   * stream is open, and while a race needs them.
   */
  app.get<{ Querystring: { machines?: string } }>(
    '/api/telemetry/stream',
    async (request, reply) => {
      // Cloud models have no hardware to read.
      const known = new Set(
        store
          .list()
          // Cloud models and every server but Unsloth have no hardware routes to read.
          .filter((m) => !m.cloud && !textOnlyServer(m.server))
          .map((m) => m.id),
      );
      const wanted = request.query.machines?.split(',').filter((id) => known.has(id)) ?? [...known];
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, STREAM_HEADERS);
      const send = (message: TelemetryStreamMessage) => raw.write(sseData(message));
      const ids = new Set(wanted);
      const leave = telemetry.subscribe((message) => {
        if (message.type === 'sample') {
          if (ids.has(message.machineId)) send(message);
          return;
        }
        send({ ...message, statuses: message.statuses.filter((s) => ids.has(s.machineId)) });
      });
      const release = telemetry.acquire(wanted);
      send({ type: 'status', enabled: telemetry.enabled, statuses: telemetry.statuses(wanted) });
      const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        leave();
        release();
        forget();
        if (!raw.writableEnded) raw.end();
      };
      const forget = streams.add(raw, close);
      request.raw.on('close', close);
      return reply;
    },
  );
}
