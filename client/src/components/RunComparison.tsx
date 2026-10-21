import {
  cannotCompare,
  compareRuns,
  likeForLikeNote,
  resultsLink,
  shortDate,
  statisticWord,
  type DeviceRun,
  type Statistic,
} from '@duel/shared';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { CopyLink } from './CopyLink';

/** What every run was asked, for the line that says the comparison is like for like. */
function sameRequest(kind: DeviceRun['kind']): string {
  if (kind === 'throughput')
    return 'the same prompt, thinking, Max tokens, prefill and requests at once';
  if (kind === 'text') return 'the same prompt, thinking, Max tokens and prefill';
  return 'the same settings';
}

/**
 * Runs from the Results table side by side, one column each, against the first: what each one
 * ran with, with what differs from the first marked, and every measurement with the best starred
 * and each run's ratio to the first.
 */
export function RunComparison({
  runs,
  missing,
  statistic,
  onBaseline,
  onHistory,
  onClose,
}: {
  runs: readonly DeviceRun[];
  /** Runs the link names that no longer exist. */
  missing: number;
  statistic: Statistic;
  onBaseline: (key: string) => void;
  onHistory: (key: string) => void;
  onClose: () => void;
}) {
  const problem = cannotCompare(runs);
  const comparison = useMemo(
    () => (problem === null ? compareRuns(runs, statistic) : null),
    [problem, runs, statistic],
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const keys = runs.map((run) => run.key).join(',');
  // Opening a comparison, or changing its baseline, takes the reader to it.
  useEffect(() => {
    heading.current?.focus();
  }, [keys]);
  const note = comparison ? likeForLikeNote(comparison.requestDiffers) : null;
  const span = runs.length + 1;
  const summed = `${statisticWord(statistic, true).replace(/^./, (c) => c.toUpperCase())} of each run’s counted rounds`;

  return (
    <section
      className="panel run-comparison"
      aria-labelledby="run-comparison-title"
      data-testid="run-comparison"
    >
      <div className="compare-head">
        <h2 id="run-comparison-title" className="section-title" tabIndex={-1} ref={heading}>
          Comparing {runs.length} {runs.length === 1 ? 'run' : 'runs'}
        </h2>
        <div className="panel-actions">
          {runs.length > 0 ? (
            <CopyLink
              href={resultsLink({ compare: runs.map((run) => run.key) })}
              what="comparison"
            />
          ) : null}
          <button type="button" className="btn btn-quiet btn-small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {missing > 0 ? (
        <p className="banner banner-warn" data-testid="compare-missing">
          {missing === 1
            ? 'One run in this link no longer exists, so it is left out.'
            : `${missing} runs in this link no longer exist, so they are left out.`}
        </p>
      ) : null}
      {problem ? (
        <p className="muted" data-testid="compare-problem">
          {problem}
        </p>
      ) : null}
      {comparison ? (
        <>
          {note ? (
            <p className="banner banner-warn" data-testid="not-like-for-like">
              {note}
            </p>
          ) : (
            <p className="field-hint" data-testid="like-for-like">
              Like for like: every run answered {sameRequest(comparison.kind)}.
            </p>
          )}
          <div className="table-scroll" tabIndex={0} aria-label="Comparison table">
            <table className="metrics-table run-compare-table" data-testid="run-compare-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  {runs.map((run, i) => (
                    <th
                      scope="col"
                      key={run.key}
                      className="run-compare-head"
                      style={{ '--machine': run.color } as CSSProperties}
                      data-key={run.key}
                    >
                      <span className="compare-machine">{run.machine}</span>
                      <a className="run-compare-date" href={`#/${run.workload}/${run.sessionId}`}>
                        {shortDate(run.createdAt)}
                      </a>
                      <span className="run-compare-actions">
                        {i === 0 ? (
                          <span className="run-compare-baseline">baseline</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-quiet btn-small"
                            onClick={() => onBaseline(run.key)}
                            aria-label={`Compare against ${run.machine} from ${shortDate(run.createdAt)}`}
                          >
                            Make baseline
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-quiet btn-small"
                          onClick={() => onHistory(run.key)}
                          aria-label={`History of ${run.machine} with ${run.model ?? 'this model'}`}
                        >
                          History
                        </button>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="run-compare-group">
                  <th scope="rowgroup" colSpan={span}>
                    Setup
                  </th>
                </tr>
                {comparison.setup.map((row) => (
                  <tr
                    key={row.id}
                    data-key={row.id}
                    className={row.differs ? 'differs' : undefined}
                  >
                    <th scope="row">
                      {row.label}
                      {row.differs ? <span className="better-hint">differs</span> : null}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td
                        key={runs[i]?.key ?? i}
                        data-differs={cell.differs ? 'true' : undefined}
                        className={cell.differs ? 'cell-differs' : undefined}
                      >
                        {cell.text}
                        {cell.differs ? (
                          <>
                            <span className="differs-mark" aria-hidden="true">
                              {' '}
                              ≠
                            </span>
                            <span className="sr-only">, differs from the first run</span>
                          </>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tbody>
                <tr className="run-compare-group">
                  <th scope="rowgroup" colSpan={span}>
                    {summed}
                  </th>
                </tr>
                {comparison.metrics.map((row) => (
                  <tr key={row.key} data-key={row.key}>
                    <th scope="row">
                      {row.label}
                      {row.better ? (
                        <span className="better-hint">
                          {row.better === 'lower' ? 'lower is better' : 'higher is better'}
                        </span>
                      ) : null}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td
                        key={runs[i]?.key ?? i}
                        data-best={cell.best ? 'true' : undefined}
                        className={cell.best ? 'best' : undefined}
                      >
                        {cell.text}
                        {cell.best ? (
                          <>
                            <span className="best-mark" aria-hidden="true">
                              {' '}
                              ★
                            </span>
                            <span className="sr-only">, best</span>
                          </>
                        ) : null}
                        {cell.versus ? (
                          <span className="cell-detail" data-testid="versus">
                            {cell.versus}
                          </span>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field-hint">
            ≠ marks a setting that differs from the first run’s, and ★ the best value of a
            measurement. Under each value is how the run compares with the first, the baseline;
            measurements without a better direction, such as total time, have none. Measurements
            none of these runs has are left out.
          </p>
        </>
      ) : null}
    </section>
  );
}
