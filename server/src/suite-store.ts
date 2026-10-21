import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { SUITE_SCHEMA_VERSION, summarizeSuite, type Suite, type SuiteSummary } from '@duel/shared';
import type { FastifyBaseLogger } from 'fastify';
import { writeFileAtomic } from './store';

export const SUITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isStoredSuite(value: unknown): value is Suite {
  const s = value as Partial<Suite> | null;
  return (
    !!s &&
    typeof s.id === 'string' &&
    SUITE_ID_PATTERN.test(s.id) &&
    typeof s.schemaVersion === 'number' &&
    typeof s.createdAt === 'string' &&
    typeof s.state === 'string' &&
    !!s.settings &&
    typeof s.settings === 'object' &&
    Array.isArray(s.settings.presets) &&
    Array.isArray(s.settings.thinking) &&
    Array.isArray(s.settings.maxTokens) &&
    Array.isArray(s.machines) &&
    Array.isArray(s.races) &&
    s.races.every(
      (race) =>
        !!race &&
        typeof race.state === 'string' &&
        !!race.combo &&
        Array.isArray(race.results) &&
        Array.isArray(race.issues),
    )
  );
}

/**
 * Suites live in `<dataDir>/suites/<id>.json`, one file each, beside the races they ran, which are
 * ordinary sessions. A summary of each is kept in memory for the list of suites.
 */
export class SuiteStore {
  private readonly index = new Map<string, SuiteSummary>();

  constructor(
    readonly dataDir: string,
    private readonly log?: FastifyBaseLogger,
  ) {}

  get dir(): string {
    return path.join(this.dataDir, 'suites');
  }

  private file(id: string): string {
    if (!SUITE_ID_PATTERN.test(id)) throw new Error(`Not a suite id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.dir)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!SUITE_ID_PATTERN.test(id)) continue;
      const suite = await this.read(id);
      if (!suite) continue;
      if (suite.state === 'running') await this.markInterrupted(suite);
      this.index.set(suite.id, summarizeSuite(suite));
    }
  }

  /** A suite that was running when Model Duel stopped never resumes by itself; it says so. */
  private async markInterrupted(suite: Suite): Promise<void> {
    const stopped = (await stat(this.file(suite.id))).mtime.toISOString();
    suite.state = 'interrupted';
    suite.error = 'Model Duel stopped before this suite finished.';
    suite.finishedAt ??= stopped;
    for (const race of suite.races) {
      if (race.state === 'running') {
        race.state = 'interrupted';
        race.error = 'Model Duel stopped during this race.';
        race.finishedAt = stopped;
      } else if (race.state === 'queued') {
        race.state = 'interrupted';
        race.error = 'Model Duel stopped before this race started.';
      }
    }
    await this.save(suite);
  }

  private async read(id: string): Promise<Suite | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file(id), 'utf8'));
    } catch (error) {
      this.log?.warn({ suiteId: id, err: error }, 'skipped a suite file that cannot be read');
      return null;
    }
    if (!isStoredSuite(parsed) || parsed.id !== id) {
      this.log?.warn({ suiteId: id }, 'skipped a suite file that is not a Model Duel suite');
      return null;
    }
    if (parsed.schemaVersion > SUITE_SCHEMA_VERSION) {
      this.log?.warn(
        { suiteId: id, schemaVersion: parsed.schemaVersion },
        'skipped a suite written by a newer version of Model Duel',
      );
      return null;
    }
    return parsed;
  }

  summaries(): SuiteSummary[] {
    return [...this.index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async load(id: string): Promise<Suite | null> {
    if (!SUITE_ID_PATTERN.test(id) || !this.index.has(id)) return null;
    return this.read(id);
  }

  async save(suite: Suite): Promise<void> {
    await writeFileAtomic(this.file(suite.id), `${JSON.stringify(suite)}\n`);
    this.index.set(suite.id, summarizeSuite(suite));
  }

  /** Removes the suite's record; its races stay. */
  async remove(id: string): Promise<boolean> {
    if (!SUITE_ID_PATTERN.test(id) || !this.index.has(id)) return false;
    await rm(this.file(id), { force: true });
    this.index.delete(id);
    return true;
  }
}
