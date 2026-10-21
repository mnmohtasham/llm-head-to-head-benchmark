import { rm } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-echo-test-000000000000000001';
let echo: FastifyInstance;
let url = '';

beforeAll(async () => {
  // A server that repeats the request's Authorization header in every error.
  echo = Fastify({ logger: false });
  echo.all('/*', async (request, reply) =>
    reply.code(500).send({ detail: `refused ${String(request.headers.authorization)}` }),
  );
  await echo.listen({ port: 0, host: '127.0.0.1' });
  const address = echo.server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await echo.close();
});

it('never hands a key a machine echoes back to the page', async () => {
  const ctx = await testApp();
  try {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Echo', baseUrl: url, apiKey: KEY },
    });
    const id = created.json<{ id: string }>().id;
    for (const path of [`/api/machines/${id}/status`, `/api/machines/${id}/models`]) {
      const answer = await ctx.app.inject({ url: path });
      expect(answer.body).toContain('refused Bearer');
      expect(answer.body, path).not.toContain(KEY);
    }
  } finally {
    await ctx.app.close();
    await rm(ctx.dataDir, { recursive: true, force: true });
  }
});
