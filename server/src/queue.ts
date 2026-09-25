import type { QueueSample } from '@duel/shared';
import type { StoredMachine } from './store';
import { UnslothClient } from './unsloth';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Reads Unsloth's admission queue from the monitor while a batch runs, on fresh connections.
 * Each reading is placed at the middle of its request.
 */
export function watchQueue(
  machine: StoredMachine,
  everyMs: number,
): { stop: () => Promise<QueueSample[]> } {
  const samples: QueueSample[] = [];
  let watching = true;
  const loop = (async () => {
    while (watching) {
      const sent = Date.now();
      const client = new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 3000 });
      const answer = await client
        .getJson('/api/inference/monitor', { timeoutMs: 3000 })
        .finally(() => client.close());
      const received = Date.now();
      const queue = (answer.body as { queue?: Record<string, unknown> } | null)?.queue;
      if (watching && answer.status === 200 && queue) {
        samples.push({
          at: (sent + received) / 2,
          capacity: num(queue.capacity),
          active: num(queue.active) ?? 0,
          queued: num(queue.queued) ?? 0,
        });
      }
      await sleep(everyMs - (received - sent));
    }
  })();
  return {
    stop: async () => {
      watching = false;
      await loop;
      return samples;
    },
  };
}
