import { CLOUD_INFO, type CloudModel, type MachineView } from '@duel/shared';
import type { CSSProperties } from 'react';

/** What a model accepts, in short phrases for its card and the add dialog. */
export function modelFacts(model: CloudModel): string[] {
  const tokens = (n: number) => `${n.toLocaleString('en-US')} tokens`;
  const efforts = model.efforts.filter((level) => level !== 'none');
  return [
    model.contextWindow !== null ? `${tokens(model.contextWindow)} of context` : null,
    model.maxOutput !== null ? `writes up to ${tokens(model.maxOutput)}` : null,
    model.thinking === 'always'
      ? 'always thinks'
      : model.thinking === 'optional'
        ? 'thinks when asked'
        : 'does not think',
    efforts.length > 1
      ? `effort ${efforts[0]} to ${efforts.at(-1)}`
      : efforts.length === 1
        ? `effort ${efforts[0]}`
        : null,
  ].filter((fact): fact is string => fact !== null);
}

interface Props {
  machine: MachineView & { cloud: NonNullable<MachineView['cloud']> };
  onEdit: () => void;
  onDelete: () => void;
}

/** A cloud reference model: nothing to probe, so the card shows its provider and model. */
export function CloudCard({ machine, onEdit, onDelete }: Props) {
  const { provider, model } = machine.cloud;
  const nameId = `machine-${machine.id}`;
  const custom = machine.baseUrl !== CLOUD_INFO[provider].baseUrl;
  return (
    <article
      className="card"
      data-testid="cloud-card"
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
            {CLOUD_INFO[provider].label} · {model ? model.id : 'no model chosen'}
          </p>
        </div>
        <span className={`state ${model ? 'state-cloud' : 'state-warning'}`} role="status">
          {model ? 'Cloud' : 'Pick a model'}
        </span>
      </header>

      {model ? (
        <p className="cloud-facts" data-testid="cloud-facts">
          {modelFacts(model).join(' · ')}
        </p>
      ) : (
        <p className="field-hint">Edit it to fetch the provider’s models and pick one.</p>
      )}
      <p className="field-hint">
        A reference on the Text tab. Its times include the internet and the provider’s queue, and
        each request is billed to the key.
      </p>

      <dl className="meta">
        <div>
          <dt>API</dt>
          <dd className="mono">{custom ? machine.baseUrl : CLOUD_INFO[provider].baseUrl}</dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd className="mono">{machine.apiKeyMasked ?? 'none'}</dd>
        </div>
      </dl>

      <div className="card-actions">
        <button type="button" className="btn btn-outline" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn btn-quiet btn-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}
