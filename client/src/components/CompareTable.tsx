import { compareRuns, type MetricUnit, type SessionView } from '@duel/shared';
import type { CSSProperties } from 'react';
import { formatMsValue, formatRate } from '../format';

function formatValue(value: number | string | null, unit: MetricUnit): string {
  if (value === null) return 'n/a';
  if (typeof value === 'string') return value;
  if (unit === 'ms') return formatMsValue(value);
  if (unit === 'tokens') return value.toLocaleString('en-US');
  return formatRate(value, unit);
}

/** Metric rows by machine columns. The best value of the finished machines is marked. */
export function CompareTable({ session }: { session: SessionView }) {
  const round = session.rounds[0];
  const runs = round?.runs ?? [];
  const rows = compareRuns(runs);
  return (
    <section className="panel compare" aria-labelledby="compare-title" data-testid="compare">
      <h2 id="compare-title" className="section-title">
        Comparison
      </h2>
      <div className="table-scroll">
        <table className="metrics-table compare-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {session.machines.map((machine, i) => (
                <th
                  scope="col"
                  key={machine.id}
                  className="compare-machine"
                  style={{ '--machine': machine.color } as CSSProperties}
                >
                  {machine.name}
                  {runs[i] && runs[i].state !== 'done' ? (
                    <span className="compare-state"> {runs[i].state}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-key={row.key}>
                <th scope="row">
                  {row.label}
                  {row.better ? (
                    <span className="better-hint">
                      {row.better === 'lower' ? 'lower is better' : 'higher is better'}
                    </span>
                  ) : null}
                </th>
                {row.values.map((value, i) => (
                  <td
                    key={session.machines[i]?.id ?? i}
                    data-machine={session.machines[i]?.name}
                    data-best={row.best[i] ? 'true' : undefined}
                    className={row.best[i] ? 'best' : undefined}
                  >
                    {formatValue(value, row.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="metrics-notes">
        <li>
          The best value among the machines that finished is marked. Failed runs keep their numbers
          but do not count.
        </li>
        {round?.sendSkewMs !== null && round?.sendSkewMs !== undefined ? (
          <li data-testid="send-skew">
            The requests left Model Duel within {formatMsValue(round.sendSkewMs)} of each other.
          </li>
        ) : null}
        {session.loopLagMs && session.loopLagMs.max > 50 ? (
          <li className="note-warn">
            The controller&apos;s event loop was late by up to{' '}
            {formatMsValue(session.loopLagMs.max)}, enough to blur the timings. Close other work on
            this computer and run again.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
