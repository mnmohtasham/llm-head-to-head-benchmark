import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  commandConfigSchema,
  commandLabel,
  commandPreflightIssues,
  commandResult,
  ffmpegArgs,
  FfmpegProgressParser,
  jobRequestSchema,
  migrateSession,
  parseMacmon,
  parseNvidiaSmi,
  type AgentEvent,
  type AgentHealth,
  type CommandPreflightMachine,
  type StoredSession,
} from '../src';
import { makeRun, makeSession } from './make';

const recorded = await readFile(
  new URL('./fixtures/ffmpeg-progress-x265.txt', import.meta.url),
  'utf8',
);

describe('ffmpeg progress', () => {
  it('reads a recorded x265 encode, whatever pieces the text arrives in', () => {
    const whole = new FfmpegProgressParser().push(recorded);
    expect(whole.map((b) => b.frame)).toEqual([37, 102, 165, 229, 289, 300]);
    expect(whole.at(-1)).toEqual({
      frame: 300,
      fps: 117.14,
      outTimeMs: 9933.333,
      speed: 3.88,
      totalSize: 2109174,
      done: true,
    });
    const parser = new FfmpegProgressParser();
    const pieces: ReturnType<FfmpegProgressParser['push']> = [];
    for (let at = 0; at < recorded.length; at += 7)
      pieces.push(...parser.push(recorded.slice(at, at + 7)));
    expect(pieces).toEqual(whole);
  });

  it('reads N/A as missing', () => {
    const [block] = new FfmpegProgressParser().push(
      'frame=0\nfps=0.00\nout_time_us=N/A\nspeed=N/A\nprogress=continue\n',
    );
    expect(block).toMatchObject({ frame: 0, outTimeMs: null, speed: null, done: false });
  });
});

describe('command templates', () => {
  const job = commandConfigSchema.parse({
    template: 'hevc-hardware',
    clip: 'reference-1080p30.mp4',
  });

  it('build an argument list per encoder, with progress on stdout', () => {
    expect(ffmpegArgs(job, 'hevc_nvenc', '/clips/a.mp4', '/tmp/out.mp4')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      '/clips/a.mp4',
      '-c:v',
      'hevc_nvenc',
      '-preset',
      'p5',
      '-b:v',
      '10M',
      '-tag:v',
      'hvc1',
      '-an',
      '-stats_period',
      '0.1',
      '-progress',
      'pipe:1',
      '-nostats',
      '/tmp/out.mp4',
    ]);
    const x265 = ffmpegArgs({ ...job, template: 'x265', maxSeconds: 5 }, 'libx265', 'in', 'out');
    expect(x265.slice(5, 7)).toEqual(['-t', '5']);
    expect(x265).toContain('libx265');
    expect(() => ffmpegArgs(job, 'sh', 'in', 'out')).toThrow('No arguments for encoder sh.');
  });

  it('refuse anything beyond their own fields and plain clip names', () => {
    expect(jobRequestSchema.safeParse({ ...job, command: 'rm -rf /' }).success).toBe(false);
    expect(jobRequestSchema.safeParse({ ...job, clip: '../secret.mp4' }).success).toBe(false);
    expect(jobRequestSchema.safeParse({ ...job, clip: '.hidden.mp4' }).success).toBe(false);
    expect(jobRequestSchema.safeParse({ ...job, template: 'shell' }).success).toBe(false);
    expect(commandLabel({ ...job, template: 'x265', maxSeconds: 5 })).toBe(
      'Encode reference-1080p30.mp4 with x265 software, CRF 28, medium, first 5 s',
    );
  });
});

describe('command results', () => {
  it('add up frames per second and speed from the agent’s events', () => {
    const events: AgentEvent[] = [
      { type: 'started', at: 1000, encoder: 'hevc_nvenc', argv: ['ffmpeg'] },
      {
        type: 'progress',
        at: 1500,
        frame: 0,
        fps: 0,
        outTimeMs: 0,
        speed: null,
        totalSize: 0,
        done: false,
      },
      {
        type: 'progress',
        at: 2000,
        frame: 150,
        fps: 150,
        outTimeMs: 5000,
        speed: 5,
        totalSize: 1,
        done: false,
      },
      {
        type: 'progress',
        at: 3000,
        frame: 600,
        fps: 300,
        outTimeMs: 20000,
        speed: 10,
        totalSize: 2,
        done: true,
      },
      {
        type: 'telemetry',
        at: 2000,
        cpuPowerW: null,
        gpuPowerW: 60,
        anePowerW: null,
        gpuPct: 40,
        encoderPct: 80,
      },
      {
        type: 'telemetry',
        at: 2500,
        cpuPowerW: null,
        gpuPowerW: 70,
        anePowerW: null,
        gpuPct: 45,
        encoderPct: 95,
      },
      {
        type: 'finished',
        at: 3010,
        exitCode: 0,
        cancelled: false,
        wallMs: 2000,
        outputBytes: 25_000_000,
        stderrTail: '',
      },
    ];
    const r = commandResult('hevc-hardware', 'a.mp4', events, 2100);
    expect(r).toMatchObject({
      encoder: 'hevc_nvenc',
      exitCode: 0,
      wallMs: 2000,
      frames: 600,
      fps: 300,
      speed: 10,
      outputBytes: 25_000_000,
      firstFrameMs: 1000,
      agentTelemetry: { samples: 2, meanGpuPowerW: 65, peakEncoderPct: 95 },
    });
    expect(r.timeline).toEqual([
      [500, 0],
      [1000, 150],
      [2000, 600],
    ]);
    const failed = commandResult(
      'x265',
      'a.mp4',
      [{ ...events[6], exitCode: 1 } as AgentEvent],
      50,
    );
    expect(failed).toMatchObject({ fps: null, speed: null, exitCode: 1 });
  });

  it('read nvidia-smi and macmon lines', () => {
    expect(parseNvidiaSmi('35, 88, 71.52', 5)).toEqual({
      at: 5,
      cpuPowerW: null,
      gpuPowerW: 71.52,
      anePowerW: null,
      gpuPct: 35,
      encoderPct: 88,
    });
    expect(parseNvidiaSmi('nonsense', 5)).toBeNull();
    expect(
      parseMacmon('{"cpu_power":4.2,"gpu_power":1.5,"ane_power":0.0,"gpu_usage":[1398,0.25]}', 9),
    ).toMatchObject({ cpuPowerW: 4.2, gpuPowerW: 1.5, anePowerW: 0, gpuPct: 25 });
    expect(parseMacmon('{broken', 9)).toBeNull();
  });
});

describe('command pre-flight', () => {
  const health = (patch: Partial<AgentHealth> = {}): AgentHealth => ({
    app: 'model-duel-agent',
    version: '0.1.0',
    platform: 'linux',
    arch: 'x64',
    ffmpeg: { path: 'ffmpeg', version: '7.1.1' },
    encoders: ['hevc_nvenc', 'libx265'],
    templates: [
      { id: 'hevc-hardware', encoder: 'hevc_nvenc', reason: null },
      {
        id: 'prores-hardware',
        encoder: null,
        reason: 'This ffmpeg has none of prores_videotoolbox.',
      },
      { id: 'x265', encoder: 'libx265', reason: null },
      { id: 'fake', encoder: null, reason: 'The agent was not started with --fake.' },
    ],
    clips: [
      {
        name: 'a.mp4',
        bytes: 1,
        sha256: 'aaaa1111',
        durationSec: 20,
        frames: 600,
        width: 1920,
        height: 1080,
        codec: 'h264',
      },
    ],
    telemetry: { macmon: false, nvidiaSmi: true },
    fake: false,
    busy: false,
    ...patch,
  });
  const machine = (
    id: string,
    patch: Partial<CommandPreflightMachine> = {},
  ): CommandPreflightMachine => ({
    id,
    name: id.toUpperCase(),
    hasAgent: true,
    health: health(),
    error: null,
    ...patch,
  });
  const codes = (machines: CommandPreflightMachine[], template = 'hevc-hardware' as const) =>
    commandPreflightIssues(machines, { template, clip: 'a.mp4' }).map((i) => [
      i.level,
      i.code,
      i.machineId,
    ]);

  it('needs an agent that is free, has the encoder and the same clip on every machine', () => {
    expect(codes([machine('a'), machine('b')])).toEqual([]);
    expect(codes([machine('a', { hasAgent: false, health: null })])).toEqual([
      ['error', 'no-agent', 'a'],
    ]);
    expect(codes([machine('a', { health: health({ busy: true }) })])).toEqual([
      ['error', 'agent', 'a'],
    ]);
    expect(codes([machine('a')], 'prores-hardware' as never)).toEqual([['error', 'template', 'a']]);
    expect(codes([machine('a', { health: health({ clips: [] }) })])).toEqual([
      ['error', 'clip', 'a'],
    ]);
    const other = health({
      clips: [{ ...health().clips[0], sha256: 'bbbb2222' } as AgentHealth['clips'][number]],
      templates: [{ id: 'hevc-hardware', encoder: 'hevc_videotoolbox', reason: null }],
    });
    expect(codes([machine('a'), machine('b', { health: other })])).toEqual([
      ['error', 'clip', null],
      ['note', 'encoder', null],
    ]);
  });
});

describe('stored sessions', () => {
  it('migrate from version 8 with no command fields', () => {
    const v8 = makeSession(['a'], [[makeRun('a')]]) as unknown as Record<string, unknown>;
    v8.schemaVersion = 8;
    v8.provenance = [{ machineId: 'a', statusBefore: null }];
    const migrated = migrateSession(v8 as unknown as StoredSession);
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.rounds[0]?.runs[0]?.command).toBeNull();
    expect(migrated.provenance[0]?.agent).toBeNull();
  });
});
