import {
  buildShareRecord,
  checkShareEndpoint,
  SHARE_MAX_BYTES,
  shareOptionsSchema,
  shareSigningText,
  type ApiErrorBody,
  type ShareRecord,
} from '@duel/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { SessionManager } from '../sessions';
import { sendEnvelope, sha256Hex, type ShareStore } from '../share';

const fail = (reply: FastifyReply, status: number, error: string, message: string) => {
  const body: ApiErrorBody = { error, message };
  return reply.code(status).send(body);
};

const recordRequest = z
  .object({
    sessionId: z.string().uuid(),
    machineId: z.string().min(1).max(100),
    options: shareOptionsSchema.prefault({}),
  })
  .strict();

const sendRequest = recordRequest.extend({
  /** The preview's checksum: what is sent must be exactly what was shown. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const settingsRequest = z
  .object({
    /** "" or null removes the address, and the token with it. */
    endpoint: z.string().max(300).nullable(),
    /** Leave out or "" to keep, null to remove. */
    token: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export function registerShareRoutes(
  app: FastifyInstance,
  options: {
    share: ShareStore;
    sessions: SessionManager;
    version: string;
    build: string | null;
    timeouts?: { connectMs: number; totalMs: number };
  },
): void {
  const { share, sessions } = options;
  const sending = new Set<string>();

  app.get('/api/share/settings', async () => share.view());

  app.put('/api/share/settings', async (request, reply) => {
    const parsed = settingsRequest.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'Check the address and token.');
    const { endpoint, token } = parsed.data;
    let url: string | null = null;
    if (endpoint !== null && endpoint.trim() !== '') {
      const checked = checkShareEndpoint(endpoint);
      if (!checked.ok) {
        return reply.code(400).send({
          error: 'validation',
          message: checked.error,
          fields: { endpoint: checked.error },
        });
      }
      url = checked.url;
    }
    // A saved token stays with the address it was given for.
    const moved = url !== share.endpoint && share.token !== null && token === undefined;
    return share.update({
      endpoint: url,
      token: token === null ? null : token ? token : moved ? null : undefined,
    });
  });

  /** Builds a record from the saved race, or says why there is none. */
  async function record(
    body: z.infer<typeof recordRequest>,
    reply: FastifyReply,
  ): Promise<ShareRecord | null> {
    const stored = await sessions.getStored(body.sessionId);
    if (!stored) {
      await fail(reply, 404, 'not_found', 'There is no race with that id.');
      return null;
    }
    if (stored.finishedAt === null) {
      await fail(reply, 409, 'running', 'The race is still running.');
      return null;
    }
    const built = buildShareRecord(
      stored,
      body.machineId,
      body.options,
      { publicKey: share.publicKey, version: options.version, build: options.build },
      sha256Hex,
    );
    if (!built) {
      await fail(
        reply,
        400,
        'nothing_to_send',
        'This machine has no finished round in that race, so there is nothing to send.',
      );
      return null;
    }
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8');
    if (bytes > SHARE_MAX_BYTES) {
      await fail(reply, 400, 'too_large', 'This record is too large to send.');
      return null;
    }
    return built;
  }

  /** The record exactly as it would be sent, for the sender to read first. */
  app.post('/api/share/preview', async (request, reply) => {
    const parsed = recordRequest.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'That is not a run to send.');
    const built = await record(parsed.data, reply);
    if (!built) return reply;
    return {
      record: built,
      sha256: sha256Hex(shareSigningText(built)),
      endpoint: share.endpoint,
    };
  });

  app.post('/api/share/send', async (request, reply) => {
    const parsed = sendRequest.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'That is not a run to send.');
    const endpoint = share.endpoint;
    if (!endpoint) {
      return fail(reply, 409, 'no_endpoint', 'Set the results service address first.');
    }
    const key = `${parsed.data.sessionId}/${parsed.data.machineId}`;
    if (sending.has(key)) return fail(reply, 409, 'sending', 'This run is being sent already.');
    sending.add(key);
    try {
      const built = await record(parsed.data, reply);
      if (!built) return reply;
      const envelope = share.envelope(built);
      if (envelope.sha256 !== parsed.data.sha256) {
        return fail(
          reply,
          409,
          'changed',
          'The record changed since you looked at it. Look at it again before sending.',
        );
      }
      const outcome = await sendEnvelope(
        endpoint,
        share.token,
        envelope,
        options.version,
        options.timeouts,
      );
      if (!outcome.ok) {
        request.log.warn(
          { status: outcome.status, host: new URL(endpoint).host },
          'the results service refused a record',
        );
        return fail(reply, 502, 'service', outcome.message);
      }
      const sent = {
        at: new Date().toISOString(),
        host: new URL(endpoint).host,
        sha256: envelope.sha256,
        id: outcome.id,
        url: outcome.url,
      };
      await share.markSent(key, sent);
      return { ...sent, status: outcome.status, message: outcome.message };
    } finally {
      sending.delete(key);
    }
  });
}
