import {
  comboLabel,
  suiteColumns,
  suiteCsv,
  suiteLabel,
  suiteRows,
  type Suite,
  type SuiteRace,
  type SuiteState,
} from '@duel/shared';
import type { CSSProperties } from 'react';

export const SUITE_STATE_LABEL: Record<SuiteState, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function downloadCsv(suite: Suite) {
  const blob = new Blob([suiteCsv(suite)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `model-duel-suite-${suite.createdAt.slice(0, 10)}-${suite.id.slice(0, 8)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Where a suite is, or how it ended. */
function progressText(suite: Suite): string {
  const total = suite.races.length;
  const current = suite.races.find((race) => race.state === 'running');
  if (suite.state === 'running') {
    if (current) return `Race ${current.index + 1} of ${total}: ${comboLabel(current.combo)}.`;
    const next = suite.races.find((race) => race.state === 'queued');
    return next ? `Starting race ${next.index + 1} of ${total}.` : 'Finishing.';
  }
  const done = suite.races.filter((race) => race.state === 'done').length;
  return `${done} of ${plural(total, 'race', 'races')} done.`;
}

/** Why a race did not count, with what pre-flight found. */
function RaceProblem({ race }: { race: SuiteRace }) {
  const issues = race.issues.filter((issue) => issue.text !== race.error);
  return (
    <li className={race.state === 'skipped' ? 'note-warn' : 'field-error'}>
      Race {race.index + 1}, {comboLabel(race.combo)}: {race.state}. {race.error}
      {issues.length > 0 ? (
        <ul className="suite-issues">
          {issues.map((issue) => (
            <li key={`${issue.code}:${issue.text}`}>{issue.text}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** One suite: where it is, its summary table, why races were skipped or failed, and the CSV. */
export function SuiteReport({ suite }: { suite: Suite }) {
  const columns = suiteColumns(suite);
  const rows = suiteRows(suite);
  const current = suite.races.find((race) => race.state === 'running');
  const problems = suite.races.filter(
    (race) => (race.state === 'skipped' || race.state === 'failed') && race.error,
  );
  const s = suite.settings;
  return (
    <section
      className="panel suite-report"
      aria-labelledby="suite-title"
      data-testid="suite-report"
    >
      <div className="suite-head">
        <h2 id="suite-title" className="section-title">
          Suite from {when(suite.createdAt)}
        </h2>
        <span className={`session-state session-${suite.state}`}>
          {SUITE_STATE_LABEL[suite.state]}
        </span>
      </div>
      <p className="muted">
        {suiteLabel(s)}, on {suite.machines.map((m) => m.name).join(', ')}.{' '}
        {plural(s.plan.rounds, 'round', 'rounds')} per race,{' '}
        {s.plan.statistic === 'mean' ? 'averages' : 'medians'}, {s.prefill} prefill
        {s.acknowledgeWarnings ? ', pre-flight warnings accepted' : ''}.
      </p>
      <p
        className="race-progress"
        role={suite.state === 'running' ? 'status' : undefined}
        data-testid="suite-progress"
      >
        {progressText(suite)}{' '}
        {current?.sessionId ? (
          <a href={`#/text/${current.sessionId}`}>Watch it on the Text tab</a>
        ) : null}
      </p>
      {suite.state === 'interrupted' || suite.state === 'failed' ? (
        <div className="banner banner-warn" role="status">
          {suite.error}
        </div>
      ) : null}
      <div
        className="table-scroll suite-scroll"
        tabIndex={0}
        role="region"
        aria-label="Suite summary"
      >
        <table className="metrics-table suite-table" data-testid="suite-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={column.numeric ? 'num' : undefined}
                  title={
                    column.source
                      ? 'The machines’ servers’ own number where every machine in the race reported it, otherwise Model Duel’s measurement'
                      : undefined
                  }
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                data-testid="suite-row"
                data-machine={row.machine.name}
                data-race={row.race.index}
                className={
                  row.result && row.result.state !== 'failed' && row.result.state !== 'cancelled'
                    ? undefined
                    : 'row-muted'
                }
                title={row.result?.error ?? row.race.error ?? undefined}
                style={{ '--machine': row.machine.color } as CSSProperties}
              >
                {columns.map((column) => {
                  if (column.id === 'machine') {
                    return (
                      <th key={column.id} scope="row" className="suite-machine">
                        {row.machine.name}
                      </th>
                    );
                  }
                  const source = column.source?.(row) ?? null;
                  return (
                    <td
                      key={column.id}
                      data-column={column.id}
                      className={column.numeric ? 'num' : undefined}
                    >
                      {column.id === 'race' && row.race.sessionId ? (
                        <a
                          href={`#/text/${row.race.sessionId}`}
                          aria-label={`Open race ${row.race.index + 1}, ${comboLabel(row.race.combo)}`}
                        >
                          Open
                        </a>
                      ) : (
                        column.text(row)
                      )}
                      {source ? <span className="cell-detail">{source}</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        Each number is the race’s {s.plan.statistic === 'mean' ? 'average' : 'median'} over its
        counted rounds, as on its scoreboard.
        {s.mode === 'latency'
          ? ' Time to first token and decode speed are the machines’ servers’ own numbers (“server”) where every machine in that race reported them, otherwise Model Duel’s measurement for all of them (“Model Duel”).'
          : ''}
      </p>
      {problems.length > 0 ? (
        <ul className="start-check" data-testid="suite-problems">
          {problems.map((race) => (
            <RaceProblem key={race.index} race={race} />
          ))}
        </ul>
      ) : null}
      <div className="report-actions">
        <button type="button" className="btn btn-outline" onClick={() => downloadCsv(suite)}>
          Download CSV
        </button>
      </div>
    </section>
  );
}
