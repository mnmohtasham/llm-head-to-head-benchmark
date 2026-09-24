import {
  availabilityOf,
  KV_CACHE_TYPES,
  loadSettingsSchema,
  sameId,
  SPECULATIVE_LABELS,
  SPECULATIVE_TYPES,
  splitArgs,
  type KvCacheType,
  type LoadRequest,
  type MachineModelsView,
  type MachineView,
  type ModelFormat,
  type SpeculativeType,
} from '@duel/shared';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { formatTokens } from '../format';

interface ModelOption {
  modelId: string;
  format: ModelFormat;
  machinesWith: number;
  quants: Array<{ quant: string; machinesWith: number }>;
  nativeContextLength: number | null;
}

/** Every model the selected machines can load, most widely available first. */
function modelOptions(
  models: Record<string, MachineModelsView>,
  selected: readonly string[],
): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const machineId of selected) {
    for (const model of models[machineId]?.models ?? []) {
      if (model.format === 'gguf' && model.quants.length === 0) continue;
      const key = model.modelId.toLowerCase();
      const option = byId.get(key) ?? {
        modelId: model.modelId,
        format: model.format,
        machinesWith: 0,
        quants: [],
        nativeContextLength: model.nativeContextLength,
      };
      option.machinesWith += 1;
      for (const q of model.quants) {
        const known = option.quants.find((x) => sameId(x.quant, q.quant));
        if (known) known.machinesWith += 1;
        else option.quants.push({ quant: q.quant, machinesWith: 1 });
      }
      option.nativeContextLength ??= model.nativeContextLength;
      byId.set(key, option);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.machinesWith - a.machinesWith ||
      a.modelId.localeCompare(b.modelId, undefined, { sensitivity: 'base' }),
  );
}

function bestQuant(option: ModelOption | undefined): string | null {
  if (!option || option.format !== 'gguf') return null;
  return [...option.quants].sort((a, b) => b.machinesWith - a.machinesWith)[0]?.quant ?? null;
}

interface Props {
  machines: MachineView[];
  models: Record<string, MachineModelsView>;
  initialMachineIds: readonly string[];
  initialModelId: string | null;
  busyMachineIds: ReadonlySet<string>;
  onSubmit: (request: LoadRequest) => Promise<void>;
  onClose: () => void;
}

export function LoadDialog({
  machines,
  models,
  initialMachineIds,
  initialModelId,
  busyMachineIds,
  onSubmit,
  onClose,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [selected, setSelected] = useState<string[]>([...initialMachineIds]);
  const options = useMemo(() => modelOptions(models, selected), [models, selected]);
  const [modelId, setModelId] = useState<string>(
    () => initialModelId ?? modelOptions(models, initialMachineIds)[0]?.modelId ?? '',
  );
  const chosen = options.find((option) => sameId(option.modelId, modelId));
  const [quant, setQuant] = useState<string | null>(() =>
    bestQuant(
      modelOptions(models, initialMachineIds).find((o) =>
        sameId(o.modelId, initialModelId ?? modelId),
      ),
    ),
  );
  const [context, setContext] = useState('0');
  const [speculative, setSpeculative] = useState<SpeculativeType>('off');
  const [budget, setBudget] = useState('-1');
  const [slots, setSlots] = useState('1');
  const [kvCache, setKvCache] = useState<'' | KvCacheType>('');
  const [extraArgs, setExtraArgs] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const gguf = chosen ? chosen.format === 'gguf' : true;
  const rows = machines.map((machine) => {
    const availability = availabilityOf(
      models[machine.id]?.models ?? null,
      modelId,
      gguf ? quant : null,
    );
    const machineBusy = busyMachineIds.has(machine.id);
    return {
      machine,
      availability,
      busy: machineBusy,
      ready: availability.state === 'ready' && !machineBusy,
    };
  });
  const readyCount = rows.filter((row) => row.ready && selected.includes(row.machine.id)).length;

  const toggle = (machineId: string, on: boolean) =>
    setSelected((current) =>
      on ? [...current, machineId] : current.filter((x) => x !== machineId),
    );

  const pickModel = (next: string) => {
    setModelId(next);
    setQuant(bestQuant(options.find((option) => sameId(option.modelId, next))));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const settings = loadSettingsSchema.safeParse({
      contextLength: Number(context),
      speculativeType: speculative,
      reasoningBudget: Number(budget),
      parallelSlots: Number(slots),
      cacheTypeKv: kvCache === '' ? null : kvCache,
      extraArgs: splitArgs(extraArgs),
    });
    if (!settings.success) {
      setError(settings.error.issues[0]?.message ?? 'Check the settings.');
      return;
    }
    if (!modelId) {
      setError('Pick a model.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        machineIds: selected,
        modelId,
        quant: gguf ? quant : null,
        settings: settings.data,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const native = chosen?.nativeContextLength;
  const count = selected.length;

  return (
    <dialog
      ref={ref}
      className="dialog dialog-wide"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <h2 id={`${id}-title`} className="dialog-title">
          Load model
        </h2>

        <fieldset className="field">
          <legend>Machines</legend>
          <div className="machine-checks">
            {rows.map(({ machine, availability, busy: machineBusy, ready }) => (
              <label className="machine-check" key={machine.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(machine.id)}
                  onChange={(event) => toggle(machine.id, event.target.checked)}
                />
                <span className="machine-check-name" style={{ color: machine.color }}>
                  {machine.name}
                </span>
                <span
                  className={`availability availability-${machineBusy ? 'busy' : availability.state}`}
                  data-testid={`availability-${machine.name}`}
                >
                  {machineBusy
                    ? 'A load is running here.'
                    : ready
                      ? 'Ready'
                      : `${availability.message} It will be skipped.`}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor={`${id}-model`}>Model</label>
          <select
            id={`${id}-model`}
            value={modelId}
            onChange={(event) => pickModel(event.target.value)}
          >
            {options.length === 0 ? (
              <option value="">No model on the selected machines</option>
            ) : null}
            {chosen === undefined && modelId ? <option value={modelId}>{modelId}</option> : null}
            {options.map((option) => (
              <option key={option.modelId} value={option.modelId}>
                {option.modelId}
                {count > 1 ? `, on ${option.machinesWith} of ${count}` : ''}
              </option>
            ))}
          </select>
        </div>

        {gguf ? (
          <div className="field">
            <label htmlFor={`${id}-quant`}>Quant</label>
            <select
              id={`${id}-quant`}
              value={quant ?? ''}
              onChange={(event) => setQuant(event.target.value || null)}
            >
              {(chosen?.quants ?? []).map((q) => (
                <option key={q.quant} value={q.quant}>
                  {q.quant}
                  {count > 1 ? `, on ${q.machinesWith} of ${count}` : ''}
                </option>
              ))}
            </select>
            <p className="field-hint">
              Only quants fully downloaded on a machine are offered. Model Duel never downloads.
            </p>
          </div>
        ) : null}

        <div className="field-row">
          <div className="field">
            <label htmlFor={`${id}-context`}>Context length</label>
            <input
              id={`${id}-context`}
              inputMode="numeric"
              value={context}
              onChange={(event) => setContext(event.target.value)}
            />
            <p className="field-hint">
              0 lets Unsloth choose.
              {native ? ` The model allows up to ${formatTokens(native)}.` : ''}
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-speculative`}>Speculative decoding</label>
            <select
              id={`${id}-speculative`}
              value={speculative}
              onChange={(event) => setSpeculative(event.target.value as SpeculativeType)}
            >
              {SPECULATIVE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SPECULATIVE_LABELS[type]}
                </option>
              ))}
            </select>
            <p className="field-hint">
              Off keeps a comparison fair: every machine decodes the same way.
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-budget`}>Reasoning budget</label>
            <input
              id={`${id}-budget`}
              inputMode="numeric"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
            <p className="field-hint">
              -1 keeps the model default. 0 turns thinking off where allowed.
            </p>
          </div>
        </div>

        <details className="advanced">
          <summary>Advanced</summary>
          <div className="field-row">
            <div className="field">
              <label htmlFor={`${id}-slots`}>Parallel slots</label>
              <input
                id={`${id}-slots`}
                inputMode="numeric"
                value={slots}
                onChange={(event) => setSlots(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-kv`}>KV cache type</label>
              <select
                id={`${id}-kv`}
                value={kvCache}
                onChange={(event) => setKvCache(event.target.value as '' | KvCacheType)}
              >
                <option value="">Unsloth default</option>
                {KV_CACHE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor={`${id}-args`}>Extra llama-server arguments</label>
            <input
              id={`${id}-args`}
              value={extraArgs}
              onChange={(event) => setExtraArgs(event.target.value)}
              placeholder="--threads 8"
              spellCheck={false}
            />
            <p className="field-hint">GGUF models only. Unsloth refuses flags it manages itself.</p>
          </div>
        </details>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || readyCount === 0}>
            {busy
              ? 'Starting…'
              : `Load on ${readyCount} ${readyCount === 1 ? 'machine' : 'machines'}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
