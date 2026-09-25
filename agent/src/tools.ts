import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CLIP_NAME, TEMPLATE_INFO, type AgentClip } from '@duel/shared';

const run = promisify(execFile);

/** Runs a program and returns its output, or null when it is not there or fails. */
async function output(file: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await run(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

export async function findFfmpeg(
  ffmpeg: string,
): Promise<{ path: string; version: string; encoders: string[] } | null> {
  const version = await output(ffmpeg, ['-hide_banner', '-version']);
  if (version === null) return null;
  const list = (await output(ffmpeg, ['-hide_banner', '-encoders'])) ?? '';
  const known = new Set(Object.values(TEMPLATE_INFO).flatMap((t) => t.encoders));
  const encoders = list
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1] ?? '')
    .filter((name) => known.has(name));
  return {
    path: ffmpeg,
    version: /ffmpeg version (\S+)/.exec(version)?.[1] ?? 'unknown',
    encoders,
  };
}

export async function hasCommand(file: string, args: string[]): Promise<boolean> {
  return (await output(file, args, 5000)) !== null;
}

const hashes = new Map<string, { key: string; clip: AgentClip }>();

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Length, frames and size of a clip from ffprobe, when it is installed. */
async function probeClip(
  ffprobe: string,
  file: string,
): Promise<Pick<AgentClip, 'durationSec' | 'frames' | 'width' | 'height' | 'codec'>> {
  const text = await output(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name,nb_frames,r_frame_rate:format=duration',
    '-of',
    'json',
    file,
  ]);
  const empty = { durationSec: null, frames: null, width: null, height: null, codec: null };
  if (!text) return empty;
  try {
    const j = JSON.parse(text) as {
      streams?: Array<Record<string, unknown>>;
      format?: { duration?: string };
    };
    const s = j.streams?.[0] ?? {};
    const duration = Number.parseFloat(j.format?.duration ?? '');
    const [num, den] = String(s.r_frame_rate ?? '')
      .split('/')
      .map(Number);
    const rate = num && den ? num / den : null;
    const counted = Number.parseInt(String(s.nb_frames ?? ''), 10);
    return {
      durationSec: Number.isFinite(duration) ? duration : null,
      frames: Number.isFinite(counted)
        ? counted
        : rate && Number.isFinite(duration)
          ? Math.round(rate * duration)
          : null,
      width: typeof s.width === 'number' ? s.width : null,
      height: typeof s.height === 'number' ? s.height : null,
      codec: typeof s.codec_name === 'string' ? s.codec_name : null,
    };
  } catch {
    return empty;
  }
}

/** The clips in the folder, hashed once per size and change time. */
export async function listClips(dir: string, ffprobe: string): Promise<AgentClip[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const clips: AgentClip[] = [];
  for (const name of names.sort()) {
    if (!CLIP_NAME.test(name) || !/\.(mp4|mov|mkv|m4v|webm)$/i.test(name)) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const key = `${info.size}:${info.mtimeMs}`;
    const known = hashes.get(file);
    if (known?.key === key) {
      clips.push(known.clip);
      continue;
    }
    const clip: AgentClip = {
      name,
      bytes: info.size,
      sha256: await sha256(file),
      ...(await probeClip(ffprobe, file)),
    };
    hashes.set(file, { key, clip });
    clips.push(clip);
  }
  return clips;
}
