import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type RunningMock } from '../src/server';

const KEY = 'sk-unsloth-mocktest-000000000000000001';
let mock: RunningMock;

async function get(path: string, key?: string) {
  const response = await fetch(`${mock.url}${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function control(path: string, body?: unknown) {
  await fetch(`${mock.url}${path}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

beforeAll(async () => {
  mock = await startMockServer({ profile: 'mac-mlx', apiKey: KEY });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(async () => {
  await control('/__mock/reset');
});

// The expected bodies below are what a real Unsloth Studio answered on 2026-09-24.
describe('the fake Unsloth answers like the real one', () => {
  it('answers health without a key, with version fields only for a valid key', async () => {
    const anonymous = await get('/api/health');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.service).toBe('Unsloth UI Backend');
    expect(anonymous.body.version).toBeUndefined();
    expect((await get('/api/health', 'sk-unsloth-wrong-key-000000')).body.version).toBeUndefined();
    const authed = await get('/api/health', KEY);
    expect(authed.body).toMatchObject({
      version: '2026.9.2',
      device_type: 'mac',
      apple_silicon: true,
    });
  });

  it('refuses a missing key and a wrong key with the real messages', async () => {
    expect(await get('/api/inference/status')).toEqual({
      status: 401,
      body: { detail: 'Not authenticated' },
    });
    expect(await get('/api/inference/status', 'sk-unsloth-0000invalid0000')).toEqual({
      status: 401,
      body: { detail: 'Invalid or expired API key' },
    });
  });

  it('uses the OpenAI error shape on /v1 routes', async () => {
    expect(await get('/v1/models')).toEqual({
      status: 401,
      body: {
        error: {
          message: 'Not authenticated',
          type: 'authentication_error',
          param: null,
          code: null,
        },
      },
    });
  });

  it('answers unknown routes like the real server', async () => {
    expect(await get('/api/does-not-exist')).toEqual({
      status: 404,
      body: { detail: 'API endpoint not found' },
    });
  });

  it('returns an empty first power reading on the Mac profile, like Apple Silicon', async () => {
    const first = await get('/api/train/hardware', KEY);
    const second = await get('/api/train/hardware', KEY);
    expect(first.body.power_draw_w).toBeNull();
    expect(second.body.power_draw_w).toEqual(expect.any(Number));
    expect(first.body.devices).toHaveLength(1);
  });
});

describe('the control routes', () => {
  it('rejects the key on demand and resets', async () => {
    await control('/__mock/config', { rejectKey: true });
    expect((await get('/api/system', KEY)).status).toBe(401);
    await control('/__mock/reset');
    expect((await get('/api/system', KEY)).status).toBe(200);
  });

  it('hides a route or replaces its answer', async () => {
    await control('/__mock/config', {
      routes: {
        '/v1/props': { missing: true },
        '/api/system': { status: 500, body: { detail: 'boom' } },
      },
    });
    expect((await get('/v1/props', KEY)).status).toBe(404);
    expect(await get('/api/system', KEY)).toEqual({ status: 500, body: { detail: 'boom' } });
    await control('/__mock/config', { routes: { '/v1/props': null } });
    expect((await get('/v1/props', KEY)).status).toBe(200);
  });

  it('switches profile', async () => {
    await control('/__mock/config', { profile: 'linux-cuda' });
    expect((await get('/api/system', KEY)).body.device_backend).toBe('cuda');
  });

  it('accepts requests without a key in keyless mode', async () => {
    await control('/__mock/config', { apiKey: null });
    expect((await get('/api/inference/status')).status).toBe(200);
  });

  it('records who called and with what kind of key', async () => {
    await get('/api/health');
    await get('/api/system', KEY);
    expect(mock.requests().map((r) => [r.path, r.auth])).toEqual([
      ['/api/health', 'none'],
      ['/api/system', 'valid'],
    ]);
  });
});

describe('request slots', () => {
  it('queue requests beyond the slots, first in first out, and the monitor shows it', async () => {
    await control('/__mock/config', {
      stream: { startupMs: 20, tokenMs: 20, jitterMs: 0, reasoningTokens: 0, answerTokens: 10 },
    });
    const ask = (label: string) =>
      fetch(`${mock.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'x',
          stream: true,
          enable_thinking: false,
          messages: [{ role: 'user', content: label }],
        }),
      }).then(async (response) => {
        await response.text();
        return { label, at: performance.now() };
      });
    const first = ask('first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = ask('second');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const busy = await get('/api/inference/monitor', KEY);
    expect(busy.body.queue).toEqual({ capacity: 1, active: 1, queued: 1, free: 0 });
    const [a, b] = await Promise.all([first, second]);
    // The second waited for the first, so it ended a whole request later.
    expect(b.at - a.at).toBeGreaterThan(150);
    const idle = await get('/api/inference/monitor', KEY);
    expect(idle.body.queue).toEqual({ capacity: 1, active: 0, queued: 0, free: 1 });
  });
});
