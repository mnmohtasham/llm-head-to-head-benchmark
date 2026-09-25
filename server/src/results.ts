import { createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  buildResult,
  canonicalJson,
  type ResultFile,
  type StoredSession,
  type UnsignedResult,
} from '@duel/shared';
import { writeFileAtomic } from './store';

/** Adds the checksum over the canonical JSON of everything else. */
export function signResult(unsigned: UnsignedResult): ResultFile {
  const sha256 = createHash('sha256').update(canonicalJson(unsigned)).digest('hex');
  return { ...unsigned, sha256 };
}

/** Whether a result's checksum still matches its content. */
export function verifyResult(result: ResultFile): boolean {
  const { sha256, ...rest } = result;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex') === sha256;
}

/** `model-duel-2026-09-25-1a2b3c4d.json`, the same name the export uses. */
export function resultFileName(session: { id: string; createdAt: string }): string {
  return `model-duel-${session.createdAt.slice(0, 10)}-${session.id.slice(0, 8)}.json`;
}

/**
 * The result files, one per finished race, in `<dataDir>/results/`: the public format, ready to
 * share. They are written when a race ends and rebuilt from the session whenever asked for.
 */
export class ResultStore {
  constructor(
    readonly dataDir: string,
    private readonly generator: { version: string; build: string | null },
  ) {}

  private dir(): string {
    return path.join(this.dataDir, 'results');
  }

  build(session: StoredSession): ResultFile {
    return signResult(buildResult(session, this.generator));
  }

  async write(session: StoredSession): Promise<ResultFile> {
    const result = this.build(session);
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      path.join(this.dir(), resultFileName(session)),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return result;
  }

  async remove(session: { id: string; createdAt: string }): Promise<void> {
    await rm(path.join(this.dir(), resultFileName(session)), { force: true });
  }

  /** Writes the result of every finished session that has none yet, for races from before. */
  async backfill(sessions: AsyncIterable<StoredSession>): Promise<number> {
    const existing = new Set(await readdir(this.dir()).catch(() => [] as string[]));
    let written = 0;
    for await (const session of sessions) {
      if (session.finishedAt === null || existing.has(resultFileName(session))) continue;
      await this.write(session);
      written += 1;
    }
    return written;
  }
}
