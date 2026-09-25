import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer, type RunningMock } from '@duel/mock';
import {
  LIBRISPEECH_CLIP,
  sessionStats,
  wavFile,
  type MachineView,
  type PreflightResult,
  type RunPlan,
  type SessionSummary,
  type SessionView,
  type StoredSession,
  type TranscribeConfig,
} from '@duel/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers';

const LINUX_KEY = 'sk-unsloth-stt-linux-000000000000000001';
const MAC_KEY = 'sk-unsloth-stt-mac-00000000000000000002';
let linux: RunningMock;
let mac: RunningMock;
let ctx: Awaited<ReturnType<typeof testApp>>;
let linuxId: string;
let macId: string;

async function control(mock: RunningMock, body: unknown) {
  await fetch(`${mock.url}/__mock/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function addMachine(name: string, mock: RunningMock, apiKey: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/machines',
    payload: { name, baseUrl: mock.url, apiKey },
  });
  return created.json<MachineView>().id;
}

const ONE_ROUND: RunPlan = { rounds: 1, warmup: false, settleMs: 0, sequencing: 'concurrent' };

function payload(
  machineIds: string[],
  config: Partial<TranscribeConfig> = {},
  plan: Partial<RunPlan> = {},
  acknowledgeWarnings = true,
) {
  return {
    workload: 'transcribe',
    machineIds,
    config: { audio: { kind: 'clip' }, model: 'large-v3-turbo', ...config },
    plan: { ...ONE_ROUND, ...plan },
    acknowledgeWarnings,
  };
}

const post = (body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/sessions', payload: body });

async function race(...args: Parameters<typeof payload>): Promise<SessionView> {
  const response = await post(payload(...args));
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json<SessionView>().id;
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

async function upload(bytes: Uint8Array, name: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/audio?name=${encodeURIComponent(name)}`,
    headers: { 'content-type': 'audio/wav' },
    payload: Buffer.from(bytes),
  });
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
  for (const mock of [linux, mac]) await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  // Fast and different: the Linux mock processes 2 ms per audio second, the Mac 5.
  await control(linux, { stt: { loadMs: 40, msPerAudioSecond: 2 } });
  await control(mac, { stt: { loadMs: 40, msPerAudioSecond: 5 } });
  ctx = await testApp();
  linuxId = await addMachine('Linux', linux, LINUX_KEY);
  macId = await addMachine('Mac', mac, MAC_KEY);
});
afterEach(async () => {
  await ctx.app.close();
});

describe('pre-flight for transcription', () => {
  it('warns when GGUF falls back to transformers, and needs racing anyway', async () => {
    const checked = await ctx.app.inject({
      method: 'POST',
      url: '/api/preflight',
      payload: { workload: 'transcribe', machineIds: [linuxId, macId], config: payload([]).config },
    });
    const result = checked.json<PreflightResult>();
    expect(result.audio).toEqual({
      name: LIBRISPEECH_CLIP.file,
      seconds: LIBRISPEECH_CLIP.seconds,
      bytes: LIBRISPEECH_CLIP.bytes,
    });
    expect(result.issues.map((issue) => [issue.level, issue.code, issue.machineId])).toEqual([
      ['warning', 'stt-engine', macId],
      ['warning', 'stt-engine', null],
    ]);
    const refused = await post(payload([linuxId, macId], {}, {}, false));
    expect(refused.statusCode).toBe(409);
  });

  it('refuses a model that is not downloaded, an engine the machine lacks, and lost audio', async () => {
    const lost = await post(
      payload([linuxId], {
        audio: { kind: 'upload', audioId: 'a'.repeat(64), name: 'x.wav', reference: null },
      }),
    );
    expect(lost.statusCode).toBe(400);
    expect(lost.json<{ message: string }>().message).toContain('uploaded audio is gone');
    const tiny = await post(payload([linuxId], { model: 'tiny' }));
    expect(tiny.statusCode).toBe(400);
    expect(tiny.json<{ message: string }>().message).toContain('tiny is not downloaded for gguf');
    const mtmd = await post(payload([linuxId], { engine: 'mtmd' }));
    expect(mtmd.json<{ message: string }>().message).toContain('does not offer large-v3-turbo');
    await control(linux, { profile: 'mac-mlx' });
    const fallback = await ctx.app.inject({
      method: 'POST',
      url: '/api/preflight',
      payload: {
        workload: 'transcribe',
        machineIds: [linuxId],
        config: payload([], { model: 'small' }).config,
      },
    });
    expect(fallback.json<PreflightResult>().issues.map((i) => [i.level, i.code])).toEqual([
      ['warning', 'stt-engine'],
    ]);
  });
});

describe('a transcription race', () => {
  it('splits upload from processing, scores the words, and the faster machine wins', async () => {
    const session = await race([linuxId, macId]);
    expect(session.state).toBe('done');
    expect(session.workload).toBe('transcribe');
    const [fast, slow] = [linuxId, macId].map((id) => {
      const run = session.rounds[0]?.runs.find((r) => r.machineId === id);
      expect(run?.state, run?.error ?? '').toBe('done');
      return run?.transcription;
    });
    expect(fast?.audioSeconds).toBeCloseTo(LIBRISPEECH_CLIP.seconds, 2);
    expect(fast?.bytes).toBe(LIBRISPEECH_CLIP.bytes);
    expect(fast?.uploadMs).toBeGreaterThan(0);
    expect(fast?.processingMs).toBeGreaterThanOrEqual(140 - 5);
    expect(fast?.processingMs).toBeLessThan(140 + 150);
    expect(fast?.serverProcessingMs).toBeGreaterThanOrEqual(135);
    expect(fast?.rtf).toBeCloseTo(LIBRISPEECH_CLIP.seconds / ((fast?.processingMs ?? 1) / 1000), 1);
    expect(slow?.processingMs).toBeGreaterThanOrEqual(351 - 5);
    // The mocks change every 48th word on Linux GGUF and every 36th on Mac transformers.
    expect(fast?.wer).toMatchObject({
      substitutions: 3,
      deletions: 0,
      insertions: 0,
      referenceWords: 190,
    });
    expect(slow?.wer?.substitutions).toBe(5);
    expect(fast?.engine).toBe('gguf');
    expect(slow?.engine).toBe('transformers');
    expect(fast?.loadMs).toBeGreaterThanOrEqual(40);
    expect(session.rounds[0]?.sendSkewMs).toBeLessThan(5);
    const provenance = session.provenance.find((p) => p.machineId === linuxId);
    expect(provenance?.request).toMatchObject({
      model: 'large-v3-turbo',
      language: 'en',
      response_format: 'verbose_json',
      file: `${LIBRISPEECH_CLIP.file}, ${LIBRISPEECH_CLIP.bytes} bytes`,
    });
    expect(provenance?.sttAfter).toMatchObject({
      loadedModel: 'large-v3-turbo',
      loadedEngine: 'gguf',
    });

    const stats = sessionStats(session);
    const rtf = stats.find((row) => row.key === 'rtf');
    expect(rtf?.verdict).toMatchObject({ kind: 'win', leader: 0 });
    const wer = stats.find((row) => row.key === 'wer');
    expect(wer?.summaries[0]?.median).toBeCloseTo(300 / 190, 3);

    const listed = (await ctx.app.inject({ method: 'GET', url: '/api/sessions' })).json<{
      sessions: SessionSummary[];
    }>();
    const summary = listed.sessions.find((s) => s.id === session.id);
    expect(summary).toMatchObject({ workload: 'transcribe' });
    expect(summary?.prompt).toBe('Transcribe LibriSpeech clip, 70 s with large-v3-turbo on gguf');
    expect(summary?.machines.find((m) => m.id === linuxId)?.wer).toBeCloseTo(3 / 190);
  });

  it('reloads a model the sidecar let go between rounds, and warms up on a short piece', async () => {
    await control(linux, { stt: { idleUnloadMs: 100 } });
    const session = await race([linuxId], {}, { rounds: 2, warmup: true, settleMs: 250 });
    expect(session.warmup?.runs[0]?.state).toBe('done');
    expect(session.warmup?.runs[0]?.transcription?.audioSeconds).toBeCloseTo(5, 1);
    expect(session.warmup?.runs[0]?.transcription?.wer).toBeNull();
    // Unloaded after 100 ms idle, so the pause before each round costs a load, recorded apart.
    const loads = session.rounds.map((round) => round.runs[0]?.transcription?.loadMs ?? null);
    expect(loads.every((ms) => ms !== null && ms >= 40)).toBe(true);
    expect(session.rounds.every((round) => round.runs[0]?.rtt !== null)).toBe(true);
  });

  it('repeats the clip for long audio, and scores against the repeated text', async () => {
    const session = await race([linuxId], { audio: { kind: 'long', minutes: 2 } });
    const run = session.rounds[0]?.runs[0];
    expect(run?.transcription?.audioSeconds).toBeCloseTo(2 * LIBRISPEECH_CLIP.seconds, 1);
    expect(run?.transcription?.wer?.referenceWords).toBe(380);
    expect(run?.transcription?.wer?.substitutions).toBe(7);
  });

  it('takes an uploaded file, with or without what was said', async () => {
    const tone = wavFile(
      { sampleRate: 16_000, channels: 1, bitsPerSample: 16 },
      new Uint8Array(16_000 * 2 * 3),
    );
    const uploaded = await upload(tone, 'three seconds.wav');
    expect(uploaded.statusCode).toBe(201);
    const meta = uploaded.json<{ id: string; seconds: number; bytes: number; name: string }>();
    expect(meta).toMatchObject({ name: 'three seconds.wav', seconds: 3, bytes: tone.length });
    expect((await stat(path.join(ctx.dataDir, 'audio', `${meta.id}.bin`))).size).toBe(tone.length);
    const audio = { kind: 'upload' as const, audioId: meta.id, name: meta.name };
    const scored = await race([linuxId], { audio: { ...audio, reference: 'the quick brown fox' } });
    const run = scored.rounds[0]?.runs[0];
    expect(run?.transcription?.audioSeconds).toBe(3);
    expect(run?.answer.toLowerCase()).toContain('the quick brown fox');
    expect(run?.transcription?.wer?.insertions).toBeGreaterThan(0);
    const unscored = await race([linuxId], { audio: { ...audio, reference: null } });
    expect(unscored.rounds[0]?.runs[0]?.transcription?.wer).toBeNull();
    expect((await upload(new Uint8Array(0), 'empty.wav')).statusCode).toBe(400);
  });

  it('cancels a transcription in flight', async () => {
    await control(linux, { stt: { msPerAudioSecond: 200 } });
    const started = await post(payload([linuxId]));
    const id = started.json<SessionView>().id;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancelled = await ctx.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` });
    expect(cancelled.json<SessionView>().state).toBe('cancelled');
    const view = (
      await ctx.app.inject({ method: 'GET', url: `/api/sessions/${id}` })
    ).json<SessionView>();
    expect(view.rounds[0]?.runs[0]?.state).toBe('cancelled');
  });

  it('exports the report with the LibriSpeech credit, and saves the session as version 8', async () => {
    const session = await race([linuxId, macId]);
    const md = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export.md`,
    });
    expect(md.body).toContain('| Real-time factor (higher is better) |');
    expect(md.body).toContain('| Word error rate (lower is better) |');
    expect(md.body).toContain('LibriSpeech test-clean, speaker 6930');
    expect(md.body).toContain('| Engine that served | gguf | transformers |');
    const csv = await ctx.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/export.csv`,
    });
    expect(csv.body.split('\r\n')[0]).toBe('Metric,Unit,Linux,Mac,Result');
    expect(csv.body).toContain('Real-time factor,×,');
    const stored = JSON.parse(
      await readFile(path.join(ctx.dataDir, 'sessions', `${session.id}.json`), 'utf8'),
    ) as StoredSession;
    expect(stored.schemaVersion).toBe(8);
    expect(stored.workload).toBe('transcribe');
    const text = JSON.stringify(stored);
    expect(text).not.toContain(LINUX_KEY);
    expect(text).not.toContain(MAC_KEY);
  });
});
