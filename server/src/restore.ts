import {
  DEFAULT_LOAD_SETTINGS,
  KV_CACHE_TYPES,
  loadSettingsSchema,
  sameId,
  SPECULATIVE_TYPES,
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

/**
 * Loads a machine's chat model again after an image race pushed it out: the same model and quant,
 * with the settings of Model Duel's last load of it, or else the ones its status showed. It goes
 * through the load manager, so the Models tab shows it and pre-flight waits for it.
 */
export function chatRestorer(deps: {
  catalog: ModelCatalog;
  loads: LoadManager;
  store: MachineStore;
}): (machine: StoredMachine, status: ModelStatus) => Promise<RestoreOutcome> {
  return async (machine, status) => {
    const modelId = status.activeModel ?? '';
    const base = { model: modelId, quant: status.quant };
    const view = await deps.catalog.list(machine, { refresh: true });
    const model = view.models?.find((m) => sameId(m.modelId, modelId) || sameId(m.loadId, modelId));
    if (!model) {
      return {
        ...base,
        state: 'failed',
        error: view.error ?? `${modelId} is no longer in ${machine.name}'s models.`,
        durationMs: null,
      };
    }
    if (deps.loads.isActive(machine.id)) {
      return { ...base, state: 'skipped', error: 'Another load was running.', durationMs: null };
    }
    const last = deps.store.lastLoad(machine.id);
    const sameLoad =
      last?.state === 'loaded' &&
      sameId(last.modelId, model.modelId) &&
      (last.quant ?? '').toLowerCase() === (status.quant ?? '').toLowerCase();
    const settings = sameLoad && last ? last.settings : settingsFromStatus(status);
    deps.loads.start(machine, model, status.quant, settings);
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
