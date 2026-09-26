import type { LmModel, MachineView } from '@duel/shared';
import { useCallback, useEffect, useId, useState, type CSSProperties } from 'react';
import { api, messageOf, type LmModelsView } from '../api';
import { formatBytes } from '../format';
import { ConfirmDialog } from './ConfirmDialog';
import type { NewLogEntry } from './LogPanel';

interface Props {
  machine: MachineView;
  addLog: (entry: NewLogEntry) => void;
}

const tokens = (n: number | null) => (n === null ? 'n/a' : n.toLocaleString('en-US'));

/**
 * An LM Studio machine on the Models tab: what is loaded and downloaded, with loading and unloading
 * through LM Studio's own API. Races use the one loaded chat model.
 */
export function LmModelPane({ machine, addLog }: Props) {
  const id = useId();
  const [view, setView] = useState<LmModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<LmModel | null>(null);
  const [contextLength, setContextLength] = useState('8192');
  const [parallel, setParallel] = useState('4');
  const [flash, setFlash] = useState(true);
  const [replace, setReplace] = useState(true);
  const [unloading, setUnloading] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.lmModels(machine.id);
      setView(next);
      setError(next.error);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [machine.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const log = (tone: NewLogEntry['tone'], text: string) =>
    addLog({ machineName: machine.name, color: machine.color, tone, text });

  const chats = (view?.models ?? []).filter((m) => m.type === 'llm');
  const loaded = chats.flatMap((m) => m.loaded.map((instance) => ({ model: m, instance })));

  const load = async () => {
    if (!picking) return;
    const model = picking;
    setPicking(null);
    setBusy(`Loading ${model.displayName}…`);
    try {
      if (replace) {
        for (const { instance } of loaded) await api.lmUnload(machine.id, instance.id);
      }
      const context = Number(contextLength);
      const slots = Number(parallel);
      const answer = await api.lmLoad(machine.id, {
        model: model.key,
        ...(Number.isInteger(context) && context > 0 ? { contextLength: context } : {}),
        ...(Number.isInteger(slots) && slots > 0 ? { parallel: slots } : {}),
        flashAttention: flash,
      });
      log(
        'ok',
        `Loaded ${model.displayName} in LM Studio${answer.seconds === null ? '' : ` in ${answer.seconds.toFixed(1)} s`}.`,
      );
    } catch (failure) {
      log('error', `Load of ${model.displayName} failed: ${messageOf(failure)}`);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const unload = async () => {
    if (!unloading) return;
    const instanceId = unloading;
    setBusy(`Unloading ${instanceId}…`);
    try {
      await api.lmUnload(machine.id, instanceId);
      log('info', `Unloaded ${instanceId} in LM Studio.`);
    } catch (failure) {
      log('error', `Unload of ${instanceId} failed: ${messageOf(failure)}`);
    } finally {
      setBusy(null);
      setUnloading(null);
      await refresh();
    }
  };

  return (
    <article
      className="card"
      data-testid="lm-model-pane"
      data-machine-name={machine.name}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-labelledby={`${id}-name`}
      aria-busy={busy !== null}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 id={`${id}-name`} className="machine-name">
            {machine.name}
          </h2>
          <p className="machine-notes">LM Studio</p>
        </div>
        <span className="state state-cloud" role="status">
          {busy ? 'Busy' : loaded.length > 0 ? 'Loaded' : 'No model'}
        </span>
      </header>

      {error ? <p className="field-error">{error}</p> : null}
      {busy ? (
        <p className="field-hint" role="status" data-testid="lm-busy">
          {busy} LM Studio answers when it is done, which can take minutes for a large model.
        </p>
      ) : null}

      <section aria-label="Loaded">
        <h3 className="hero-label">Loaded</h3>
        {loaded.length === 0 ? (
          <p className="field-hint">Nothing is loaded. Load a model below to race it.</p>
        ) : (
          <ul className="lm-list">
            {loaded.map(({ model, instance }) => (
              <li key={instance.id} data-testid="lm-loaded">
                <span className="lm-name">
                  {model.displayName} <span className="muted">{model.quant}</span>
                </span>
                <span className="field-hint">
                  context {tokens(instance.contextLength)} · {instance.parallel ?? '?'} at once ·
                  flash attention {instance.flashAttention === false ? 'off' : 'on'}
                </span>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() => setUnloading(instance.id)}
                  disabled={busy !== null}
                >
                  Unload
                </button>
              </li>
            ))}
          </ul>
        )}
        {loaded.length > 1 ? (
          <p className="note-warn">
            More than one model is loaded. Races need one: unload the others so they do not share
            the GPU.
          </p>
        ) : null}
      </section>

      <section aria-label="Downloaded">
        <h3 className="hero-label">Downloaded</h3>
        {view === null && !error ? <p className="field-hint">Reading LM Studio…</p> : null}
        <ul className="lm-list">
          {chats
            .filter((m) => m.loaded.length === 0)
            .map((model) => (
              <li key={model.key} data-testid="lm-downloaded" data-key={model.key}>
                <span className="lm-name">
                  {model.displayName} <span className="muted">{model.quant}</span>
                </span>
                <span className="field-hint">
                  {model.params ?? ''} · {model.format?.toUpperCase()} ·{' '}
                  {formatBytes(model.sizeBytes)} · up to {tokens(model.maxContextLength)} tokens
                  {model.reasoningOptions.length > 0 ? ' · thinks' : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-outline btn-small"
                  onClick={() => {
                    setPicking(model);
                    setContextLength(String(Math.min(8192, model.maxContextLength ?? 8192)));
                  }}
                  disabled={busy !== null}
                >
                  Load
                </button>
              </li>
            ))}
        </ul>
      </section>

      {picking ? (
        <form
          className="lm-load"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
          aria-label={`Load ${picking.displayName}`}
        >
          <p>
            Load <b>{picking.displayName}</b> {picking.quant} in LM Studio.
          </p>
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
            <input type="checkbox" checked={flash} onChange={(e) => setFlash(e.target.checked)} />
            Flash attention
          </label>
          {loaded.length > 0 ? (
            <label className="check">
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              Unload {loaded.map((l) => l.model.displayName).join(', ')} first
            </label>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-quiet" onClick={() => setPicking(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Load
            </button>
          </div>
        </form>
      ) : null}

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => void refresh()}
          disabled={busy !== null}
        >
          Refresh
        </button>
      </div>

      {unloading ? (
        <ConfirmDialog
          title="Unload model"
          message={`Unload ${unloading} from LM Studio on ${machine.name}? This frees its memory. Loading it again takes time.`}
          confirmLabel="Unload"
          onConfirm={unload}
          onClose={() => setUnloading(null)}
        />
      ) : null}
    </article>
  );
}
