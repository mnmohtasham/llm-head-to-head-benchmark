import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  commandConfigSchema,
  ffmpegArgs,
  FfmpegProgressParser,
  jobRequestSchema,
  parseMacmon,
  parseNvidiaSmi,
  TEMPLATE_INFO,
  type AgentClip,
  type AgentEvent,
  type AgentHealth,
  type AgentTelemetrySample,
  type CommandTemplate,
  type JobRequest,
} from '@duel/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { findFfmpeg, hasCommand, listClips } from './tools';

export const AGENT_VERSION = '0.1.0';

export interface AgentOptions {
  port?: number;
  host?: string;
  /** Every request but a bare health check must carry it as a bearer token. */
  token: string;
  /** The folder of source clips; jobs name a file in it and nothing else. */
  clipsDir: string;
  /** Offer the fake template and a fake clip, for the demo and tests. */
  fake?: boolean;
  /** Frames per second the fake encode runs at. */
  fakeFps?: number;
  ffmpeg?: string;
  ffprobe?: string;
  /** Read macmon or nvidia-smi during jobs, where installed. */
  telemetry?: boolean;
}

export interface RunningAgent {
  url: string;
  port: number;
  token: string;
  app: FastifyInstance;
  close: () => Promise<void>;
}

/** A clip that exists only on an agent started with --fake. */
export const FAKE_CLIP: AgentClip = {
  name: 'fake-clip.mp4',
  bytes: 1_000_000,
  sha256: createHash('sha256').update('model-duel fake clip').digest('hex'),
  durationSec: 10,
  frames: 300,
  width: 1920,
  height: 1080,
  codec: 'h264',
};

interface Job {
  id: string;
  request: JobRequest;
  encoder: string;
  events: AgentEvent[];
  listeners: Set<(event: AgentEvent) => void>;
  done: boolean;
  cancel: () => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startAgent(options: AgentOptions): Promise<RunningAgent> {
  const ffmpegPath = options.ffmpeg ?? 'ffmpeg';
  const ffprobePath = options.ffprobe ?? 'ffprobe';
  const [ffmpeg, macmon, nvidiaSmi] = await Promise.all([
    findFfmpeg(ffmpegPath),
    options.telemetry === false ? false : hasCommand('macmon', ['--version']),
    options.telemetry === false ? false : hasCommand('nvidia-smi', ['-L']),
  ]);
  const jobs = new Map<string, Job>();
  let running: Job | null = null;

  const clips = async (): Promise<AgentClip[]> => [
    ...(options.fake ? [FAKE_CLIP] : []),
    ...(await listClips(options.clipsDir, ffprobePath)),
  ];

  /** The encoder a template would use here, or why it cannot run. */
  const resolve = (
    template: CommandTemplate,
  ): { encoder: string | null; reason: string | null } => {
    if (template === 'fake') {
      return options.fake
        ? { encoder: 'fake', reason: null }
        : { encoder: null, reason: 'The agent was not started with --fake.' };
    }
    if (!ffmpeg) return { encoder: null, reason: 'ffmpeg is not installed on this machine.' };
    const encoder = TEMPLATE_INFO[template].encoders.find((e) => ffmpeg.encoders.includes(e));
    return encoder
      ? { encoder, reason: null }
      : {
          encoder: null,
          reason: `This ffmpeg has none of ${TEMPLATE_INFO[template].encoders.join(', ')}.`,
        };
  };

  const health = async (): Promise<AgentHealth> => ({
    app: 'model-duel-agent',
    version: AGENT_VERSION,
    platform: process.platform,
    arch: process.arch,
    ffmpeg: ffmpeg ? { path: ffmpeg.path, version: ffmpeg.version } : null,
    encoders: ffmpeg?.encoders ?? [],
    templates: (Object.keys(TEMPLATE_INFO) as CommandTemplate[]).map((id) => ({
      id,
      ...resolve(id),
    })),
    clips: await clips(),
    telemetry: { macmon, nvidiaSmi },
    fake: options.fake === true,
    busy: running !== null,
  });

  const emit = (job: Job, event: AgentEvent) => {
    job.events.push(event);
    for (const listener of job.listeners) listener(event);
  };

  /** Reads macmon or nvidia-smi while a job runs; stops with the job. */
  const watchTelemetry = (job: Job): (() => void) => {
    let child: ChildProcess | null = null;
    let parse: ((line: string, at: number) => AgentTelemetrySample | null) | null = null;
    if (macmon) {
      child = spawn('macmon', ['pipe', '-i', '500'], { stdio: ['ignore', 'pipe', 'ignore'] });
      parse = parseMacmon;
    } else if (nvidiaSmi) {
      child = spawn(
        'nvidia-smi',
        [
          '--query-gpu=utilization.gpu,utilization.encoder,power.draw',
          '--format=csv,noheader,nounits',
          '-lms',
          '500',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      parse = parseNvidiaSmi;
    }
    if (!child || !parse) return () => undefined;
    let rest = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      const lines = (rest + text).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const sample = parse?.(line, Date.now());
        if (sample && !job.done) emit(job, { type: 'telemetry', ...sample });
      }
    });
    child.on('error', () => undefined);
    return () => child?.kill();
  };

  /** A scripted encode: ffmpeg-style progress text through the real parser, at a fixed pace. */
  const runFake = async (job: Job, clip: AgentClip, signal: AbortSignal) => {
    const fps = options.fakeFps ?? 120;
    const total = Math.min(
      clip.frames ?? 300,
      job.request.maxSeconds ? job.request.maxSeconds * 30 : Infinity,
    );
    const parser = new FfmpegProgressParser();
    const started = Date.now();
    emit(job, { type: 'started', at: started, encoder: 'fake', argv: ['fake-encode', clip.name] });
    let frame = 0;
    while (frame < total && !signal.aborted) {
      await sleep(100);
      const elapsed = (Date.now() - started) / 1000;
      frame = Math.min(total, Math.floor(elapsed * fps));
      const outUs = Math.round((frame / 30) * 1e6);
      const done = frame >= total;
      const text = `frame=${frame}\nfps=${(frame / elapsed).toFixed(2)}\ntotal_size=${frame * 5000}\nout_time_us=${outUs}\nspeed=${(frame / 30 / elapsed).toFixed(2)}x\nprogress=${done ? 'end' : 'continue'}\n`;
      for (const block of parser.push(text))
        emit(job, { type: 'progress', at: Date.now(), ...block });
    }
    emit(job, {
      type: 'finished',
      at: Date.now(),
      exitCode: signal.aborted ? null : 0,
      cancelled: signal.aborted,
      wallMs: Date.now() - started,
      outputBytes: signal.aborted ? null : frame * 5000,
      stderrTail: '',
    });
  };

  /** Runs ffmpeg with an argument list it built itself, reading its progress from stdout. */
  const runFfmpeg = async (job: Job, clip: AgentClip, signal: AbortSignal) => {
    const input = path.join(options.clipsDir, clip.name);
    const ext = TEMPLATE_INFO[job.request.template].container;
    const output = path.join(os.tmpdir(), `model-duel-agent-${job.id}.${ext}`);
    const argv = ffmpegArgs(job.request, job.encoder, input, output);
    const stopTelemetry = watchTelemetry(job);
    const started = Date.now();
    emit(job, { type: 'started', at: started, encoder: job.encoder, argv: ['ffmpeg', ...argv] });
    const child = spawn(ffmpeg?.path ?? ffmpegPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const parser = new FfmpegProgressParser();
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      for (const block of parser.push(text))
        emit(job, { type: 'progress', at: Date.now(), ...block });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      stderr = (stderr + text).slice(-4000);
    });
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('error', (error) => {
        stderr += `\n${error.message}`;
        resolveExit(null);
      });
      child.on('close', (code) => resolveExit(code));
    });
    const wallMs = Date.now() - started;
    signal.removeEventListener('abort', onAbort);
    stopTelemetry();
    const size = await stat(output)
      .then((s) => s.size)
      .catch(() => null);
    await rm(output, { force: true });
    emit(job, {
      type: 'finished',
      at: Date.now(),
      exitCode,
      cancelled: signal.aborted,
      wallMs,
      outputBytes: exitCode === 0 ? size : null,
      stderrTail: stderr.slice(-1500).replaceAll(options.clipsDir, '<clips>'),
    });
  };

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, forceCloseConnections: true });

  const authorised = (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    return token !== '' && sameToken(token, options.token);
  };
  const deny = (reply: FastifyReply) =>
    reply
      .code(401)
      .send({ error: 'unauthorised', message: 'The agent token is missing or wrong.' });

  /** Without the token only the name and version, so the address can be checked. */
  app.get('/health', async (request) =>
    authorised(request) ? health() : { app: 'model-duel-agent', version: AGENT_VERSION },
  );

  app.post('/jobs', async (request, reply) => {
    if (!authorised(request)) return deny(reply);
    const parsed = jobRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'not_allowed',
        message: `The agent runs only its own templates: ${parsed.error.issues[0]?.message ?? 'invalid job'}.`,
      });
    }
    const job = commandConfigSchema.parse(parsed.data);
    const { encoder, reason } = resolve(job.template);
    if (!encoder) return reply.code(400).send({ error: 'unavailable', message: reason });
    const clip = (await clips()).find((c) => c.name === job.clip);
    if (!clip) {
      return reply
        .code(400)
        .send({ error: 'no_clip', message: `There is no clip named ${job.clip} on this machine.` });
    }
    if (running) {
      return reply.code(409).send({ error: 'busy', message: 'Another job is running.' });
    }
    const controller = new AbortController();
    const entry: Job = {
      id: randomUUID(),
      request: job,
      encoder,
      events: [],
      listeners: new Set(),
      done: false,
      cancel: () => controller.abort(),
    };
    jobs.set(entry.id, entry);
    while (jobs.size > 20) jobs.delete(jobs.keys().next().value as string);
    running = entry;
    const work = encoder === 'fake' ? runFake : runFfmpeg;
    void work(entry, clip, controller.signal)
      .catch((error: unknown) => {
        emit(entry, {
          type: 'finished',
          at: Date.now(),
          exitCode: null,
          cancelled: false,
          wallMs: 0,
          outputBytes: null,
          stderrTail: (error as Error).message,
        });
      })
      .finally(() => {
        entry.done = true;
        entry.listeners.clear();
        if (running === entry) running = null;
      });
    return reply.code(201).send({ id: entry.id, encoder });
  });

  /** Every event of a job so far, then the rest as they happen; ends with the job. */
  app.get<{ Params: { id: string } }>('/jobs/:id/stream', async (request, reply) => {
    if (!authorised(request)) return deny(reply);
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'not_found', message: 'No such job.' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    const send = (event: AgentEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'finished') res.end();
    };
    for (const event of job.events) send(event);
    if (job.done) {
      res.end();
      return reply;
    }
    job.listeners.add(send);
    request.raw.on('close', () => job.listeners.delete(send));
    return reply;
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (request, reply) => {
    if (!authorised(request)) return deny(reply);
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'not_found', message: 'No such job.' });
    const was = !job.done;
    job.cancel();
    return { cancelled: was };
  });

  const host = options.host ?? '127.0.0.1';
  await app.listen({ port: options.port ?? 0, host });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  const urlHost = host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${port}`,
    port,
    token: options.token,
    app,
    close: async () => {
      running?.cancel();
      await app.close();
    },
  };
}
