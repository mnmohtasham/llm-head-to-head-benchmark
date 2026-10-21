import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/test-servers';
import type { MachineView, SessionView } from '@duel/shared';
import { request } from 'undici';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-shutdown-test-0000000000001';
let mock: RunningMock;

beforeAll(async () => {
  mock = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
  // Slow enough that the race is still running when the app stops.
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stream: { startupMs: 20, tokenMs: 50, jitterMs: 0, answerTokens: 400 },
    }),
  });
});
afterAll(async () => {
  await mock.close();
});

it('stops promptly with a browser watching the race, and saves the race as cancelled', async () => {
  const ctx = await testApp();
  try {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const machine = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/machines',
        payload: { name: 'Linux', baseUrl: mock.url, apiKey: KEY },
      })
    ).json<MachineView>();
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        workload: 'text',
        machineIds: [machine.id],
        config: {
          prompt: 'Why is the sky blue?',
          maxTokens: 512,
          thinking: false,
          reasoningEffort: null,
        },
        plan: { rounds: 3, warmup: false, settleMs: 0, sequencing: 'concurrent' },
        acknowledgeWarnings: true,
      },
    });
    const id = started.json<SessionView>().id;
    // A browser watching it: the stream holds its connection open.
    const watching = await request(`${base}/api/sessions/${id}/stream`);
    expect(watching.statusCode).toBe(200);
    expect(watching.headers['content-security-policy']).toContain("default-src 'self'");
    const body = watching.body.text().catch(() => '');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const before = performance.now();
    await ctx.app.close();
    expect(performance.now() - before).toBeLessThan(5000);
    await body;
    const saved = JSON.parse(
      await readFile(path.join(ctx.dataDir, 'sessions', `${id}.json`), 'utf8'),
    ) as SessionView;
    expect(saved.state).toBe('cancelled');
    expect(saved.finishedAt).not.toBeNull();
  } finally {
    await rm(ctx.dataDir, { recursive: true, force: true });
  }
});
