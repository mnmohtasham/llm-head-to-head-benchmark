import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  SESSION_SCHEMA_VERSION,
  summarizeSession,
  type SessionSummary,
  type StoredSession,
} from '@duel/shared';
import type { FastifyBaseLogger } from 'fastify';
import { writeFileAtomic } from './store';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isStoredSession(value: unknown): value is StoredSession {
  const s = value as Partial<StoredSession> | null;
  return (
    !!s &&
    typeof s.id === 'string' &&
    ID_PATTERN.test(s.id) &&
    typeof s.schemaVersion === 'number' &&
    typeof s.createdAt === 'string' &&
    typeof s.state === 'string' &&
    !!s.config &&
    typeof s.config.prompt === 'string' &&
    Array.isArray(s.machines) &&
    Array.isArray(s.rounds) &&
    Array.isArray(s.provenance)
  );
}

/**
 * Sessions live in `<dataDir>/sessions/<id>.json`, one file each, with every run's raw events.
 * A summary of each is kept in memory for the results log.
 */
export class SessionStore {
  private readonly index = new Map<string, SessionSummary>();

  constructor(
    readonly dataDir: string,
    private readonly log?: FastifyBaseLogger,
  ) {}

  get dir(): string {
    return path.join(this.dataDir, 'sessions');
  }

  private file(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Not a session id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dir)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!ID_PATTERN.test(id)) continue;
      const session = await this.read(id);
      if (!session) continue;
      if (session.state === 'running') await this.markInterrupted(session);
      this.index.set(session.id, summarizeSession(session));
    }
  }

  /** A race that was running when Model Duel stopped cannot finish; say so instead of pretending. */
  private async markInterrupted(session: StoredSession): Promise<void> {
    const stopped = (await stat(this.file(session.id))).mtime.toISOString();
    session.state = 'interrupted';
    session.error = 'Model Duel stopped before this race finished.';
    session.finishedAt ??= stopped;
    for (const round of session.rounds) {
      for (const run of round.runs) {
        if (run.finishedAt !== null) continue;
        run.state = 'failed';
        run.error = 'Model Duel stopped before this run finished.';
        run.finishedAt = stopped;
      }
    }
    await this.save(session);
  }

  private async read(id: string): Promise<StoredSession | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file(id), 'utf8'));
    } catch (error) {
      this.log?.warn({ sessionId: id, err: error }, 'skipped a session file that cannot be read');
      return null;
    }
    if (!isStoredSession(parsed)) {
      this.log?.warn({ sessionId: id }, 'skipped a session file that is not a Model Duel session');
      return null;
    }
    if (parsed.schemaVersion > SESSION_SCHEMA_VERSION) {
      this.log?.warn(
        { sessionId: id, schemaVersion: parsed.schemaVersion },
        'skipped a session written by a newer version of Model Duel',
      );
      return null;
    }
    return parsed;
  }

  summaries(): SessionSummary[] {
    return [...this.index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  async load(id: string): Promise<StoredSession | null> {
    if (!ID_PATTERN.test(id) || !this.index.has(id)) return null;
    return this.read(id);
  }

  async save(session: StoredSession): Promise<void> {
    await writeFileAtomic(this.file(session.id), `${JSON.stringify(session)}\n`);
    this.index.set(session.id, summarizeSession(session));
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id) || !this.index.has(id)) return false;
    await rm(this.file(id), { force: true });
    this.index.delete(id);
    return true;
  }
}
