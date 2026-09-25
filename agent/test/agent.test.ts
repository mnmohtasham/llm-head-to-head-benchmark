import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent, AgentHealth } from '@duel/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_CLIP, startAgent, type RunningAgent } from '../src/server';

const TOKEN = 'agent-test-token-0000000001';
let agent: RunningAgent;
let clipsDir: string;
const hasFfmpeg = await promisify(execFile)('ffmpeg', ['-hide_banner', '-version'])
  .then(() => true)
  .catch(() => false);

async function call(method: string, route: string, body?: unknown, token: string | null = TOKEN) {
  const response = await fetch(`${agent.url}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function events(id: string): Promise<AgentEvent[]> {
  const response = await fetch(`${agent.url}/jobs/${id}/stream`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as AgentEvent);
}

beforeAll(async () => {
  clipsDir = await mkdtemp(path.join(os.tmpdir(), 'model-duel-agent-test-'));
  if (hasFfmpeg) {
    await promisify(execFile)('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path.join(clipsDir, 'tiny.mp4'),
    ]);
  }
  agent = await startAgent({ token: TOKEN, clipsDir, fake: true, fakeFps: 600, telemetry: false });
});
afterAll(async () => {
  await agent.close();
});

describe('the agent', () => {
  it('names itself to anyone, and says more only with the token', async () => {
    const open = await call('GET', '/health', undefined, null);
    expect(open.body).toEqual({ app: 'model-duel-agent', version: '0.1.0' });
    const full = (await call('GET', '/health')).body as unknown as AgentHealth;
    expect(full.fake).toBe(true);
    expect(full.clips.map((c) => c.name)).toEqual(
      hasFfmpeg ? ['fake-clip.mp4', 'tiny.mp4'] : ['fake-clip.mp4'],
    );
    expect(full.templates.find((t) => t.id === 'fake')).toEqual({
      id: 'fake',
      encoder: 'fake',
      reason: null,
    });
    expect(
      (await call('POST', '/jobs', { template: 'fake', clip: 'fake-clip.mp4' }, 'wrong')).status,
    ).toBe(401);
  });

  it('runs only its own templates, with plain clip names', async () => {
    const refused = async (body: unknown) => {
      const answer = await call('POST', '/jobs', body);
      expect(answer.status).toBe(400);
      return String(answer.body.message);
    };
    expect(
      await refused({ template: 'fake', clip: 'fake-clip.mp4', argv: ['rm', '-rf', '/'] }),
    ).toContain('Unrecognized key');
    expect(await refused({ template: 'bash', clip: 'fake-clip.mp4' })).toContain(
      'runs only its own templates',
    );
    expect(await refused({ template: 'fake', clip: '../../etc/passwd' })).toContain('Pick a clip');
    expect(await refused({ template: 'fake', clip: 'missing.mp4' })).toBe(
      'There is no clip named missing.mp4 on this machine.',
    );
    expect(await refused({ template: 'prores-hardware', clip: 'fake-clip.mp4' })).toMatch(
      /has none of prores_videotoolbox|ffmpeg is not installed/,
    );
  });

  it('streams a fake encode through the progress parser, one job at a time', async () => {
    const started = await call('POST', '/jobs', { template: 'fake', clip: 'fake-clip.mp4' });
    expect(started.status).toBe(201);
    const busy = await call('POST', '/jobs', { template: 'fake', clip: 'fake-clip.mp4' });
    expect(busy.status).toBe(409);
    const list = await events(String(started.body.id));
    expect(list[0]).toMatchObject({ type: 'started', encoder: 'fake' });
    const progress = list.filter((e) => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toMatchObject({ frame: FAKE_CLIP.frames, done: true });
    expect(list.at(-1)).toMatchObject({ type: 'finished', exitCode: 0, cancelled: false });
    // A late listener gets the whole job again.
    expect((await events(String(started.body.id))).length).toBe(list.length);
  });

  it('cancels a job', async () => {
    const slow = await startAgent({
      token: TOKEN,
      clipsDir,
      fake: true,
      fakeFps: 30,
      telemetry: false,
    });
    try {
      const response = await fetch(`${slow.url}/jobs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ template: 'fake', clip: 'fake-clip.mp4' }),
      });
      const { id } = (await response.json()) as { id: string };
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fetch(`${slow.url}/jobs/${id}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      });
      const stream = await fetch(`${slow.url}/jobs/${id}/stream`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await stream.text()).toContain('"cancelled":true');
    } finally {
      await slow.close();
    }
  });

  it.skipIf(!hasFfmpeg)('encodes a real clip with x265 and reports its size', async () => {
    const started = await call('POST', '/jobs', {
      template: 'x265',
      clip: 'tiny.mp4',
      x265Preset: 'ultrafast',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const list = await events(String(started.body.id));
    const first = list[0];
    expect(first?.type === 'started' && first.argv.slice(0, 4)).toEqual([
      'ffmpeg',
      '-hide_banner',
      '-nostdin',
      '-y',
    ]);
    const finished = list.at(-1);
    expect(finished).toMatchObject({ type: 'finished', exitCode: 0 });
    expect(finished?.type === 'finished' && finished.outputBytes).toBeGreaterThan(1000);
    expect(list.filter((e) => e.type === 'progress').at(-1)).toMatchObject({
      frame: 60,
      done: true,
    });
  });
});
