import {
  comparisonTable,
  GATE_RATIO,
  runsOf,
  statisticOf,
  statisticWord,
  type SessionView,
  type Statistic,
} from '@duel/shared';
import { useState, type CSSProperties } from 'react';
import { api, messageOf } from '../api';
import { formatMsValue } from '../format';

/** "failed 1 of 3" next to a machine that did not finish every round. */
function failures(session: SessionView, machineId: string) {
  const runs = runsOf(session, machineId);
  const failed = runs.filter((run) => run.state !== 'done').length;
  if (failed === 0) return null;
  return (
    <span className="compare-state">
      {' '}
      failed {failed} of {runs.length}
    </span>
  );
}

/**
 * Metric rows by machine columns, as medians or averages over the counted rounds, from the same
 * table model the CSV and Markdown exports use. A winner is named only when the gate says so.
 */
export function StatsTable({
  session,
  onChange,
}: {
  session: SessionView;
  /** Takes the race back after its statistic changed. */
  onChange?: (session: SessionView) => void;
}) {
  const table = comparisonTable(session);
  const statistic = statisticOf(session.plan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchTo = async (next: Statistic) => {
    if (next === statistic || !onChange) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.setStatistic(session.id, next));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  const skews = session.rounds
    .map((round) => round.sendSkewMs)
    .filter((v): v is number => v !== null);
  const multi = session.machines.length > 1;
  return (
    <section className="panel compare" aria-labelledby="compare-title" data-testid="compare">
      <div className="compare-head">
        <h2 id="compare-title" className="section-title">
          {table.title}
        </h2>
        {session.rounds.length > 1 && onChange ? (
          <div
            className="toggle-chips"
            role="radiogroup"
            aria-label="Sum up rounds by"
            data-testid="statistic-switch"
          >
            {(
              [
                ['median', 'Median'],
                ['mean', 'Average'],
              ] as const
            ).map(([option, label]) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={statistic === option}
                className={`toggle-chip${statistic === option ? ' toggle-chip-on' : ''}`}
                onClick={() => void switchTo(option)}
                disabled={busy}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="metrics-table compare-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {session.machines.map((machine) => (
                <th
                  scope="col"
                  key={machine.id}
                  className="compare-machine"
                  style={{ '--machine': machine.color } as CSSProperties}
                >
                  {machine.name}
                  {failures(session, machine.id)}
                </th>
              ))}
              {multi ? <th scope="col">Result</th> : null}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.key} data-key={row.key} data-verdict={row.verdict}>
                <th scope="row">
                  {row.label}
                  {row.hint ? <span className="better-hint">{row.hint}</span> : null}
                </th>
                {row.cells.slice(0, session.machines.length).map((cell, i) => (
                  <td
                    key={session.machines[i]?.id ?? i}
                    data-machine={session.machines[i]?.name}
                    data-best={cell.best ? 'true' : undefined}
                    className={cell.best ? 'best' : undefined}
                  >
                    {cell.text}
                    {cell.best ? <span className="best-mark"> ★</span> : null}
                    {cell.detail ? <span className="cell-detail">{cell.detail}</span> : null}
                  </td>
                ))}
                {multi ? (
                  <td className={`verdict verdict-${row.verdict ?? 'none'}`} data-testid="verdict">
                    {row.cells[session.machines.length]?.text}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="metrics-notes">
        {multi ? (
          <li>
            A machine wins a row only when its {statisticWord(statistic)} is more than{' '}
            {Math.round((GATE_RATIO - 1) * 100)} percent better, or when its round-to-round range
            does not overlap the runner-up&apos;s. Otherwise the row is a tie. Failed rounds do not
            count, and the warm-up never does.
          </li>
        ) : null}
        {skews.length > 0 ? (
          <li data-testid="send-skew">
            The requests left Model Duel within {formatMsValue(Math.max(...skews))} of each other in
            every round.
          </li>
        ) : null}
        {session.plan.sequencing === 'sequential' ? (
          <li>The machines took turns, in ABBA order, so none of them always went first.</li>
        ) : null}
      </ul>
    </section>
  );
}
