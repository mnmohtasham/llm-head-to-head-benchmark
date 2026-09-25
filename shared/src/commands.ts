import { z } from 'zod';

/**
 * Command workloads run through Model Duel's agent on each machine. The agent runs only these
 * templates, each an argument list it builds itself: nothing a request sends ever reaches a shell.
 */
export const COMMAND_TEMPLATES = ['hevc-hardware', 'prores-hardware', 'x265', 'fake'] as const;
export type CommandTemplate = (typeof COMMAND_TEMPLATES)[number];

export const TEMPLATE_INFO: Record<
  CommandTemplate,
  { label: string; description: string; encoders: readonly string[]; container: 'mp4' | 'mov' }
> = {
  'hevc-hardware': {
    label: 'HEVC hardware',
    description:
      'HEVC on the video encoder: NVENC on an NVIDIA GPU, VideoToolbox on a Mac. The comparison is the encoder hardware.',
    encoders: ['hevc_nvenc', 'hevc_videotoolbox'],
    container: 'mp4',
  },
  'prores-hardware': {
    label: 'ProRes hardware',
    description: 'ProRes 422 on the Mac’s media engine. Macs only.',
    encoders: ['prores_videotoolbox'],
    container: 'mov',
  },
  x265: {
    label: 'x265 software',
    description: 'HEVC in software with x265: a CPU comparison, the same encoder on every machine.',
    encoders: ['libx265'],
    container: 'mp4',
  },
  fake: {
    label: 'Fake encode',
    description:
      'A scripted encode with ffmpeg-style progress, for the demo and tests. Needs an agent started with --fake.',
    encoders: ['fake'],
    container: 'mp4',
  },
};

export const X265_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
] as const;

/** A clip is a plain file name in the agent's clips folder: no paths, no leading dot. */
export const CLIP_NAME = /^[\w][\w.-]{0,120}$/;

export const commandConfigSchema = z.object({
  template: z.enum(COMMAND_TEMPLATES).default('hevc-hardware'),
  clip: z.string().regex(CLIP_NAME, 'Pick a clip.'),
  /** Target bitrate for the hardware encoders. */
  bitrateMbps: z.number().int().min(1).max(200).default(10),
  /** Quality for x265: lower is better and slower. */
  crf: z.number().int().min(0).max(51).default(28),
  x265Preset: z.enum(X265_PRESETS).default('medium'),
  /** Encode only the first seconds of the clip; null encodes all of it. */
  maxSeconds: z.number().int().min(1).max(600).nullable().default(null),
});
export type CommandConfig = z.infer<typeof commandConfigSchema>;

/** The body of the agent's `POST /jobs`: the same fields, checked again by the agent. */
export const jobRequestSchema = commandConfigSchema.strict();
export type JobRequest = z.infer<typeof jobRequestSchema>;

/** The ffmpeg arguments for a template and encoder: an argument list, never a shell string. */
export function ffmpegArgs(
  job: JobRequest,
  encoder: string,
  input: string,
  output: string,
): string[] {
  const codec: Record<string, string[]> = {
    hevc_nvenc: [
      '-c:v',
      'hevc_nvenc',
      '-preset',
      'p5',
      '-b:v',
      `${job.bitrateMbps}M`,
      '-tag:v',
      'hvc1',
    ],
    hevc_videotoolbox: [
      '-c:v',
      'hevc_videotoolbox',
      '-b:v',
      `${job.bitrateMbps}M`,
      '-tag:v',
      'hvc1',
    ],
    prores_videotoolbox: ['-c:v', 'prores_videotoolbox', '-profile:v', '2'],
    libx265: [
      '-c:v',
      'libx265',
      '-preset',
      job.x265Preset,
      '-crf',
      String(job.crf),
      '-tag:v',
      'hvc1',
      '-x265-params',
      'log-level=error',
    ],
  };
  const chosen = codec[encoder];
  if (!chosen) throw new Error(`No arguments for encoder ${encoder}.`);
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    ...(job.maxSeconds ? ['-t', String(job.maxSeconds)] : []),
    ...chosen,
    '-an',
    // Progress every 0.1 s instead of 0.5, so the frame timeline is fine enough to compare.
    '-stats_period',
    '0.1',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];
}

/** One block of ffmpeg's `-progress` output. */
export interface ProgressBlock {
  frame: number | null;
  fps: number | null;
  /** How much of the output has been written, in ms of video. */
  outTimeMs: number | null;
  /** How many times real time, as ffmpeg reports it. */
  speed: number | null;
  totalSize: number | null;
  done: boolean;
}

const numberOf = (text: string | undefined): number | null => {
  if (text === undefined || text === 'N/A' || text === '') return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
};

/**
 * Reads ffmpeg's `-progress pipe:1` output: `key=value` lines, each block ended by a `progress=`
 * line. Text arrives in arbitrary pieces, so a partial line waits for the rest.
 */
export class FfmpegProgressParser {
  private buffer = '';
  private block: Record<string, string> = {};

  push(text: string): ProgressBlock[] {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    const blocks: ProgressBlock[] = [];
    for (const line of lines) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      this.block[key] = value;
      if (key !== 'progress') continue;
      const b = this.block;
      // out_time_us is microseconds; out_time_ms, despite its name, is too.
      const outUs = numberOf(b.out_time_us) ?? numberOf(b.out_time_ms);
      blocks.push({
        frame: numberOf(b.frame),
        fps: numberOf(b.fps),
        outTimeMs: outUs === null ? null : outUs / 1000,
        speed: numberOf(b.speed?.replace(/x$/, '')),
        totalSize: numberOf(b.total_size),
        done: value === 'end',
      });
      this.block = {};
    }
    return blocks;
  }
}

/** A clip in an agent's clips folder. */
export interface AgentClip {
  name: string;
  bytes: number;
  sha256: string;
  durationSec: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
}

/** What an agent says about itself: platform, ffmpeg, encoders, clips and extra telemetry. */
export interface AgentHealth {
  app: 'model-duel-agent';
  version: string;
  platform: string;
  arch: string;
  ffmpeg: { path: string; version: string } | null;
  /** The known encoders this ffmpeg has. */
  encoders: string[];
  templates: Array<{ id: CommandTemplate; encoder: string | null; reason: string | null }>;
  clips: AgentClip[];
  telemetry: { macmon: boolean; nvidiaSmi: boolean };
  fake: boolean;
  busy: boolean;
}

/** Extra power readings from macmon on a Mac or nvidia-smi on Linux, where installed. */
export interface AgentTelemetrySample {
  at: number;
  cpuPowerW: number | null;
  gpuPowerW: number | null;
  anePowerW: number | null;
  gpuPct: number | null;
  encoderPct: number | null;
}

/** Events on an agent job's stream. Times are the agent's clock, epoch ms. */
export type AgentEvent =
  | { type: 'started'; at: number; encoder: string; argv: string[] }
  | ({ type: 'progress'; at: number } & ProgressBlock)
  | ({ type: 'telemetry' } & AgentTelemetrySample)
  | {
      type: 'finished';
      at: number;
      exitCode: number | null;
      cancelled: boolean;
      wallMs: number;
      outputBytes: number | null;
      stderrTail: string;
    };

/** One machine's encode, as the report keeps it. */
export interface CommandResult {
  template: CommandTemplate;
  encoder: string | null;
  /** The command as the agent ran it, with its own file paths. */
  argv: string[];
  clip: string;
  exitCode: number | null;
  /** From ffmpeg's start to its exit, on the agent. */
  wallMs: number | null;
  /** From the request leaving Model Duel to the finished event arriving. */
  controllerMs: number;
  frames: number | null;
  /** Frames over the agent's wall time. */
  fps: number | null;
  /** Seconds of video encoded per second of wall time. */
  speed: number | null;
  outputBytes: number | null;
  /** From ffmpeg's start to the first progress reading with a frame. */
  firstFrameMs: number | null;
  /** Progress readings: ms since ffmpeg started, and frames done. */
  timeline: Array<[number, number]>;
  agentTelemetry: {
    samples: number;
    meanCpuPowerW: number | null;
    meanGpuPowerW: number | null;
    meanAnePowerW: number | null;
    peakEncoderPct: number | null;
  } | null;
  stderrTail: string;
}

const mean = (values: Array<number | null>): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
};

/** Adds up an agent job's events into the numbers the report shows. */
export function commandResult(
  template: CommandTemplate,
  clip: string,
  events: readonly AgentEvent[],
  controllerMs: number,
): CommandResult {
  const started = events.find((e) => e.type === 'started');
  const finished = events.find((e) => e.type === 'finished');
  const progress = events.filter(
    (e): e is Extract<AgentEvent, { type: 'progress' }> => e.type === 'progress',
  );
  const telemetry = events.filter(
    (e): e is Extract<AgentEvent, { type: 'telemetry' }> => e.type === 'telemetry',
  );
  const origin = started?.at ?? progress[0]?.at ?? 0;
  const timeline = progress
    .filter((p) => p.frame !== null)
    .map((p) => [Math.round(p.at - origin), p.frame as number] as [number, number]);
  const last = [...progress].reverse().find((p) => p.frame !== null);
  const lastTime = [...progress].reverse().find((p) => p.outTimeMs !== null);
  const wallMs = finished?.wallMs ?? null;
  const frames = last?.frame ?? null;
  const ok = finished?.exitCode === 0 && !finished.cancelled;
  const firstFrame = timeline.find(([, frame]) => frame > 0);
  const encoderPcts = telemetry.map((t) => t.encoderPct).filter((v): v is number => v !== null);
  return {
    template,
    encoder: started?.encoder ?? null,
    argv: started?.argv ?? [],
    clip,
    exitCode: finished?.exitCode ?? null,
    wallMs,
    controllerMs,
    frames,
    fps: ok && frames !== null && wallMs ? frames / (wallMs / 1000) : null,
    speed:
      ok && lastTime?.outTimeMs !== null && lastTime?.outTimeMs !== undefined && wallMs
        ? lastTime.outTimeMs / wallMs
        : null,
    outputBytes: finished?.outputBytes ?? null,
    firstFrameMs: firstFrame ? firstFrame[0] : null,
    timeline,
    agentTelemetry:
      telemetry.length === 0
        ? null
        : {
            samples: telemetry.length,
            meanCpuPowerW: mean(telemetry.map((t) => t.cpuPowerW)),
            meanGpuPowerW: mean(telemetry.map((t) => t.gpuPowerW)),
            meanAnePowerW: mean(telemetry.map((t) => t.anePowerW)),
            peakEncoderPct: encoderPcts.length > 0 ? Math.max(...encoderPcts) : null,
          },
    stderrTail: finished?.stderrTail ?? '',
  };
}

/** One line of `macmon pipe` output: JSON with power in watts. */
export function parseMacmon(line: string, at: number): AgentTelemetrySample | null {
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const usage = j.gpu_usage;
    return {
      at,
      cpuPowerW: num(j.cpu_power),
      gpuPowerW: num(j.gpu_power),
      anePowerW: num(j.ane_power),
      gpuPct: Array.isArray(usage) && typeof usage[1] === 'number' ? usage[1] * 100 : null,
      encoderPct: null,
    };
  } catch {
    return null;
  }
}

/** One line of `nvidia-smi --query-gpu=utilization.gpu,utilization.encoder,power.draw`. */
export function parseNvidiaSmi(line: string, at: number): AgentTelemetrySample | null {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 3) return null;
  const num = (text: string | undefined) => {
    const v = Number.parseFloat(text ?? '');
    return Number.isFinite(v) ? v : null;
  };
  return {
    at,
    cpuPowerW: null,
    gpuPowerW: num(parts[2]),
    anePowerW: null,
    gpuPct: num(parts[0]),
    encoderPct: num(parts[1]),
  };
}

/** The agent's port unless it was started with another one. */
export const DEFAULT_AGENT_PORT = 8765;
