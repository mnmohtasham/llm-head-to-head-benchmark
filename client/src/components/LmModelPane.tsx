import type { LmModel, MachineView } from '@duel/shared';
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { api, messageOf, type LmModelsView } from '../api';
import { formatBytes, formatDuration, formatTokens } from '../format';
import { useNow } from '../useNow';
import { ConfirmDialog } from './ConfirmDialog';
import type { NewLogEntry } from './LogPanel';

interface Props {
  machine: MachineView;
  addLog: (entry: NewLogEntry) => void;
}

/** A load or unload in flight, and how the last load ended. */
type Busy = { kind: 'load' | 'unload'; name: string; startedAt: number };
type LastLoad = { name: string; seconds: number | null; error: string | null };

const STATE_LABEL = {
  checking: 'Checking…',
  loading: 'Loading',
  unloading: 'Unloading',
  error: 'Error',
  ready: 'Ready',
  empty: 'No model',
} as const;

const FORMAT_LABEL: Record<string, string> = { gguf: 'GGUF', mlx: 'MLX' };

/**
 * An LM Studio machine on the Models tab, laid out like an Unsloth machine's pane: the loaded
 * model and its settings, Load model, Unload and Refresh, and the models on the machine in a
 * collapsed list. Loads and unloads go through LM Studio's own API.
 */
export function LmModelPane({ machine, addLog }: Props) {
  const nameId = useId();
  const [view, setView] = useState<LmModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [last, setLast] = useState<LastLoad | null>(null);
  const [dialog, setDialog] = useState<{ key: string | null } | null>(null);
  const [unloading, setUnloading] = useState(false);
  const now = useNow(busy ? 250 : 30_000);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.lmModels(machine.id);
      setView(next);
      setError(next.error);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setRefreshing(false);
    }
  }, [machine.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const log = (tone: NewLogEntry['tone'], text: string) =>
    addLog({ machineName: machine.name, color: machine.color, tone, text });

  const chats = (view?.models ?? []).filter((m) => m.type === 'llm');
  const loaded = chats.flatMap((m) => m.loaded.map((instance) => ({ model: m, instance })));
  const current = loaded[0] ?? null;
  const state = busy
    ? busy.kind === 'load'
      ? 'loading'
      : 'unloading'
    : view === null && !error
      ? 'checking'
      : error
        ? 'error'
        : current
          ? 'ready'
          : 'empty';

  const load = async (options: LoadOptions) => {
    const model = chats.find((m) => m.key === options.key);
    if (!model) return;
    setDialog(null);
    setBusy({ kind: 'load', name: model.displayName, startedAt: Date.now() });
    try {
      if (options.replace) {
        for (const { instance } of loaded) await api.lmUnload(machine.id, instance.id);
      }
      const answer = await api.lmLoad(machine.id, {
        model: model.key,
        ...(options.contextLength ? { contextLength: options.contextLength } : {}),
        ...(options.parallel ? { parallel: options.parallel } : {}),
        flashAttention: options.flashAttention,
      });
      setLast({
        name: `${model.displayName} ${model.quant ?? ''}`.trim(),
        seconds: answer.seconds,
        error: null,
      });
      log(
        'ok',
        `Loaded ${model.displayName} in LM Studio${answer.seconds === null ? '' : ` in ${formatDuration(answer.seconds * 1000)}`}.`,
      );
    } catch (failure) {
      const message = messageOf(failure);
      setLast({ name: model.displayName, seconds: null, error: message });
      log('error', `Load of ${model.displayName} failed: ${message}`);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const unload = async () => {
    const names = loaded.map((l) => l.model.displayName).join(', ');
    setBusy({ kind: 'unload', name: names, startedAt: Date.now() });
    try {
      for (const { instance } of loaded) await api.lmUnload(machine.id, instance.id);
      log('info', `Unloaded ${names} in LM Studio.`);
    } catch (failure) {
      log('error', `Unload failed: ${messageOf(failure)}`);
    } finally {
      setBusy(null);
      setUnloading(false);
      await refresh();
    }
  };

  const elapsed = busy ? Math.max(0, now - busy.startedAt) : 0;

  return (
    <article
      className="card"
      data-testid="lm-model-pane"
      data-machine-name={machine.name}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-labelledby={nameId}
      aria-busy={busy !== null}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 id={nameId} className="machine-name">
            {machine.name}
          </h2>
          <p className="machine-notes">
            {busy
              ? `${busy.kind === 'load' ? 'Loading' : 'Unloading'} ${busy.name}`
              : current
                ? `LM Studio · ${current.model.key}`
                : state === 'error'
                  ? 'LM Studio · status unavailable'
                  : 'LM Studio · no model loaded'}
          </p>
        </div>
        <span
          className={`state state-${state === 'unloading' ? 'loading' : state}`}
          role="status"
          data-testid="model-state"
        >
          {STATE_LABEL[state]}
        </span>
      </header>

      {busy || last ? (
        <div className="hero">
          <span className="hero-label">
            {busy ? (busy.kind === 'load' ? 'Loading for' : 'Unloading for') : 'Load time'}
          </span>
          <span className="hero-value" data-testid="load-time">
            {busy
              ? formatDuration(elapsed)
              : last && last.seconds !== null
                ? formatDuration(last.seconds * 1000)
                : 'n/a'}
          </span>
        </div>
      ) : null}

      {busy ? (
        <div className="load-progress">
          <div
            className="progress"
            role="progressbar"
            aria-label={`${busy.kind === 'load' ? 'Loading' : 'Unloading'} ${busy.name}`}
            aria-valuetext="Waiting for LM Studio"
          >
            <div className="progress-fill progress-waiting" style={{ width: '100%' }} />
          </div>
          <div className="progress-text">
            <span>
              LM Studio answers when it is done
              {busy.kind === 'load' ? ', which can take minutes for a large model' : ''}.
            </span>
          </div>
        </div>
      ) : last ? (
        last.error ? (
          <p className="issue issue-error" role="alert" data-testid="last-load">
            <span className="issue-title">Load of {last.name} failed.</span>{' '}
            <span className="issue-hint">{last.error}</span>
          </p>
        ) : (
          <p className="load-result" data-testid="last-load">
            Loaded {last.name}
            {last.seconds === null ? '.' : ` in ${formatDuration(last.seconds * 1000)}.`}
          </p>
        )
      ) : null}

      {error ? (
        <p className="issue issue-error" role="alert">
          <span className="issue-title">Could not read LM Studio.</span>{' '}
          <span className="issue-hint">{error}</span>
        </p>
      ) : null}
      {!busy && current ? (
        <LoadedDetails model={current.model} instance={current.instance} />
      ) : null}
      {!busy && loaded.length > 1 ? (
        <p className="issue issue-warning" role="alert" data-testid="lm-several">
          <span className="issue-title">More than one model is loaded.</span>{' '}
          <span className="issue-hint">
            {loaded.map((l) => l.model.displayName).join(', ')}. Races need one: Unload frees them
            all, then load the one to race.
          </span>
        </p>
      ) : null}

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => setDialog({ key: null })}
          disabled={busy !== null || chats.length === 0}
        >
          Load model
        </button>
        {!busy && loaded.length > 0 ? (
          <button type="button" className="btn btn-quiet" onClick={() => setUnloading(true)}>
            Unload
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => void refresh()}
          disabled={refreshing || busy !== null}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <ModelList
        machine={machine}
        models={view ? chats : null}
        disabled={busy !== null}
        onLoad={(key) => setDialog({ key })}
      />

      {dialog ? (
        <LoadDialog
          machine={machine}
          models={chats}
          initialKey={dialog.key ?? current?.model.key ?? chats[0]?.key ?? ''}
          loaded={loaded.map((l) => l.model.displayName)}
          onSubmit={(options) => void load(options)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {unloading ? (
        <ConfirmDialog
          title="Unload model"
          message={`Unload ${loaded.map((l) => l.model.displayName).join(', ')} from LM Studio on ${machine.name}? This frees its memory. Loading it again takes time.`}
          confirmLabel="Unload"
          onConfirm={unload}
          onClose={() => setUnloading(false)}
        />
      ) : null}
    </article>
  );
}

function LoadedDetails({
  model,
  instance,
}: {
  model: LmModel;
  instance: LmModel['loaded'][number];
}) {
  const context =
    instance.contextLength !== null
      ? `${formatTokens(instance.contextLength)} tokens${model.maxContextLength ? ` of ${formatTokens(model.maxContextLength)}` : ''}`
      : 'n/a';
  const thinking =
    model.reasoningOptions.length === 0
      ? 'Not supported'
      : model.reasoningOptions.includes('off')
        ? `Supported: ${model.reasoningOptions.join(', ')}`
        : `Always on: ${model.reasoningOptions.join(', ')}`;
  const rows: Array<[string, string, string]> = [
    ['backend', 'Backend', `${model.format === 'mlx' ? 'MLX' : 'GGUF on llama.cpp'}, in LM Studio`],
    ...(model.quant ? ([['quant', 'Quant', model.quant]] as Array<[string, string, string]>) : []),
    ['context', 'Context', context],
    ['slots', 'Slots', instance.parallel !== null ? String(instance.parallel) : 'n/a'],
    [
      'flash-attention',
      'Flash attention',
      instance.flashAttention === null ? 'n/a' : instance.flashAttention ? 'On' : 'Off',
    ],
    [
      'kv-cache',
      'KV cache',
      instance.offloadKvToGpu === null ? 'n/a' : instance.offloadKvToGpu ? 'On the GPU' : 'In RAM',
    ],
    ['thinking', 'Thinking', thinking],
  ];
  return (
    <dl className="details">
      {rows.map(([field, label, value]) => (
        <div className="detail-row" key={field}>
          <dt>{label}</dt>
          <dd data-field={field}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ModelList({
  machine,
  models,
  disabled,
  onLoad,
}: {
  machine: MachineView;
  models: LmModel[] | null;
  disabled: boolean;
  onLoad: (key: string) => void;
}) {
  const [filter, setFilter] = useState('');
  if (!models) return <p className="muted">Reading the model list…</p>;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? models.filter(
        (m) => m.key.toLowerCase().includes(needle) || m.displayName.toLowerCase().includes(needle),
      )
    : models;
  return (
    <details className="model-list">
      <summary>
        Models on this machine <span className="muted-inline">({models.length})</span>
      </summary>
      <input
        type="search"
        className="filter"
        placeholder="Filter by name"
        aria-label={`Filter models on ${machine.name}`}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {shown.length === 0 ? (
        <p className="muted">
          {models.length === 0 ? 'No chat models in LM Studio.' : 'No model matches.'}
        </p>
      ) : (
        <ul className="model-rows">
          {shown.map((model) => (
            <li className="model-row" data-testid="model-row" data-key={model.key} key={model.key}>
              <div className="model-row-text">
                <span className="model-id">{model.displayName}</span>
                <span className="model-meta">
                  {model.loaded.length > 0 ? (
                    <span className="badge badge-loaded">Loaded</span>
                  ) : null}
                  <span className="badge">
                    {FORMAT_LABEL[model.format ?? ''] ?? model.format ?? '?'}
                  </span>
                  <span>
                    {[
                      model.quant,
                      model.params,
                      model.sizeBytes ? formatBytes(model.sizeBytes) : null,
                      model.maxContextLength
                        ? `up to ${formatTokens(model.maxContextLength)} tokens`
                        : null,
                      model.reasoningOptions.length > 0 ? 'thinks' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="model-note">{model.key}</span>
              </div>
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={() => onLoad(model.key)}
                disabled={disabled}
                aria-label={`Load ${model.displayName}`}
              >
                Load
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

interface LoadOptions {
  key: string;
  contextLength: number | null;
  parallel: number | null;
  flashAttention: boolean;
  replace: boolean;
}

/** Which model to load and how: LM Studio's context length, parallel requests and flash attention. */
function LoadDialog({
  machine,
  models,
  initialKey,
  loaded,
  onSubmit,
  onClose,
}: {
  machine: MachineView;
  models: LmModel[];
  initialKey: string;
  loaded: string[];
  onSubmit: (options: LoadOptions) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [key, setKey] = useState(initialKey);
  const model = models.find((m) => m.key === key) ?? null;
  const [contextLength, setContextLength] = useState(
    String(Math.min(8192, model?.maxContextLength ?? 8192)),
  );
  const [parallel, setParallel] = useState('4');
  const [flash, setFlash] = useState(true);
  const [replace, setReplace] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const pick = (next: string) => {
    setKey(next);
    const chosen = models.find((m) => m.key === next);
    setContextLength(String(Math.min(8192, chosen?.maxContextLength ?? 8192)));
  };

  const submit = () => {
    const context = Number(contextLength);
    const slots = Number(parallel);
    if (!model) return setProblem('Pick a model.');
    if (!Number.isInteger(context) || context < 256) {
      return setProblem('Use a whole number of tokens, 256 or more.');
    }
    if (model.maxContextLength !== null && context > model.maxContextLength) {
      return setProblem(
        `${model.displayName} takes at most ${formatTokens(model.maxContextLength)} tokens.`,
      );
    }
    if (!Number.isInteger(slots) || slots < 1 || slots > 64) {
      return setProblem('Use 1 to 64 requests at once.');
    }
    onSubmit({ key, contextLength: context, parallel: slots, flashAttention: flash, replace });
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      data-testid="lm-load-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <h2 id={`${id}-title`} className="dialog-title">
          Load a model
        </h2>
        <p className="field-hint">In LM Studio on {machine.name}.</p>
        <div className="field">
          <label htmlFor={`${id}-model`}>Model</label>
          <select id={`${id}-model`} value={key} onChange={(event) => pick(event.target.value)}>
            {models.map((m) => (
              <option key={m.key} value={m.key}>
                {m.displayName}
                {m.quant ? ` ${m.quant}` : ''}
                {m.loaded.length > 0 ? ' (loaded)' : ''}
              </option>
            ))}
          </select>
          {model ? (
            <p className="field-hint">
              {[
                model.params,
                model.sizeBytes ? formatBytes(model.sizeBytes) : null,
                model.maxContextLength
                  ? `up to ${formatTokens(model.maxContextLength)} tokens`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>
        <div className="run-options">
          <div className="field">
            <label htmlFor={`${id}-context`}>Context length</label>
            <input
              id={`${id}-context`}
              inputMode="numeric"
              value={contextLength}
              onChange={(event) => setContextLength(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-parallel`}>Requests at once</label>
            <input
              id={`${id}-parallel`}
              inputMode="numeric"
              value={parallel}
              onChange={(event) => setParallel(event.target.value)}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={flash}
            onChange={(event) => setFlash(event.target.checked)}
          />
          Flash attention
        </label>
        {loaded.length > 0 ? (
          <label className="check">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            Unload {loaded.join(', ')} first
          </label>
        ) : null}
        {problem ? (
          <p className="form-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Load
          </button>
        </div>
      </form>
    </dialog>
  );
}
