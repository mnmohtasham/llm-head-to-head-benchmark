import {
  GATE_RATIO,
  runsOf,
  sessionStats,
  type MetricUnit,
  type SessionView,
  type StatRow,
  type Summary,
} from '@duel/shared';
import type { CSSProperties } from 'react';
import { formatMsValue, formatRate } from '../format';

export function formatValue(value: number | null, unit: MetricUnit): string {
  if (value === null) return 'n/a';
  if (unit === 'ms') return formatMsValue(value);
  if (unit === 'tokens') return Math.round(value).toLocaleString('en-US');
  return formatRate(value, unit);
}

function spread(summary: Summary, unit: MetricUnit): string | null {
  if (summary.n < 2 || summary.min === null || summary.max === null) return null;
  const sd = summary.stdev === null ? '' : ` · sd ${formatValue(summary.stdev, unit)}`;
  return `${formatValue(summary.min, unit)} to ${formatValue(summary.max, unit)}${sd}`;
}

function textValues(session: SessionView, machineId: string, key: string): string {
  const values = runsOf(session, machineId).map((run) =>
    key === 'finish' ? (run.client?.finishReason ?? run.state) : run.state,
  );
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => (count > 1 ? `${value} ×${count}` : value))
    .join(', ');
}

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

function verdictText(row: StatRow, session: SessionView): string {
  const { verdict } = row;
  if (verdict.kind === 'none') return '';
  const leader = session.machines[verdict.leader ?? -1]?.name ?? '';
  if (verdict.kind === 'tie') return 'Tie';
  const ratio =
    verdict.ratio === null || !Number.isFinite(verdict.ratio)
      ? ''
      : `, ${verdict.ratio.toFixed(2)}×`;
  return `${leader}${ratio}`;
}

/**
 * Metric rows by machine columns, as medians over the counted rounds. A winner is named only
 * when the gate says the difference is bigger than the noise; otherwise the row says tie.
 */
export function StatsTable({ session }: { session: SessionView }) {
  const rows = sessionStats(session);
  const counted = session.rounds.length;
  const skews = session.rounds
    .map((round) => round.sendSkewMs)
    .filter((v): v is number => v !== null);
  const multi = session.machines.length > 1;
  return (
    <section className="panel compare" aria-labelledby="compare-title" data-testid="compare">
      <h2 id="compare-title" className="section-title">
        {counted > 1 ? `Comparison · medians of ${counted} rounds` : 'Comparison'}
      </h2>
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
            {rows.map((row) => (
              <tr key={row.key} data-key={row.key} data-verdict={row.verdict.kind}>
                <th scope="row">
                  {row.label}
                  {row.better ? (
                    <span className="better-hint">
                      {row.better === 'lower' ? 'lower is better' : 'higher is better'}
                    </span>
                  ) : null}
                </th>
                {row.summaries.map((summary, i) => {
                  const machine = session.machines[i];
                  const winner = row.verdict.kind === 'win' && row.verdict.leader === i;
                  const detail = spread(summary, row.unit);
                  return (
                    <td
                      key={machine?.id ?? i}
                      data-machine={machine?.name}
                      data-best={winner ? 'true' : undefined}
                      className={winner ? 'best' : undefined}
                    >
                      {row.unit === 'text'
                        ? textValues(session, machine?.id ?? '', row.key)
                        : formatValue(summary.median, row.unit)}
                      {detail ? <span className="cell-detail">{detail}</span> : null}
                    </td>
                  );
                })}
                {multi ? (
                  <td className={`verdict verdict-${row.verdict.kind}`} data-testid="verdict">
                    {verdictText(row, session)}
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
            A machine wins a row only when its median is more than{' '}
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
