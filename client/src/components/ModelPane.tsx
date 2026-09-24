import {
  isActiveJob,
  SPECULATIVE_LABELS,
  type LoadJob,
  type LocalModel,
  type MachineModelsView,
  type MachineStatusView,
  type MachineView,
  type ModelStatus,
} from '@duel/shared';
import { useState, type CSSProperties } from 'react';
import { formatBytes, formatDuration, formatTokens } from '../format';
import { useNow } from '../useNow';

const FORMAT_LABEL: Record<LocalModel['format'], string> = {
  gguf: 'GGUF',
  mlx: 'MLX',
  safetensors: 'Safetensors',
};

const STATE_LABEL = {
  checking: 'Checking…',
  loading: 'Loading',
  cancelling: 'Cancelling…',
  error: 'Error',
  ready: 'Ready',
  empty: 'No model',
} as const;

interface Props {
  machine: MachineView;
  statusView: MachineStatusView | null;
  modelsView: MachineModelsView | null;
  job: LoadJob | null;
  /** Server time minus browser time, so elapsed times stay right across computers. */
  clockOffset: number;
  refreshing: boolean;
  onLoad: (modelId?: string) => void;
  onCancel: () => void;
  onUnload: () => void;
  onRefresh: () => void;
}

export function ModelPane(props: Props) {
  const { machine, statusView, modelsView, job, clockOffset, refreshing } = props;
  const active = isActiveJob(job);
  const now = useNow(active ? 250 : 30_000);
  const status = statusView?.status ?? null;
  const state = active
    ? job?.state === 'cancelling'
      ? 'cancelling'
      : 'loading'
    : statusView === null
      ? 'checking'
      : statusView.error
        ? 'error'
        : status?.activeModel
          ? 'ready'
          : 'empty';
  const percent = active && job?.progress ? Math.round(job.progress.fraction * 100) : null;
  const elapsed = job ? Math.max(0, now + clockOffset - Date.parse(job.startedAt)) : 0;
  const nameId = `pane-${machine.id}`;

  return (
    <article
      className="card"
      data-testid="model-pane"
      data-machine-name={machine.name}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-labelledby={nameId}
      aria-busy={active}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 id={nameId} className="machine-name">
            {machine.name}
          </h2>
          <p className="machine-notes">
            {active && job
              ? `Loading ${job.displayName}${job.quant ? ` ${job.quant}` : ''}`
              : (status?.activeModel ??
                (state === 'error' ? 'Status unavailable' : 'No model loaded'))}
          </p>
        </div>
        <span className={`state state-${state}`} data-testid="model-state" role="status">
          {state === 'loading' && percent !== null ? `Loading ${percent}%` : STATE_LABEL[state]}
        </span>
      </header>

      {job ? (
        <div className="hero">
          <span className="hero-label">{active ? 'Loading for' : 'Load time'}</span>
          <span className="hero-value" data-testid="load-time">
            {active
              ? formatDuration(elapsed)
              : job.state === 'loaded' && job.durationMs !== null
                ? formatDuration(job.durationMs)
                : 'n/a'}
          </span>
        </div>
      ) : null}

      {active && job ? <Progress job={job} percent={percent} onCancel={props.onCancel} /> : null}
      {!active && job ? <LastLoad job={job} /> : null}

      {statusView?.error ? (
        <p className="issue issue-error" role="alert">
          <span className="issue-title">Could not read the status.</span>{' '}
          <span className="issue-hint">{statusView.error}</span>
        </p>
      ) : null}
      {!active && status?.memoryWarning ? (
        <p className="issue issue-error" role="alert" data-testid="memory-warning">
          <span className="issue-title">Memory warning.</span>{' '}
          <span className="issue-hint">{status.memoryWarning}</span>
        </p>
      ) : null}
      {!active && status?.activeModel ? <StatusDetails status={status} /> : null}

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => props.onLoad()}
          disabled={active || !modelsView?.models}
        >
          Load model
        </button>
        {!active && status?.activeModel ? (
          <button type="button" className="btn btn-quiet" onClick={props.onUnload}>
            Unload
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={props.onRefresh}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <ModelList machine={machine} view={modelsView} disabled={active} onLoad={props.onLoad} />
    </article>
  );
}

function Progress({
  job,
  percent,
  onCancel,
}: {
  job: LoadJob;
  percent: number | null;
  onCancel: () => void;
}) {
  const progress = job.progress;
  const phase =
    job.state === 'cancelling'
      ? 'Cancelling'
      : progress?.phase === 'mmap'
        ? 'Reading the weights'
        : progress?.phase === 'ready'
          ? 'Starting the model server'
          : 'Loading';
  const bytes =
    progress && progress.bytesTotal > 0
      ? ` · ${formatBytes(progress.bytesLoaded)} of ${formatBytes(progress.bytesTotal)}`
      : '';
  return (
    <div className="load-progress">
      <div
        className="progress"
        role="progressbar"
        aria-label={`Loading ${job.displayName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? 'Waiting for progress' : `${percent}%`}
      >
        <div
          className={`progress-fill${percent === null ? ' progress-waiting' : ''}`}
          style={{ width: `${percent ?? 100}%` }}
        />
      </div>
      <div className="progress-text">
        <span>
          {phase} {job.displayName}
          {job.quant ? ` ${job.quant}` : ''}
          {bytes}
        </span>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          onClick={onCancel}
          disabled={job.state === 'cancelling'}
        >
          Cancel load
        </button>
      </div>
    </div>
  );
}

function LastLoad({ job }: { job: LoadJob }) {
  const took = formatDuration(job.durationMs ?? 0);
  const name = `${job.displayName}${job.quant ? ` ${job.quant}` : ''}`;
  if (job.state === 'loaded') {
    return (
      <p className="load-result" data-testid="last-load">
        Loaded {name} in {took}
        {job.alreadyLoaded ? '. It was already loaded with these settings.' : '.'}
      </p>
    );
  }
  if (job.state === 'cancelled') {
    return (
      <p className="load-result" data-testid="last-load">
        Load of {name} cancelled after {took}.
      </p>
    );
  }
  return (
    <p className="issue issue-error" role="alert" data-testid="last-load">
      <span className="issue-title">Load of {name} failed.</span>{' '}
      <span className="issue-hint">{job.error}</span>
    </p>
  );
}

function StatusDetails({ status }: { status: ModelStatus }) {
  const context =
    status.contextLength !== null
      ? `${formatTokens(status.contextLength)} tokens${status.nativeContextLength ? ` of ${formatTokens(status.nativeContextLength)}` : ''}`
      : 'n/a';
  const speculative = status.speculativeType
    ? [
        SPECULATIVE_LABELS[status.speculativeType as keyof typeof SPECULATIVE_LABELS] ??
          status.speculativeType,
        status.specDrafterKind ? `${status.specDrafterKind} drafter` : null,
        status.specFallbackReason ? `fell back: ${status.specFallbackReason}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'n/a';
  const gpuLayers =
    status.gpuMemoryMode === 'manual' && status.gpuLayers !== null && status.gpuLayers >= 0
      ? `${status.gpuLayers}${status.totalLayers ? ` of ${status.totalLayers}` : ''}`
      : 'Auto, fitted by Unsloth';
  const thinking = status.supportsReasoning
    ? `${status.reasoningAlwaysOn ? 'Always on' : 'Supported'}${status.reasoningBudget !== null && status.reasoningBudget >= 0 ? `, budget ${formatTokens(status.reasoningBudget)}` : ''}`
    : 'Not supported';
  const rows: Array<[string, string, string]> = [
    [
      'backend',
      'Backend',
      status.backend === 'gguf'
        ? 'GGUF on llama.cpp'
        : status.backend === 'mlx'
          ? 'MLX'
          : 'Transformers',
    ],
    ...(status.quant
      ? ([['quant', 'Quant', status.quant]] as Array<[string, string, string]>)
      : []),
    ['context', 'Context', context],
    ['speculative', 'Speculative', speculative],
    [
      'kv-cache',
      'KV cache',
      status.cacheTypeKv ?? (status.mlxKvBits ? `${status.mlxKvBits}-bit` : 'Unsloth default'),
    ],
    ['gpu-layers', 'GPU layers', gpuLayers],
    ['slots', 'Slots', status.parallelSlots !== null ? String(status.parallelSlots) : 'n/a'],
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
  view,
  disabled,
  onLoad,
}: {
  machine: MachineView;
  view: MachineModelsView | null;
  disabled: boolean;
  onLoad: (modelId?: string) => void;
}) {
  const [filter, setFilter] = useState('');
  if (!view) return <p className="muted">Reading the model list…</p>;
  if (view.error) {
    return (
      <p className="issue issue-error">
        <span className="issue-title">Could not read the model list.</span>{' '}
        <span className="issue-hint">{view.error}</span>
      </p>
    );
  }
  const models = view.models ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? models.filter((m) => m.modelId.toLowerCase().includes(needle)) : models;
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
          {models.length === 0 ? 'No text models on this machine.' : 'No model matches.'}
        </p>
      ) : (
        <ul className="model-rows">
          {shown.map((model) => (
            <ModelRow
              key={model.loadId}
              model={model}
              disabled={disabled}
              onLoad={() => onLoad(model.modelId)}
            />
          ))}
        </ul>
      )}
    </details>
  );
}

function ModelRow({
  model,
  disabled,
  onLoad,
}: {
  model: LocalModel;
  disabled: boolean;
  onLoad: () => void;
}) {
  const loadable = model.format !== 'gguf' || model.quants.length > 0;
  const quants =
    model.format !== 'gguf'
      ? null
      : model.quants.length > 0
        ? model.quants
            .map((q) => (q.sizeBytes ? `${q.quant} (${formatBytes(q.sizeBytes)})` : q.quant))
            .join(', ')
        : 'No complete quant on disk';
  return (
    <li className="model-row" data-testid="model-row">
      <div className="model-row-text">
        <span className="model-id">{model.modelId}</span>
        <span className="model-meta">
          {model.loaded ? <span className="badge badge-loaded">Loaded</span> : null}
          <span className="badge">{FORMAT_LABEL[model.format]}</span>
          {model.source === 'lmstudio' ? <span className="badge">LM Studio</span> : null}
          {quants ? <span>{quants}</span> : null}
        </span>
        {model.note ? <span className="model-note">{model.note}</span> : null}
      </div>
      {loadable ? (
        <button
          type="button"
          className="btn btn-quiet btn-small"
          onClick={onLoad}
          disabled={disabled}
          aria-label={`Load ${model.modelId}`}
        >
          Load
        </button>
      ) : null}
    </li>
  );
}
