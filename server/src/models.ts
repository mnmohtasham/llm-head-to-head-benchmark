import { createHash } from 'node:crypto';
import {
  describeRouteFailure,
  mergeLocalModels,
  normalizeStatus,
  type MachineModelsView,
  type ModelStatus,
  type VariantsAnswer,
} from '@duel/shared';
import type { StoredMachine } from './store';
import { UnslothClient } from './unsloth';

const MODELS_TTL_MS = 20_000;
const VARIANT_REQUESTS_AT_ONCE = 4;

function clientFor(machine: StoredMachine): UnslothClient {
  return new UnslothClient(machine.baseUrl, machine.apiKey, { connectTimeoutMs: 5000 });
}

/** Identifies the address and key a cached answer came from, without keeping the key itself. */
function fingerprint(machine: StoredMachine): string {
  return createHash('sha256')
    .update(`${machine.baseUrl}\n${machine.apiKey ?? ''}`)
    .digest('hex');
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Lists the text models each machine can load from its own disk: the local inventory, the
 * catalog's loaded flags, and the complete quants of every GGUF model. Cached for a short time,
 * because scanning model folders is slow on large disks.
 */
export class ModelCatalog {
  private readonly cache = new Map<
    string,
    { fingerprint: string; at: number; view: MachineModelsView }
  >();

  invalidate(machineId: string): void {
    this.cache.delete(machineId);
  }

  async list(
    machine: StoredMachine,
    options: { refresh?: boolean } = {},
  ): Promise<MachineModelsView> {
    const print = fingerprint(machine);
    const cached = this.cache.get(machine.id);
    if (
      !options.refresh &&
      cached?.fingerprint === print &&
      Date.now() - cached.at < MODELS_TTL_MS
    ) {
      return cached.view;
    }
    const view = await this.fetch(machine);
    if (view.error === null)
      this.cache.set(machine.id, { fingerprint: print, at: Date.now(), view });
    else this.cache.delete(machine.id);
    return view;
  }

  private async fetch(machine: StoredMachine): Promise<MachineModelsView> {
    const client = clientFor(machine);
    try {
      const [local, catalog] = await Promise.all([
        client.getJson('/api/models/local', { timeoutMs: 30_000 }),
        client.getJson('/v1/models', { timeoutMs: 30_000 }),
      ]);
      if (local.status !== 200) {
        return {
          machineId: machine.id,
          models: null,
          fetchedAt: null,
          error: describeRouteFailure(local, machine.baseUrl),
        };
      }
      const catalogBody = catalog.status === 200 ? catalog.body : null;
      const ggufIds = mergeLocalModels(local.body, catalogBody, {})
        .filter((model) => model.format === 'gguf')
        .map((model) => model.loadId);
      const variants: Record<string, VariantsAnswer> = {};
      await eachLimited(ggufIds, VARIANT_REQUESTS_AT_ONCE, async (id) => {
        const query = new URLSearchParams({
          repo_id: id,
          offline: 'true',
          prefer_local_cache: 'true',
        });
        const answer = await client.getJson(`/api/models/gguf-variants?${query}`, {
          timeoutMs: 20_000,
        });
        variants[id] = { status: answer.status, body: answer.body };
      });
      return {
        machineId: machine.id,
        models: mergeLocalModels(local.body, catalogBody, variants),
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    } finally {
      await client.close();
    }
  }
}

export async function readModelStatus(
  machine: StoredMachine,
): Promise<{ status: ModelStatus | null; error: string | null }> {
  const client = clientFor(machine);
  try {
    const answer = await client.getJson('/api/inference/status', { timeoutMs: 10_000 });
    if (answer.status === 200) return { status: normalizeStatus(answer.body), error: null };
    return { status: null, error: describeRouteFailure(answer, machine.baseUrl) };
  } finally {
    await client.close();
  }
}
