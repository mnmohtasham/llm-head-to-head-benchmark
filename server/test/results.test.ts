import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/mock';
import { resultSchema, type MachineView, type ResultFile, type SessionView } from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyResult } from '../src/results';
import { testApp } from './helpers';

const LINUX_KEY = 'sk-unsloth-result-linux-000000000000001';
const MAC_KEY = 'sk-unsloth-result-mac-00000000000000002';
let linux: RunningMock;
let mac: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let ids: string[];

async function addMachine(name: string, mock: RunningMock, apiKey: string) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name, baseUrl: mock.url, apiKey, notes: 'under the desk' },
  });
  return created.json<MachineView>().id;
}

async function race(): Promise<SessionView> {
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      workload: 'text',
      machineIds: ids,
      config: {
        prompt: 'Why is the sky blue?',
        maxTokens: 256,
        thinking: true,
        reasoningEffort: null,
      },
      plan: { rounds: 2, warmup: true, settleMs: 0, sequencing: 'concurrent' },
      acknowledgeWarnings: true,
    },
  });
  expect(started.statusCode, started.body).toBe(201);
  const id = started.json<SessionView>().id;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const view = (
      await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })
    ).json<SessionView>();
    if (view.finishedAt) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the race did not finish');
}

const resultsDir = () => path.join(ctx.dataDir, 'results');
async function saved(): Promise<ResultFile[]> {
  const files = await readdir(resultsDir()).catch(() => [] as string[]);
  return Promise.all(
    files.map(
      async (f) => JSON.parse(await readFile(path.join(resultsDir(), f), 'utf8')) as ResultFile,
    ),
  );
}

beforeAll(async () => {
  linux = await startMockServer({ profile: 'linux-cuda', apiKey: LINUX_KEY });
  mac = await startMockServer({ profile: 'mac-mlx', apiKey: MAC_KEY });
});
afterAll(async () => {
  await linux.close();
  await mac.close();
});
beforeEach(async () => {
  for (const mock of [linux, mac]) {
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    await fetch(`${mock.url}/__mock/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: { startupMs: 30, tokenMs: 2, jitterMs: 0, reasoningTokens: 5, answerTokens: 10 },
      }),
    });
  }
  ctx = await testApp();
  ids = [await addMachine('Linux', linux, LINUX_KEY), await addMachine('Mac', mac, MAC_KEY)];
});
afterEach(async () => {
  await ctx.app.close();
});

describe('result files', () => {
  it('are written when a race finishes, the same as the download, with a checksum that holds', async () => {
    const session = await race();
    const [file] = await saved();
    expect(file).toBeDefined();
    expect(resultSchema.safeParse(file).success).toBe(true);
    expect(file?.id).toBe(session.id);
    expect(verifyResult(file as ResultFile)).toBe(true);
    expect(file?.rounds.map((r) => r.warmup)).toEqual([true, false, false]);
    expect(file?.rounds[1]?.runs[0]?.events).toMatchObject({ events: expect.any(Array) });
    expect(file?.rounds[1]?.runs[0]?.text?.answer.length).toBeGreaterThan(0);

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/result.json`,
    });
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename="model-duel-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.json"$/,
    );
    expect(download.json<ResultFile>()).toEqual(file);
    for (const secret of [LINUX_KEY, MAC_KEY, linux.url, mac.url, 'under the desk']) {
      expect(download.body).not.toContain(secret);
    }
    // An edited copy no longer matches its checksum.
    expect(verifyResult({ ...(file as ResultFile), state: 'failed' })).toBe(false);
  });

  it('follow a blind vote, and go with a deleted race', async () => {
    const session = await race();
    const vote = await ctx.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/vote`,
      payload: { round: 0, left: ids[0], right: ids[1], choice: 'left' },
    });
    expect(vote.statusCode, vote.body).toBe(200);
    const [file] = await saved();
    expect(file?.summary.votes).toMatchObject([{ round: 0, left: 0, right: 1, choice: 'left' }]);
    expect(verifyResult(file as ResultFile)).toBe(true);
    await ctx.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}` });
    expect(await saved()).toEqual([]);
  });

  it('are written for earlier races when Model Duel starts', async () => {
    const session = await race();
    await rm(resultsDir(), { recursive: true, force: true });
    await ctx.app.close();
    ctx = await testApp({ dataDir: ctx.dataDir });
    const deadline = Date.now() + 5000;
    while ((await saved()).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await saved()).map((f) => f.id)).toEqual([session.id]);
  });
});
