import {
  serverName,
  type MachineView,
  type ModelStatus,
  type OllamaLoaded,
  type OllamaModel,
} from '@duel/shared';
import { useCallback, useEffect, useId, useState, type CSSProperties } from 'react';
import { api, messageOf, type OllamaModelsView } from '../api';
import { formatBytes, formatDuration, formatTokens } from '../format';
import { useNow } from '../useNow';
import { ConfirmDialog } from './ConfirmDialog';
import type { NewLogEntry } from './LogPanel';

interface Props {
  machine: MachineView;
  addLog: (entry: NewLogEntry) => void;
}

const STATE_LABEL = {
  checking: 'Checking…',
  loading: 'Loading',
  unloading: 'Unloading',
  error: 'Error',
  ready: 'Ready',
  empty: 'No model',
} as const;

type Busy = { kind: 'load' | 'unload'; name: string; startedAt: number };

/**
 * An Ollama machine on the Models tab: the loaded model and how much of it is on the GPU, Load and
 * Unload through Ollama's own API, and the downloaded models in a collapsed list.
 */
export function OllamaModelPane({ machine, addLog }: Props) {
  const nameId = useId();
  const [view, setView] = useState<OllamaModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [unloading, setUnloading] = useState(false);
  const now = useNow(busy ? 250 : 30_000);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.ollamaModels(machine.id);
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

  const loaded = view?.loaded ?? [];
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

  const load = async (model: string) => {
    setBusy({ kind: 'load', name: model, startedAt: Date.now() });
    try {
      // One model at a time: the others would share the GPU during a race.
      for (const other of loaded) {
        if (other.name !== model) await api.ollamaUnload(machine.id, other.name);
      }
      const answer = await api.ollamaLoad(machine.id, model);
      log(
        'ok',
        `Loaded ${model} in Ollama${answer.seconds === null ? '' : ` in ${formatDuration(answer.seconds * 1000)}`}.`,
      );
    } catch (failure) {
      log('error', `Load of ${model} failed: ${messageOf(failure)}`);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const unload = async () => {
    const names = loaded.map((m) => m.name).join(', ');
    setBusy({ kind: 'unload', name: names, startedAt: Date.now() });
    try {
      for (const model of loaded) await api.ollamaUnload(machine.id, model.name);
      log('info', `Unloaded ${names} in Ollama.`);
    } catch (failure) {
      log('error', `Unload failed: ${messageOf(failure)}`);
    } finally {
      setBusy(null);
      setUnloading(false);
      await refresh();
    }
  };

  return (
    <article
      className="card"
      data-testid="engine-model-pane"
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
                ? `Ollama · ${current.name}`
                : state === 'error'
                  ? 'Ollama · status unavailable'
                  : 'Ollama · no model loaded'}
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

      {busy ? (
        <div className="load-progress">
          <div
            className="progress"
            role="progressbar"
            aria-label={`${busy.kind === 'load' ? 'Loading' : 'Unloading'} ${busy.name}`}
            aria-valuetext="Waiting for Ollama"
          >
            <div className="progress-fill progress-waiting" style={{ width: '100%' }} />
          </div>
          <div className="progress-text">
            <span>
              Ollama answers when it is done
              {busy.kind === 'load' ? ', which can take minutes for a large model' : ''}.
            </span>
            <span>{formatDuration(Math.max(0, now - busy.startedAt))}</span>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="issue issue-error" role="alert">
          <span className="issue-title">Could not read Ollama.</span>{' '}
          <span className="issue-hint">{error}</span>
        </p>
      ) : null}
      {!busy && current ? <OllamaDetails model={current} /> : null}
      {!busy && loaded.length > 1 ? (
        <p className="issue issue-warning" role="alert" data-testid="engine-several">
          <span className="issue-title">More than one model is loaded.</span>{' '}
          <span className="issue-hint">
            {loaded.map((m) => m.name).join(', ')}. Races need one: Unload frees them all, then load
            the one to race.
          </span>
        </p>
      ) : null}

      <div className="card-actions">
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

      <OllamaList
        machine={machine}
        models={view ? view.downloaded : null}
        loaded={loaded.map((m) => m.name)}
        disabled={busy !== null}
        onLoad={(name) => void load(name)}
      />

      {unloading ? (
        <ConfirmDialog
          title="Unload model"
          message={`Unload ${loaded.map((m) => m.name).join(', ')} from Ollama on ${machine.name}? This frees its memory. Loading it again takes time.`}
          confirmLabel="Unload"
          onConfirm={unload}
          onClose={() => setUnloading(false)}
        />
      ) : null}
    </article>
  );
}

function OllamaDetails({ model }: { model: OllamaLoaded }) {
  const onGpu =
    model.sizeBytes && model.sizeVramBytes !== null
      ? Math.round((model.sizeVramBytes / model.sizeBytes) * 100)
      : null;
  const rows: Array<[string, string, string]> = [
    [
      'backend',
      'Backend',
      `${model.format === 'gguf' ? 'GGUF on llama.cpp' : (model.format ?? 'n/a')}, in Ollama`,
    ],
    ['quant', 'Quant', model.quant ?? 'n/a'],
    ['params', 'Parameters', model.params ?? 'n/a'],
    [
      'context',
      'Context',
      model.contextLength ? `${formatTokens(model.contextLength)} tokens` : 'n/a',
    ],
    [
      'gpu',
      'In GPU memory',
      onGpu === null
        ? 'n/a'
        : `${onGpu}%${model.sizeBytes ? ` of ${formatBytes(model.sizeBytes)}` : ''}`,
    ],
    [
      'expires',
      'Stays loaded until',
      model.expiresAt ? new Date(model.expiresAt).toLocaleTimeString() : 'n/a',
    ],
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

function OllamaList({
  machine,
  models,
  loaded,
  disabled,
  onLoad,
}: {
  machine: MachineView;
  models: OllamaModel[] | null;
  loaded: string[];
  disabled: boolean;
  onLoad: (name: string) => void;
}) {
  const [filter, setFilter] = useState('');
  if (!models) return <p className="muted">Reading the model list…</p>;
  const needle = filter.trim().toLowerCase();
  const shown = needle ? models.filter((m) => m.name.toLowerCase().includes(needle)) : models;
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
          {models.length === 0
            ? 'No models in Ollama yet. Pull one with ollama pull on that machine.'
            : 'No model matches.'}
        </p>
      ) : (
        <ul className="model-rows">
          {shown.map((model) => (
            <li
              className="model-row"
              data-testid="model-row"
              data-key={model.name}
              key={model.name}
            >
              <div className="model-row-text">
                <span className="model-id">{model.name}</span>
                <span className="model-meta">
                  {loaded.includes(model.name) ? (
                    <span className="badge badge-loaded">Loaded</span>
                  ) : null}
                  <span>
                    {[
                      model.quant,
                      model.params,
                      model.family,
                      model.sizeBytes ? formatBytes(model.sizeBytes) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </div>
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={() => onLoad(model.name)}
                disabled={disabled || loaded.includes(model.name)}
                aria-label={`Load ${model.name}`}
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

/**
 * An OpenAI-compatible server on the Models tab. It serves the model it was started with, so the
 * pane shows that model and what the server says about it, with nothing to load.
 */
export function CompatModelPane({ machine }: Props) {
  const nameId = useId();
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.machineStatus(machine.id);
      setStatus(next.status);
      setError(next.error);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setRefreshing(false);
      setChecked(true);
    }
  }, [machine.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const name = serverName('openai-compatible', status);
  const state = !checked ? 'checking' : error ? 'error' : status?.activeModel ? 'ready' : 'empty';
  const others = status?.engine?.otherLoaded ?? [];
  const rows: Array<[string, string, string]> = status?.activeModel
    ? [
        ['server', 'Server', `${name}${status.engine?.version ? ` ${status.engine.version}` : ''}`],
        ['quant', 'Quant', status.quant ?? 'n/a'],
        ['params', 'Parameters', status.engine?.params ?? 'n/a'],
        [
          'context',
          'Context',
          status.contextLength ? `${formatTokens(status.contextLength)} tokens` : 'n/a',
        ],
        ['slots', 'Slots', status.parallelSlots !== null ? String(status.parallelSlots) : 'n/a'],
      ]
    : [];

  return (
    <article
      className="card"
      data-testid="engine-model-pane"
      data-machine-name={machine.name}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-labelledby={nameId}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 id={nameId} className="machine-name">
            {machine.name}
          </h2>
          <p className="machine-notes">
            {status?.activeModel ? `${name} · ${status.activeModel}` : `${name} · no model`}
          </p>
        </div>
        <span className={`state state-${state}`} role="status" data-testid="model-state">
          {STATE_LABEL[state]}
        </span>
      </header>
      {error ? (
        <p className="issue issue-error" role="alert">
          <span className="issue-title">Could not read the server.</span>{' '}
          <span className="issue-hint">{error}</span>
        </p>
      ) : null}
      {rows.length > 0 ? (
        <dl className="details">
          {rows.map(([field, label, value]) => (
            <div className="detail-row" key={field}>
              <dt>{label}</dt>
              <dd data-field={field}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {others.length > 0 ? (
        <p className="issue issue-warning" role="alert">
          <span className="issue-title">The server serves more than one model.</span>{' '}
          <span className="issue-hint">
            Races use {status?.activeModel}. Start the server with only the model to race.
          </span>
        </p>
      ) : null}
      <p className="field-hint">
        This server races the model it was started with. To race another, start it again with that
        model, then press Refresh.
      </p>
      <div className="card-actions">
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </article>
  );
}
