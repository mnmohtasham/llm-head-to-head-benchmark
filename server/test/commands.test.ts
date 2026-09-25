import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startAgent, type RunningAgent } from '@duel/agent';
import { startMockServer, type RunningMock } from '@duel/mock';
import {
  sessionStats,
  type CommandConfig,
  type MachineView,
  type PreflightResult,
  type ProbeSummary,
  type RunPlan,
  type SessionView,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const KEY = 'sk-unsloth-cmd-linux-000000000000000001';
const AGENT_TOKEN = 'agent-token-for-tests-000000000000000001';
let unsloth: RunningMock;
let fast: RunningAgent;
let slow: RunningAgent;
let ctx: Awaited<ReturnType<typeof testApp>>;
let fastId: string;
let slowId: string;

const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

async function addMachine(name: string, agent: RunningAgent | null, token = AGENT_TOKEN) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: {
      name,
      baseUrl: unsloth.url,
      apiKey: KEY,
      ...(agent ? { agentUrl: agent.url, agentToken: token } : {}),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<MachineView>();
}

function payload(machineIds: string[], config: Partial<CommandConfig> = {}) {
  return {
    workload: 'command',
    machineIds,
    config: { template: 'fake', clip: 'fake-clip.mp4', ...config },
    plan: ONE_ROUND,
  };
}

async function finished(id: string): Promise<SessionView> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const view = (
      await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })
    ).json<SessionView>();
    if (view.finishedAt) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the race did not finish');
}

beforeAll(async () => {
  unsloth = await startMockServer({ profile: 'linux-cuda', apiKey: KEY });
  const clipsDir = await mkdtemp(path.join(os.tmpdir(), 'model-duel-cmd-test-'));
  const options = { token: AGENT_TOKEN, clipsDir, fake: true, telemetry: false };
  // 300 frames: 1 s on the fast agent, 2.5 s on the slow one.
  fast = await startAgent({ ...options, fakeFps: 300 });
  slow = await startAgent({ ...options, fakeFps: 120 });
});
afterAll(async () => {
  await fast.close();
  await slow.close();
  await unsloth.close();
});
beforeEach(async () => {
  ctx = await testApp();
  fastId = (await addMachine('Fast', fast)).id;
  slowId = (await addMachine('Slow', slow)).id;
});
afterEach(async () => {
  await ctx.app.close();
});

describe('machines with an agent', () => {
  it('keep the token to themselves, and the probe asks the agent too', async () => {
    const view = (
      await ctx.app.inject({ method: 'GET', url: `/api/machines/${fastId}` })
    ).json<MachineView>();
    expect(view).toMatchObject({ agentUrl: fast.url, hasAgentToken: true });
    expect(JSON.stringify(view)).not.toContain(AGENT_TOKEN);
    const probe = (
      await ctx.app.inject({ method: 'POST', url: `/api/machines/${fastId}/probe` })
    ).json<ProbeSummary>();
    expect(probe.agent?.error).toBeNull();
    expect(probe.agent?.health?.fake).toBe(true);
    const typed = await ctx.app.inject({
      method: 'PUT',
      url: `/api/machines/${slowId}`,
      payload: { name: 'Slow', baseUrl: unsloth.url, agentUrl: '127.0.0.1' },
    });
    // A bare address gets the agent's own port.
    expect(typed.json<MachineView>().agentUrl).toBe('http://127.0.0.1:8765');
  });

  it('pre-flight stops a machine without an agent, a wrong token, and a missing encoder', async () => {
    const none = await addMachine('None', null);
    const wrong = await addMachine('Wrong', fast, 'not-the-token');
    const check = async (ids: string[], config: Partial<CommandConfig> = {}) => {
      const { workload, machineIds, config: body } = payload(ids, config);
      const answer = await ctx.app.inject({
        method: 'POST',
        url: '/api/preflight',
        payload: { workload, machineIds, config: body },
      });
      return answer.json<PreflightResult>().issues.map((i) => [i.level, i.code, i.text]);
    };
    expect(await check([fastId, slowId])).toEqual([
      [
        'note',
        'encoder',
        'The fake encode is scripted: it shows how the tab works, not how fast a machine is.',
      ],
    ]);
    const issues = await check([none.id, wrong.id]);
    expect(issues[0]?.[1]).toBe('no-agent');
    expect(issues[1]).toEqual(['error', 'agent', 'The agent did not accept the token.']);
    const prores = await check([fastId], { template: 'prores-hardware' });
    expect(prores[0]?.[1]).toBe('template');
  });
});

describe('a command race', () => {
  it('runs the same encode on every agent, and the faster one wins', async () => {
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: payload([fastId, slowId]),
    });
    expect(started.statusCode, started.body).toBe(201);
    const session = await finished(started.json<SessionView>().id);
    expect(session.state).toBe('done');
    const [a, b] = [fastId, slowId].map(
      (id) => session.rounds[0]?.runs.find((r) => r.machineId === id)?.command,
    );
    expect(a).toMatchObject({ encoder: 'fake', exitCode: 0, frames: 300, outputBytes: 1_500_000 });
    expect(a?.fps).toBeGreaterThan(200);
    expect(a?.fps).toBeLessThan(330);
    expect(b?.fps).toBeGreaterThan(90);
    expect(b?.fps).toBeLessThan(130);
    // 300 frames at 30 per second of video is 10 s: the fast agent does that in about 1 s.
    expect(a?.speed).toBeGreaterThan(7);
    expect(a?.timeline.length).toBeGreaterThan(5);
    expect(sessionStats(session).find((row) => row.key === 'encodeFps')?.verdict).toMatchObject({
      kind: 'win',
      leader: 0,
    });
    const provenance = session.provenance.find((p) => p.machineId === fastId);
    expect(provenance?.agent?.fake).toBe(true);
    expect(provenance?.request).toMatchObject({ template: 'fake', clip: 'fake-clip.mp4' });
    const md = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export.md`,
    });
    expect(md.body).toContain('| Frames per second (higher is better) |');
    expect(md.body).toContain('Encode fake-clip.mp4 with Fake encode');
    expect(md.body).not.toContain(AGENT_TOKEN);
  });

  it('cancels the job on the agent', async () => {
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: payload([slowId]),
    });
    const id = started.json<SessionView>().id;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` });
    const session = await finished(id);
    expect(session.rounds[0]?.runs[0]?.state).toBe('cancelled');
    // The agent stops at its next tick and is free again.
    let busy = true;
    const until = Date.now() + 2000;
    while (busy && Date.now() < until) {
      const health = await fetch(`${slow.url}/health`, {
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      });
      busy = ((await health.json()) as { busy: boolean }).busy;
      if (busy) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(busy).toBe(false);
  });
});
