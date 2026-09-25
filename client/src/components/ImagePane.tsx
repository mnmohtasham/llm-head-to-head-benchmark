import type { RunView, TelemetrySample, TelemetryStatus } from '@duel/shared';
import type { CSSProperties } from 'react';
import { api } from '../api';
import { formatMsValue } from '../format';
import { useNow } from '../useNow';
import type { Row } from './RunMetrics';
import { TelemetryChips } from './TelemetryChips';

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  starting: 'Starting',
  queued: 'Waiting its turn',
  streaming: 'Generating',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface Props {
  machine: { name: string; color: string };
  /** What the machine has in memory before the race, for the waiting pane. */
  modelName: string | null;
  sessionId: string | null;
  run: RunView | null;
  /** The size asked for, so the empty box has the image's shape. */
  size: { width: number; height: number };
  telemetry?: {
    enabled: boolean | null;
    status: TelemetryStatus | undefined;
    sample: TelemetrySample | undefined;
  };
}

export function ImagePane({ machine, modelName, sessionId, run, size, telemetry }: Props) {
  const now = useNow(100);
  const image = run?.image ?? null;
  const running = run !== null && run.finishedAt === null;
  const phase = !run ? 'idle' : run.state;
  const steps = run?.live?.steps ?? null;
  const elapsed = image
    ? image.totalMs
    : running && run.requestedAtMs !== null && run.state === 'streaming'
      ? now - run.requestedAtMs
      : null;
  const decoding = running && steps !== null && steps.total > 0 && steps.done >= steps.total;
  const src = image?.stored && sessionId && run ? api.sessionImageUrl(sessionId, run.id) : null;

  return (
    <article
      className="card run-pane"
      data-testid="run-pane"
      data-machine={machine.name}
      data-state={phase}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-label={`${machine.name} image`}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 className="machine-name">{machine.name}</h2>
          <p className="machine-notes">
            {image?.engine
              ? [
                  image.engine,
                  image.device,
                  image.dtype,
                  image.speedMode && `speed ${image.speedMode}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : (run?.modelBefore ?? modelName ?? 'No image model loaded')}
          </p>
        </div>
        <span className={`state state-run-${phase}`} data-testid="run-state" role="status">
          {STATE_LABEL[phase] ?? phase}
        </span>
      </header>

      {telemetry ? (
        <TelemetryChips
          enabled={telemetry.enabled}
          status={telemetry.status}
          sample={telemetry.sample}
        />
      ) : null}

      <div className="big-stats">
        <div className="big-stat">
          <span className="hero-label">Speed</span>
          <span className="big-number" data-testid="steps-per-sec">
            {image?.stepsPerSec ? image.stepsPerSec.toFixed(2) : running ? '…' : 'n/a'}
          </span>
          <span className="big-caption">denoising steps/sec</span>
        </div>
        <div className="big-stat">
          <span className="hero-label">Time per image</span>
          <span className="big-number" data-testid="image-time">
            {image ? (image.totalMs / 1000).toFixed(1) : running ? '…' : 'n/a'}
          </span>
          <span className="big-caption">
            seconds · first step{' '}
            {image?.firstStepMs !== null && image?.firstStepMs !== undefined
              ? formatMsValue(image.firstStepMs)
              : 'n/a'}
          </span>
        </div>
      </div>

      {running && run.live?.load ? (
        <div className="step-progress" data-testid="load-progress">
          {run.live.load.fraction !== null && run.live.load.phase === 'downloading' ? (
            <progress value={run.live.load.fraction} max={1} aria-label={`${machine.name} load`} />
          ) : null}
          <span className="field-hint">
            {run.live.load.phase === 'downloading'
              ? `Loading the model: fetching files${run.live.load.fraction !== null ? `, ${Math.round(run.live.load.fraction * 100)}%` : ''}`
              : run.live.load.phase === 'finalizing'
                ? 'Loading the model into memory…'
                : 'Loading the model…'}
          </span>
        </div>
      ) : null}
      {running && steps && steps.total > 0 ? (
        <div className="step-progress" data-testid="step-progress">
          <progress value={steps.done} max={steps.total} aria-label={`${machine.name} steps`} />
          <span className="field-hint">
            {decoding ? 'Decoding and saving the image…' : `Step ${steps.done} of ${steps.total}`}
          </span>
        </div>
      ) : null}

      <div
        className="image-box"
        style={{ aspectRatio: `${image?.width ?? size.width} / ${image?.height ?? size.height}` }}
        data-testid="image-box"
      >
        {src ? (
          <img src={src} alt={`What ${machine.name} made from the prompt`} data-testid="image" />
        ) : (
          <span className="muted-inline">
            {!run
              ? 'The image appears here.'
              : running
                ? run.state === 'queued'
                  ? 'Waiting for its turn…'
                  : 'Generating…'
                : run.state === 'cancelled'
                  ? 'Cancelled before the image was done.'
                  : run.state === 'failed'
                    ? 'No image: the run failed.'
                    : image && !image.stored
                      ? 'The image was made but could not be copied here.'
                      : 'No image.'}
          </span>
        )}
      </div>

      {run?.error ? (
        <p className="issue issue-error" role="alert" data-testid="run-error">
          <span className="issue-title">The run failed.</span>{' '}
          <span className="issue-hint">{run.error}</span>
        </p>
      ) : null}

      <div className="total-row">
        <span className="hero-label">Total</span>
        <span className={`total-value${running ? ' ticking' : ''}`} data-testid="elapsed">
          {elapsed === null ? (running ? '0.0s' : 'n/a') : `${(elapsed / 1000).toFixed(1)}s`}
        </span>
      </div>
      {image ? (
        <p className="run-footnote">
          Seed {image.seed ?? 'n/a'} · decode and save {formatMsValue(image.decodeTailMs)}
          {image.loadMs !== null ? ` · model loaded first in ${formatMsValue(image.loadMs)}` : ''}
          {image.totalSteps > image.steps ? ' · made in parts: memory ran short' : ''}
        </p>
      ) : null}
    </article>
  );
}

/** Every number of one image run. */
export function ImageMetrics({ run }: { run: RunView }) {
  const image = run.image;
  if (!image) return null;
  const e = run.telemetry?.energy ?? null;
  const value = (v: number | null | undefined, unit: string, digits = 1) =>
    v === null || v === undefined ? 'n/a' : `${v.toFixed(digits)} ${unit}`;
  const rows: Row[] = [
    ['Time per image', formatMsValue(image.totalMs), 'n/a'],
    [
      'Model load before the round',
      image.loadMs === null ? 'already loaded' : formatMsValue(image.loadMs),
      'n/a',
    ],
    ['Time to first step', formatMsValue(image.firstStepMs), 'n/a'],
    ['Last step reached', formatMsValue(image.lastStepMs), 'n/a'],
    ['Denoising speed', value(image.stepsPerSec, 'steps/s', 2), 'n/a'],
    ['Decode and save after the last step', formatMsValue(image.decodeTailMs), 'n/a'],
    [
      'Steps',
      `${image.steps}${image.totalSteps > image.steps ? `, ${image.totalSteps} counting the parts` : ''}`,
      'n/a',
    ],
    [
      'Progress readings',
      `${image.timeline.length}, about ${formatMsValue(image.resolutionMs)} apart`,
      'n/a',
    ],
    ['Size', image.width && image.height ? `${image.width}×${image.height}` : 'n/a', 'n/a'],
    ['Seed', 'n/a', image.seed === null ? 'n/a' : String(image.seed)],
    [
      'Engine, device and precision',
      'n/a',
      [image.engine, image.device, image.dtype].filter(Boolean).join(' · ') || 'n/a',
    ],
    ['Speed mode that ran', 'n/a', image.speedMode ?? 'n/a'],
  ];
  if (e) {
    rows.push(
      ['Energy for the image, approx.', value(e.energyJ, 'J'), 'n/a'],
      ['Mean power while denoising, approx.', value(e.meanDecodePowerW, 'W'), 'n/a'],
      ['Peak GPU', value(e.peakGpuPct, '%', 0), 'n/a'],
      ['Peak power', value(e.peakPowerW, 'W'), 'n/a'],
      ['Peak GPU memory or RAM', value(e.peakVramGb ?? e.peakRamGb, 'GB'), 'n/a'],
      [
        'Telemetry samples',
        `${e.samples} in the run, ${Math.round(e.coverage * 100)}% covered`,
        'n/a',
      ],
    );
  }
  return (
    <section className="panel metrics" aria-labelledby="metrics-title" data-testid="run-metrics">
      <h2 id="metrics-title" className="section-title">
        Measurements
      </h2>
      <div className="table-scroll">
        <table className="metrics-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Measured by Model Duel</th>
              <th scope="col">Reported by Unsloth</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, measured, reported]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td data-column="measured">{measured}</td>
                <td data-column="reported">{reported}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="metrics-notes">
        <li>
          Unsloth reports no timing for images, so every time here is Model Duel&apos;s: step times
          come from reading its progress about ten times a second, so they are good to about one
          reading apart.
        </li>
      </ul>
    </section>
  );
}
