import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  SHARE_MAX_BYTES,
  shareEnvelopeSchema,
  shareSigningText,
  type ShareEnvelope,
} from '@duel/shared';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * A fake results service for tests and the demo, doing what docs/share-api.md asks of a real one:
 * a size limit, the exact schema, the checksum and the signature checked, and one record per
 * sender and submission id, which only that sender can replace.
 */
export interface ShareMockConfig {
  /** Answer every submission with this HTTP status. */
  failWith: number | null;
  /** Answer with a redirect to this address. */
  redirectTo: string | null;
  /** A link on another host, which Model Duel must not show. */
  foreignLink: boolean;
}

export interface RunningShareMock {
  url: string;
  endpoint: string;
  port: number;
  app: FastifyInstance;
  /** Every record accepted, newest last. */
  received: () => ShareEnvelope[];
  close: () => Promise<void>;
}

const DEFAULTS: ShareMockConfig = { failWith: null, redirectTo: null, foreignLink: false };

/** Checks an envelope's checksum and Ed25519 signature; the reference for a real service. */
export function verifyEnvelope(envelope: ShareEnvelope): string | null {
  const text = shareSigningText(envelope.record);
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  if (digest !== envelope.sha256) return 'The checksum does not match the record.';
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: envelope.signature.publicKey },
    format: 'jwk',
  });
  const ok = verify(
    null,
    Buffer.from(text, 'utf8'),
    key,
    Buffer.from(envelope.signature.value, 'base64url'),
  );
  return ok ? null : 'The signature does not match the record.';
}

export async function startShareMock(
  options: { port?: number; host?: string; token?: string | null } = {},
): Promise<RunningShareMock> {
  let config: ShareMockConfig = { ...DEFAULTS };
  const stored = new Map<string, ShareEnvelope>();
  const order: string[] = [];
  const app = Fastify({ logger: false, bodyLimit: SHARE_MAX_BYTES + 4096 });
  const host = options.host ?? '127.0.0.1';

  app.post('/api/runs', async (request, reply) => {
    if (config.redirectTo) return reply.redirect(config.redirectTo, 307);
    if (config.failWith !== null) {
      return reply.code(config.failWith).send({ message: 'The mock was told to fail.' });
    }
    if (options.token && request.headers.authorization !== `Bearer ${options.token}`) {
      return reply.code(401).send({ message: 'A valid token is needed.' });
    }
    const parsed = shareEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ message: `Not a valid record: ${parsed.error.issues[0]?.message ?? ''}` });
    }
    const problem = verifyEnvelope(parsed.data);
    if (problem) return reply.code(400).send({ message: problem });
    // One record per sender and submission: resending replaces it.
    const key = `${parsed.data.signature.publicKey}:${parsed.data.record.submissionId}`;
    const replaced = stored.has(key);
    stored.set(key, parsed.data);
    if (!replaced) order.push(key);
    const id = parsed.data.record.submissionId.slice(0, 12);
    const base = `http://${host}:${port}`;
    return reply.code(replaced ? 200 : 201).send({
      id,
      url: config.foreignLink ? `https://elsewhere.example/runs/${id}` : `${base}/runs/${id}`,
      message: replaced ? 'Updated.' : 'Thank you.',
    });
  });

  app.get('/__mock/received', async () => order.map((key) => stored.get(key)));
  app.post('/__mock/config', async (request) => {
    config = { ...config, ...((request.body ?? {}) as Partial<ShareMockConfig>) };
    return config;
  });
  app.post('/__mock/reset', async () => {
    config = { ...DEFAULTS };
    stored.clear();
    order.length = 0;
    return config;
  });

  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  const url = `http://${host}:${port}`;
  return {
    url,
    endpoint: `${url}/api/runs`,
    port,
    app,
    received: () => order.map((key) => stored.get(key)).filter((e): e is ShareEnvelope => !!e),
    close: () => app.close(),
  };
}
