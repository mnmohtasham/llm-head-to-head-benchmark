import type { RunView, TelemetrySample, TelemetryStatus, WerResult } from '@duel/shared';
import { useState, type CSSProperties } from 'react';
import { formatMsValue } from '../format';
import { useNow } from '../useNow';
import type { Row } from './RunMetrics';
import { TelemetryChips } from './TelemetryChips';

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  starting: 'Starting',
  queued: 'Waiting its turn',
  streaming: 'Transcribing',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const percent = (wer: WerResult | null | undefined) =>
  wer ? `${(wer.wer * 100).toFixed(wer.wer < 0.1 ? 1 : 0)}%` : 'n/a';

/** The transcript word by word against what was said: wrong, extra and missed words marked. */
function Differences({ wer }: { wer: WerResult }) {
  return (
    <p className="transcript-diff" data-testid="transcript-diff">
      {wer.alignment.map((step, i) => {
        const space = i > 0 ? ' ' : '';
        if (step.op === 'ok') return `${space}${step.hyp ?? ''}`;
        if (step.op === 'del') {
          return (
            <span key={i}>
              {space}
              <del className="wer-del" title="Said, but missing from the transcript">
                {step.ref}
              </del>
            </span>
          );
        }
        return (
          <span key={i}>
            {space}
            <mark
              className={step.op === 'sub' ? 'wer-sub' : 'wer-ins'}
              title={step.op === 'sub' ? `Said: ${step.ref ?? ''}` : 'Not said'}
            >
              {step.hyp}
            </mark>
          </span>
        );
      })}
    </p>
  );
}

interface Props {
  machine: { name: string; color: string };
  /** What the machine has in memory before the race, for the waiting pane. */
  modelName: string | null;
  run: RunView | null;
  telemetry?: {
    enabled: boolean | null;
    status: TelemetryStatus | undefined;
    sample: TelemetrySample | undefined;
  };
}

export function TranscriptPane({ machine, modelName, run, telemetry }: Props) {
  const now = useNow(100);
  const [raw, setRaw] = useState(false);
  const t = run?.transcription ?? null;
  const running = run !== null && run.finishedAt === null;
  const phase = !run ? 'idle' : run.state;
  const elapsed =
    run?.live?.elapsedMs && !running
      ? run.live.elapsedMs
      : running && run.requestedAtMs !== null && run.state === 'streaming'
        ? now - run.requestedAtMs
        : null;
  const wer = t?.wer ?? null;

  return (
    <article
      className="card run-pane"
      data-testid="run-pane"
      data-machine={machine.name}
      data-state={phase}
      style={{ '--machine': machine.color } as CSSProperties}
      aria-label={`${machine.name} transcription`}
    >
      <header className="card-head">
        <div className="card-title">
          <h2 className="machine-name">{machine.name}</h2>
          <p className="machine-notes">
            {t?.engine
              ? `${run?.modelBefore ?? ''} · ${t.engine}${t.device ? ` on ${t.device}` : ''}`
              : (run?.modelBefore ?? modelName ?? 'No speech model loaded')}
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
          <span className="hero-label">Real-time factor</span>
          <span className="big-number" data-testid="rtf">
            {t?.rtf ? `${t.rtf.toFixed(t.rtf < 10 ? 1 : 0)}×` : running ? '…' : 'n/a'}
          </span>
          <span className="big-caption">
            {t?.processingMs !== null && t?.processingMs !== undefined
              ? `processing ${formatMsValue(t.processingMs)}`
              : 'audio seconds per second'}
          </span>
        </div>
        <div className="big-stat">
          <span className="hero-label">Word error rate</span>
          <span className="big-number" data-testid="wer">
            {wer ? percent(wer) : running ? '…' : 'n/a'}
          </span>
          <span className="big-caption">
            {wer
              ? `${wer.substitutions + wer.deletions + wer.insertions} of ${wer.referenceWords} words`
              : t
                ? 'no reference text'
                : 'lower is better'}
          </span>
        </div>
      </div>

      <div className="run-text transcript" data-testid="answer">
        {wer && !raw ? (
          <Differences wer={wer} />
        ) : run?.answer ? (
          run.answer
        ) : (
          <span className="muted-inline" data-testid="answer-empty">
            {!run
              ? 'The transcript appears here.'
              : running
                ? run.state === 'queued'
                  ? 'Waiting for its turn…'
                  : 'Uploading and transcribing… The transcript arrives in one piece.'
                : run.state === 'cancelled'
                  ? 'Cancelled before the transcript arrived.'
                  : run.state === 'failed'
                    ? 'No transcript: the run failed.'
                    : 'The model heard nothing.'}
          </span>
        )}
      </div>
      {wer ? (
        <p className="run-footnote">
          <button
            type="button"
            className="btn btn-quiet btn-inline"
            onClick={() => setRaw((on) => !on)}
          >
            {raw ? 'Show the differences' : 'Show the text as returned'}
          </button>
          {raw ? null : (
            <>
              {' '}
              · <mark className="wer-sub">wrong</mark> <mark className="wer-ins">extra</mark>{' '}
              <del className="wer-del">missed</del>
            </>
          )}
        </p>
      ) : null}

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
      {t ? (
        <p className="run-footnote">
          Upload {formatMsValue(t.uploadMs)} · {t.audioSeconds?.toFixed(1) ?? 'n/a'} s of audio
          {t.loadMs !== null ? ` · model loaded first in ${formatMsValue(t.loadMs)}` : ''}
        </p>
      ) : null}
    </article>
  );
}

/** Every number of one transcription, measured and as Unsloth reported it. */
export function TranscriptMetrics({ run }: { run: RunView }) {
  const t = run.transcription;
  if (!t) return null;
  const e = run.telemetry?.energy ?? null;
  const value = (v: number | null | undefined, unit: string, digits = 1) =>
    v === null || v === undefined ? 'n/a' : `${v.toFixed(digits)} ${unit}`;
  const minutes = t.audioSeconds ? t.audioSeconds / 60 : null;
  const rows: Row[] = [
    ['Audio length', value(t.audioSeconds, 's', 2), 'n/a'],
    ['File size', `${(t.bytes / 1_000_000).toFixed(2)} MB`, 'n/a'],
    ['Upload time', formatMsValue(t.uploadMs), 'n/a'],
    ['Processing time', formatMsValue(t.processingMs), formatMsValue(t.serverProcessingMs)],
    ['Real-time factor', value(t.rtf, '×'), value(t.serverRtf, '×')],
    [
      'Model load before the round',
      t.loadMs === null ? 'already loaded' : formatMsValue(t.loadMs),
      'n/a',
    ],
    [
      'Word error rate',
      t.wer
        ? `${percent(t.wer)}: ${t.wer.substitutions} wrong, ${t.wer.deletions} missed, ${t.wer.insertions} extra of ${t.wer.referenceWords}`
        : 'no reference text',
      'n/a',
    ],
    ['Engine and device', 'n/a', [t.engine, t.device].filter(Boolean).join(' on ') || 'n/a'],
    ['Language', 'n/a', t.language ?? 'n/a'],
    ['Total time', formatMsValue(run.live?.elapsedMs), 'n/a'],
  ];
  if (e) {
    rows.push(
      ['Energy, approx.', value(e.energyJ, 'J'), 'n/a'],
      [
        'Energy per audio minute, approx.',
        e.energyJ !== null && minutes ? value(e.energyJ / minutes, 'J') : 'n/a',
        'n/a',
      ],
      ['Mean power while processing, approx.', value(e.meanDecodePowerW, 'W'), 'n/a'],
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
  const lag = run.loopLagMs;
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
          Processing runs from the last byte of the file sent to the first byte of the answer.
          Unsloth&apos;s own time starts once the upload is in, so the two differ by the network.
        </li>
        {lag && lag.max > 50 ? (
          <li className="note-warn">
            The controller&apos;s event loop was late by up to {formatMsValue(lag.max)} during the
            run, enough to blur the timings.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
