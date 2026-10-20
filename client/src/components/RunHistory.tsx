import {
  DEFAULT_HISTORY_FILTER,
  formatValue,
  raceDay,
  resultsLink,
  runHistory,
  shortDate,
  statisticWord,
  type DeviceRun,
  type HistoryFilter,
  type HistoryMark,
  type HistorySeries,
  type HistorySource,
  type Statistic,
} from '@duel/shared';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import uPlot from 'uplot';
import { AXIS, Chart } from './Chart';
import { CopyLink } from './CopyLink';

const WARN = '#e5c15b';
const PANEL = '#18191c';
const SOURCE_WORDS: Record<HistorySource, string> = {
  server: 'the server’s own number',
  measured: 'measured by Model Duel',
};
/** Room for one date under the chart. */
const DATE_WIDTH = 92;

const raceHref = (run: DeviceRun) => `#/${run.workload}/${run.sessionId}`;

/**
 * One headline number over the races, one point per run, evenly spaced in race order: a filled
 * dot where the server reported the number, a hollow one where Model Duel measured it, and a
 * dashed, numbered line before each run that came with a change. Hovering shows a point's value
 * and date, and clicking it opens its race; the table under the charts has the same links.
 */
function HistoryChart({
  series,
  runs,
  marks,
  color,
  label,
}: {
  series: HistorySeries;
  runs: readonly DeviceRun[];
  marks: readonly HistoryMark[];
  color: string;
  label: string;
}) {
  const { options, data } = useMemo(() => {
    const n = runs.length;
    // The day of each race, and its time under it when one day had several.
    const days = runs.map((run) => raceDay(run.createdAt));
    const timed = new Set(days).size < days.length;
    const day = (i: number) => {
      const run = runs[i];
      return run
        ? timed
          ? shortDate(run.createdAt).replace(' ', '\n')
          : raceDay(run.createdAt)
        : '';
    };
    let tip: HTMLDivElement | null = null;
    const options: Omit<uPlot.Options, 'width'> = {
      height: 200,
      series: [
        {},
        { label: series.label, stroke: color, width: 2, spanGaps: true, points: { show: false } },
        {
          label: SOURCE_WORDS.server,
          stroke: color,
          paths: () => null,
          points: { show: true, size: 9, width: 2, stroke: color, fill: color },
        },
        {
          label: SOURCE_WORDS.measured,
          stroke: color,
          paths: () => null,
          points: { show: true, size: 9, width: 2, stroke: color, fill: PANEL },
        },
      ],
      scales: {
        x: { time: false, range: [-0.5, Math.max(0, n - 1) + 0.5] },
        // From zero, so a small wobble does not look like a collapse.
        y: { range: (_u, _min, max) => [0, Number.isFinite(max) && max > 0 ? max * 1.15 : 1] },
      },
      axes: [
        {
          ...AXIS,
          splits: (u) => {
            const room = Math.max(1, Math.floor(u.bbox.width / uPlot.pxRatio / DATE_WIDTH));
            const step = Math.max(1, Math.ceil(n / room));
            return runs.map((_, i) => i).filter((i) => i % step === 0);
          },
          values: (_u, splits) => splits.map(day),
          size: timed ? 54 : 40,
          label: 'race date',
          labelSize: 18,
        },
        { ...AXIS, label: series.unit, labelSize: 18, size: 56 },
      ],
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      hooks: {
        ready: [
          (u) => {
            tip = document.createElement('div');
            tip.className = 'chart-tip';
            tip.hidden = true;
            u.over.appendChild(tip);
            u.over.addEventListener('click', () => {
              const run =
                u.cursor.idx === null || u.cursor.idx === undefined ? null : runs[u.cursor.idx];
              if (run) window.location.hash = raceHref(run);
            });
            u.over.addEventListener('mouseleave', () => {
              if (tip) tip.hidden = true;
            });
          },
        ],
        setCursor: [
          (u) => {
            if (!tip) return;
            const i = u.cursor.idx;
            const run = i === null || i === undefined ? undefined : runs[i];
            const point = i === null || i === undefined ? undefined : series.points[i];
            if (i === null || i === undefined || !run || !point) {
              tip.hidden = true;
              return;
            }
            tip.textContent = `${shortDate(run.createdAt)}: ${
              point.value === null ? 'no number' : formatValue(point.value, series.unit)
            }${point.source ? `, ${SOURCE_WORDS[point.source]}` : ''}`;
            // Kept inside the chart: to one side near its edges, below a point near its top.
            const left = u.valToPos(i, 'x');
            const top = point.value === null ? 24 : u.valToPos(point.value, 'y');
            const width = u.bbox.width / uPlot.pxRatio;
            tip.dataset.side = left < 90 ? 'left' : left > width - 90 ? 'right' : 'middle';
            tip.dataset.below = top < 40 ? 'true' : 'false';
            tip.style.left = `${left}px`;
            tip.style.top = `${top}px`;
            tip.hidden = false;
          },
        ],
        draw: [
          (u) => {
            if (marks.length === 0) return;
            const ctx = u.ctx;
            const px = uPlot.pxRatio;
            const { top, height } = u.bbox;
            ctx.save();
            ctx.strokeStyle = WARN;
            ctx.fillStyle = WARN;
            ctx.lineWidth = px;
            ctx.setLineDash([4 * px, 3 * px]);
            ctx.font = `700 ${11 * px}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (const mark of marks) {
              const x = Math.round(u.valToPos(mark.index - 0.5, 'x', true));
              ctx.beginPath();
              ctx.moveTo(x, top + 14 * px);
              ctx.lineTo(x, top + height);
              ctx.stroke();
              ctx.fillText(String(mark.number), x, top);
            }
            ctx.restore();
          },
        ],
      },
    };
    const data: uPlot.AlignedData = [
      runs.map((_, i) => i),
      series.points.map((p) => p.value),
      series.points.map((p) => (p.source === 'server' ? p.value : null)),
      series.points.map((p) => (p.source === 'measured' ? p.value : null)),
    ];
    return { options, data };
  }, [series, runs, marks, color]);
  return (
    <div className="history-chart">
      <Chart options={options} data={data} label={label} testId={`history-chart-${series.key}`} />
    </div>
  );
}

/** "Same prompt (Short)": a toggle that narrows the history to what this run was asked. */
function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </label>
  );
}

/**
 * The history of the machine that ran `anchor`, with the same model, quant and engine: its
 * headline numbers over the races, what changed between them, and the latest against the best.
 */
export function RunHistory({
  anchor,
  runs,
  statistic,
  onClose,
}: {
  anchor: DeviceRun;
  runs: readonly DeviceRun[];
  statistic: Statistic;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>(DEFAULT_HISTORY_FILTER);
  const history = useMemo(
    () => runHistory(runs, anchor, filter, statistic),
    [runs, anchor, filter, statistic],
  );
  const heading = useRef<HTMLHeadingElement>(null);
  // Opening a history takes the reader to it.
  useEffect(() => {
    heading.current?.focus();
  }, [anchor.key]);

  const chat = anchor.kind === 'text' || anchor.kind === 'throughput';
  const set = (change: Partial<HistoryFilter>) =>
    setFilter((current) => ({ ...current, ...change }));
  const list = history.runs;
  const first = list[0];
  const last = list[list.length - 1];
  const marksAt = new Map(history.marks.map((mark) => [mark.index, mark]));
  const anchorIn = list.some((run) => run.key === anchor.key);
  const what = [
    anchor.model ?? 'unknown model',
    anchor.quant,
    anchor.engine && `on ${anchor.engine}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      className="panel run-history"
      aria-labelledby="run-history-title"
      data-testid="run-history"
      style={{ '--machine': anchor.color } as CSSProperties}
    >
      <div className="compare-head">
        <h2 id="run-history-title" className="section-title" tabIndex={-1} ref={heading}>
          History · <span className="compare-machine">{anchor.machine}</span>
        </h2>
        <div className="panel-actions">
          <CopyLink href={resultsLink({ history: anchor.key })} what="history" />
          <button type="button" className="btn btn-quiet btn-small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <p className="history-what">
        {what}.{' '}
        {first && last
          ? list.length === 1
            ? `One run, on ${raceDay(first.createdAt)}.`
            : `${list.length} runs from ${raceDay(first.createdAt)} to ${raceDay(last.createdAt)}.`
          : ''}{' '}
        {`${statisticWord(statistic, true).replace(/^./, (c) => c.toUpperCase())} of each run’s counted rounds.`}
      </p>
      <div className="results-actions" role="group" aria-label="Which runs count">
        <Toggle checked={filter.samePrompt} onChange={(on) => set({ samePrompt: on })}>
          {chat
            ? `Same prompt (${anchor.prompt ?? 'none'})`
            : `Same settings (${anchor.settings ?? 'none'})`}
        </Toggle>
        {chat ? (
          <Toggle checked={filter.sameThinking} onChange={(on) => set({ sameThinking: on })}>
            Same thinking ({anchor.thinking ?? 'not known'})
          </Toggle>
        ) : null}
        {anchor.kind === 'throughput' ? (
          <Toggle checked={filter.sameConcurrency} onChange={(on) => set({ sameConcurrency: on })}>
            Same requests at once ({anchor.concurrency ?? 'not known'})
          </Toggle>
        ) : null}
      </div>
      {!anchorIn ? (
        <p className="muted">This run did not finish, so it has no point of its own.</p>
      ) : null}

      {list.length === 0 ? (
        <p className="muted" data-testid="history-empty">
          No finished run of this machine with this model matches. Untick a box above to take in
          more.
        </p>
      ) : (
        <>
          {history.series.map((series) => (
            <div className="history-series" key={series.key} data-testid={`history-${series.key}`}>
              <h3 className="history-title">
                {series.label}
                {series.better ? (
                  <span className="better-hint">
                    {series.better === 'lower' ? 'lower is better' : 'higher is better'}
                  </span>
                ) : null}
              </h3>
              <p className="history-summary" data-testid="history-summary">
                {series.summary?.text ??
                  (list.length === 1
                    ? 'One run so far, so nothing to compare it with yet.'
                    : 'Fewer than two runs have this number, so nothing to compare yet.')}
              </p>
              {series.points.some((p) => p.value !== null) ? (
                <HistoryChart
                  series={series}
                  runs={list}
                  marks={history.marks}
                  color={anchor.color}
                  label={`${series.label} of ${anchor.machine} over ${list.length} ${list.length === 1 ? 'race' : 'races'}${history.marks.length > 0 ? `, with ${history.marks.length} ${history.marks.length === 1 ? 'change' : 'changes'} marked` : ''}. The table below lists every value.`}
                />
              ) : (
                <p className="muted">No run here has this number.</p>
              )}
            </div>
          ))}
          <p className="field-hint">
            One point per run, in race order. A filled dot is the server’s own number, a hollow one
            Model Duel’s measurement where the run has none from its server. A dashed, numbered line
            comes before a run with a change, listed below. Click a point to open its race.
          </p>

          <h3 className="history-title">What changed</h3>
          {history.marks.length === 0 ? (
            <p className="muted" data-testid="history-no-changes">
              Nothing in the setup changed between these runs.
            </p>
          ) : (
            <ol className="history-changes" data-testid="history-changes">
              {history.marks.map((mark) => {
                const run = list[mark.index];
                return (
                  <li key={mark.index} data-testid="history-change">
                    <span className="history-mark">
                      <span className="sr-only">Change </span>
                      {mark.number}
                    </span>
                    <div>
                      <ul className="history-change-list">
                        {mark.changes.map((change) => (
                          <li key={change.field}>{change.text}</li>
                        ))}
                      </ul>
                      <p className="history-effects">
                        {mark.effects.length > 0
                          ? `${mark.effects.map((effect) => effect.text).join('. ')}. `
                          : null}
                        {run ? <a href={raceHref(run)}>Open that race</a> : null}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <details className="history-runs" open={list.length <= 12}>
            <summary>Every run ({list.length})</summary>
            <div className="table-scroll history-scroll" tabIndex={0} aria-label="Every run">
              <table className="metrics-table history-table" data-testid="history-table">
                <thead>
                  <tr>
                    <th scope="col">Race</th>
                    {history.series.map((series) => (
                      <th scope="col" key={series.key} className="num">
                        {series.label}
                      </th>
                    ))}
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {list
                    .map((run, index) => ({ run, index }))
                    .reverse()
                    .map(({ run, index }) => (
                      <tr key={run.key} data-testid="history-row" data-session={run.sessionId}>
                        <th scope="row">
                          <a href={raceHref(run)}>{shortDate(run.createdAt)}</a>
                          {run.key === anchor.key ? (
                            <span className="cell-detail">this run</span>
                          ) : null}
                        </th>
                        {history.series.map((series) => {
                          const point = series.points[index];
                          return (
                            <td key={series.key} className="num">
                              {point?.value === null || point === undefined
                                ? 'n/a'
                                : formatValue(point.value, series.unit)}
                              {point?.source ? (
                                <span className="cell-detail">
                                  {point.source === 'server' ? 'server' : 'Model Duel'}
                                </span>
                              ) : null}
                            </td>
                          );
                        })}
                        <td>{marksAt.get(index)?.number ?? ''}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
