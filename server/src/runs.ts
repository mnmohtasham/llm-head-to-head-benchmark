import { deviceRuns, type DeviceRun, type SessionSummary } from '@duel/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { SessionStore } from './session-store';

/**
 * The Results tab's rows: one per machine per finished race. A race's rows are built once and
 * kept until it is saved again, which gives it a new summary, or deleted.
 */
export class DeviceRunIndex {
  private readonly cache = new Map<string, { summary: SessionSummary; runs: DeviceRun[] }>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly log?: FastifyBaseLogger,
  ) {}

  async all(): Promise<DeviceRun[]> {
    const summaries = this.sessions.summaries().filter((s) => s.finishedAt !== null);
    const live = new Set(summaries.map((s) => s.id));
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
    const out: DeviceRun[] = [];
    for (const summary of summaries) {
      let hit = this.cache.get(summary.id);
      if (!hit || hit.summary !== summary) {
        const stored = await this.sessions.load(summary.id);
        if (!stored) continue;
        try {
          hit = { summary, runs: deviceRuns(stored) };
        } catch (error) {
          this.log?.warn({ sessionId: summary.id, err: error }, 'left a race out of the results');
          continue;
        }
        this.cache.set(summary.id, hit);
      }
      out.push(...hit.runs);
    }
    return out;
  }
}
