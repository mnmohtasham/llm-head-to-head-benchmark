import type { TelemetryStreamMessage } from '@duel/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MachineStore } from '../store';
import type { TelemetryHub } from '../telemetry';

const HEARTBEAT_MS = 15_000;
const settingsSchema = z.object({ telemetry: z.boolean() });

export function registerTelemetryRoutes(
  app: FastifyInstance,
  deps: { store: MachineStore; telemetry: TelemetryHub },
): void {
  const { store, telemetry } = deps;

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
      const known = new Set(store.list().map((m) => m.id));
      const wanted = request.query.machines?.split(',').filter((id) => known.has(id)) ?? [...known];
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (message: TelemetryStreamMessage) =>
        raw.write(`data: ${JSON.stringify(message)}\n\n`);
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
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        leave();
        release();
        if (!raw.writableEnded) raw.end();
      });
      return reply;
    },
  );
}
