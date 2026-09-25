import {
  DEFAULT_LOAD_SETTINGS,
  KV_CACHE_TYPES,
  loadSettingsSchema,
  sameId,
  SPECULATIVE_TYPES,
  type LoadJob,
  type LoadSettings,
  type ModelStatus,
  type RestoreOutcome,
} from '@duel/shared';
import type { LoadManager } from './loads';
import type { ModelCatalog } from './models';
import type { MachineStore, StoredMachine } from './store';

/** The load settings a status shows, for a model Model Duel did not load itself. */
function settingsFromStatus(status: ModelStatus): LoadSettings {
  const parsed = loadSettingsSchema.safeParse({
    contextLength: status.requestedContextLength ?? 0,
    speculativeType: (SPECULATIVE_TYPES as readonly string[]).includes(status.speculativeType ?? '')
      ? status.speculativeType
      : 'off',
    reasoningBudget: status.reasoningBudget ?? -1,
    parallelSlots: Math.min(64, Math.max(1, status.parallelSlots ?? 1)),
    cacheTypeKv: (KV_CACHE_TYPES as readonly string[]).includes(status.cacheTypeKv ?? '')
      ? status.cacheTypeKv
      : null,
    extraArgs: [],
  });
  return parsed.success ? parsed.data : DEFAULT_LOAD_SETTINGS;
}

type Deps = { catalog: ModelCatalog; loads: LoadManager; store: MachineStore };

/**
 * Starts loading a machine's chat model again, the same model and quant, with the settings of
 * Model Duel's last load of it (or else the ones its status showed) and any changes asked for. It
 * goes through the load manager, so the Models tab shows it and pre-flight waits for it.
 */
export async function startChatReload(
  deps: Deps,
  machine: StoredMachine,
  status: ModelStatus,
  changes: Partial<LoadSettings> = {},
): Promise<{ job: LoadJob } | { error: string; skipped?: boolean }> {
  const modelId = status.activeModel ?? '';
  const view = await deps.catalog.list(machine, { refresh: true });
  const model = view.models?.find((m) => sameId(m.modelId, modelId) || sameId(m.loadId, modelId));
  if (!model) {
    return { error: view.error ?? `${modelId} is no longer in ${machine.name}'s models.` };
  }
  if (deps.loads.isActive(machine.id)) return { error: 'Another load was running.', skipped: true };
  const last = deps.store.lastLoad(machine.id);
  const sameLoad =
    last?.state === 'loaded' &&
    sameId(last.modelId, model.modelId) &&
    (last.quant ?? '').toLowerCase() === (status.quant ?? '').toLowerCase();
  const settings = {
    ...(sameLoad && last ? last.settings : settingsFromStatus(status)),
    ...changes,
  };
  return { job: deps.loads.start(machine, model, status.quant, settings) };
}

/** Loads a machine's chat model again after an image race pushed it out, and waits for it. */
export function chatRestorer(
  deps: Deps,
): (machine: StoredMachine, status: ModelStatus) => Promise<RestoreOutcome> {
  return async (machine, status) => {
    const base = { model: status.activeModel ?? '', quant: status.quant };
    const started = await startChatReload(deps, machine, status);
    if ('error' in started) {
      return {
        ...base,
        state: started.skipped ? 'skipped' : 'failed',
        error: started.error,
        durationMs: null,
      };
    }
    await deps.loads.settled(machine.id);
    const job = deps.loads.job(machine.id);
    return job?.state === 'loaded'
      ? { ...base, state: 'loaded', error: null, durationMs: job.durationMs }
      : {
          ...base,
          state: 'failed',
          error: job?.error ?? 'The load did not finish.',
          durationMs: job?.durationMs ?? null,
        };
  };
}
