import {
  buildShareRecord,
  notStandardReason,
  SHARE_MAX_BYTES,
  SHARE_SERVICE_ACCOUNT,
  SHARE_SERVICE_NAME,
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
  })
  .strict();

/** LLM Bench shows runs without names, so records carry none. */
const NO_NAME = { displayName: '' };

const sendRequest = recordRequest.extend({
  /** The preview's checksum: what is sent must be exactly what was shown. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const settingsRequest = z
  .object({
    /** LLM Bench's token, or null to remove it. */
    token: z.string().trim().min(1).max(500).nullable(),
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
    if (!parsed.success) return fail(reply, 400, 'validation', 'Paste the token, or remove it.');
    return share.setToken(parsed.data.token);
  });

  /** Builds a record from the saved race, or says why there is none. */
  async function record(
    body: z.infer<typeof recordRequest>,
    reply: FastifyReply,
  ): Promise<{ built: ShareRecord; notStandard: string | null } | null> {
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
      NO_NAME,
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
    return { built, notStandard: notStandardReason(stored) };
  }

  /** The record exactly as it would be sent, for the sender to read first. */
  app.post('/api/share/preview', async (request, reply) => {
    const parsed = recordRequest.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'That is not a run to send.');
    const made = await record(parsed.data, reply);
    if (!made) return reply;
    return {
      record: made.built,
      sha256: sha256Hex(shareSigningText(made.built)),
      endpoint: share.endpoint,
      notStandard: made.notStandard,
    };
  });

  app.post('/api/share/send', async (request, reply) => {
    const parsed = sendRequest.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'validation', 'That is not a run to send.');
    const endpoint = share.endpoint;
    // LLM Bench takes runs only with a token: without one nothing is sent that it would refuse.
    if (!share.token) {
      return fail(
        reply,
        409,
        'no_token',
        `Add your ${SHARE_SERVICE_NAME} token first: sign in at ${SHARE_SERVICE_ACCOUNT} with Google and make one.`,
      );
    }
    const key = `${parsed.data.sessionId}/${parsed.data.machineId}`;
    if (sending.has(key)) return fail(reply, 409, 'sending', 'This run is being sent already.');
    sending.add(key);
    try {
      const made = await record(parsed.data, reply);
      if (!made) return reply;
      // Only standard prompts compare like for like, so LLM Bench takes nothing else.
      if (made.notStandard) return fail(reply, 409, 'not_standard', made.notStandard);
      const envelope = share.envelope(made.built);
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
