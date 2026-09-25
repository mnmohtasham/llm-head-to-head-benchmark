import type { RunView, TelemetrySample, TelemetryStatus } from '@duel/shared';
import type { CSSProperties } from 'react';
import { formatMsValue } from '../format';
import { useNow } from '../useNow';
import type { Row } from './RunMetrics';
import { TelemetryChips } from './TelemetryChips';

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  starting: 'Starting',
  queued: 'Waiting its turn',
  streaming: 'Encoding',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const megabytes = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined
    ? 'n/a'
    : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 2 : 1)} MB`;

interface Props {
  machine: { name: string; color: string };
  /** What the agent would run, before the race. */
  encoder: string | null;
  run: RunView | null;
  telemetry?: {
    enabled: boolean | null;
    status: TelemetryStatus | undefined;
    sample: TelemetrySample | undefined;
  };
}

export function CommandPane({ machine, encoder, run, telemetry }: Props) {
  const now = useNow(100);
  const c = run?.command ?? null;
  const running = run !== null && run.finishedAt === null;
  const phase = !run ? 'idle' : run.state;
  const frames = run?.live?.frames ?? null;
  const elapsed =
    c?.wallMs ?? (running && run.requestedAtMs !== null ? now - run.requestedAtMs : null);
  const liveFps =
    running && frames && elapsed && elapsed > 0 ? frames.done / (elapsed / 1000) : null;

  return (
    <article
      className="card run-pane"
      data-testid="run-pane"
      data-machine={machine.name}
      data-state={phase}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-label={`${machine.name} encode`}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 className="machine-name">{machine.name}</h2>
          <p className="machine-notes">{c?.encoder ?? run?.modelBefore ?? encoder ?? 'No agent'}</p>
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
          <span className="hero-label">Frames per second</span>
          <span className="big-number" data-testid="encode-fps">
            {c?.fps ? c.fps.toFixed(0) : liveFps ? liveFps.toFixed(0) : running ? '…' : 'n/a'}
          </span>
          <span className="big-caption">{c ? 'over the whole encode' : 'so far'}</span>
        </div>
        <div className="big-stat">
          <span className="hero-label">Speed</span>
          <span className="big-number" data-testid="encode-speed">
            {c?.speed ? `${c.speed.toFixed(1)}×` : running ? '…' : 'n/a'}
          </span>
          <span className="big-caption">real time</span>
        </div>
      </div>

      {running && frames ? (
        <div className="step-progress" data-testid="frame-progress">
          <progress
            value={frames.done}
            max={frames.total ?? undefined}
            aria-label={`${machine.name} frames`}
          />
          <span className="field-hint">
            Frame {frames.done}
            {frames.total ? ` of ${frames.total}` : ''}
          </span>
        </div>
      ) : null}

      {run?.error ? (
        <p className="issue issue-error" role="alert" data-testid="run-error">
          <span className="issue-title">The run failed.</span>{' '}
          <span className="issue-hint">{run.error}</span>
        </p>
      ) : null}

      <div className="total-row">
        <span className="hero-label">Encode time</span>
        <span className={`total-value${running ? ' ticking' : ''}`} data-testid="elapsed">
          {elapsed === null ? (running ? '0.0s' : 'n/a') : `${(elapsed / 1000).toFixed(1)}s`}
        </span>
      </div>
      {c ? (
        <p className="run-footnote">
          {c.frames ?? 'n/a'} frames · output {megabytes(c.outputBytes)}
          {c.agentTelemetry?.peakEncoderPct != null
            ? ` · encoder up to ${Math.round(c.agentTelemetry.peakEncoderPct)}%`
            : ''}
        </p>
      ) : null}
    </article>
  );
}

/** Every number of one encode, and the exact command the agent ran. */
export function CommandMetrics({ run }: { run: RunView }) {
  const c = run.command;
  if (!c) return null;
  const e = run.telemetry?.energy ?? null;
  const t = c.agentTelemetry;
  const watts = (v: number | null | undefined) =>
    v === null || v === undefined ? 'n/a' : `${v.toFixed(1)} W`;
  const rows: Row[] = [
    ['Encode time', formatMsValue(c.wallMs), 'n/a'],
    ['Time as Model Duel saw it', formatMsValue(c.controllerMs), 'n/a'],
    ['Frames', c.frames === null ? 'n/a' : String(c.frames), 'n/a'],
    ['Frames per second', c.fps === null ? 'n/a' : c.fps.toFixed(1), 'n/a'],
    ['Speed', c.speed === null ? 'n/a' : `${c.speed.toFixed(2)}× real time`, 'n/a'],
    ['First progress with a frame', formatMsValue(c.firstFrameMs), 'n/a'],
    ['Output size', megabytes(c.outputBytes), 'n/a'],
    ['Exit code', c.exitCode === null ? 'none' : String(c.exitCode), 'n/a'],
  ];
  if (t) {
    rows.push(
      ['CPU power, agent, mean', watts(t.meanCpuPowerW), 'n/a'],
      ['GPU power, agent, mean', watts(t.meanGpuPowerW), 'n/a'],
      ['Neural Engine power, agent, mean', watts(t.meanAnePowerW), 'n/a'],
      [
        'Video encoder use, peak',
        t.peakEncoderPct === null ? 'n/a' : `${Math.round(t.peakEncoderPct)}%`,
        'n/a',
      ],
    );
  }
  if (e) {
    rows.push(
      ['Energy, approx.', e.energyJ === null ? 'n/a' : `${e.energyJ.toFixed(1)} J`, 'n/a'],
      ['Peak GPU', e.peakGpuPct === null ? 'n/a' : `${Math.round(e.peakGpuPct)}%`, 'n/a'],
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
              <th scope="col">Measured</th>
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
      <p className="field-hint">The command the agent ran:</p>
      <pre className="preset-text" data-testid="command-argv">
        {c.argv.join(' ')}
      </pre>
      {c.stderrTail ? (
        <details>
          <summary className="field-hint">ffmpeg&apos;s last messages</summary>
          <pre className="preset-text">{c.stderrTail}</pre>
        </details>
      ) : null}
    </section>
  );
}
