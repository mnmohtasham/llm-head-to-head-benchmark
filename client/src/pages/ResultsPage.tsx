import {
  cannotCompare,
  KIND_LABELS,
  parseResultsLink,
  resultsLink,
  runColumns,
  runsCsv,
  shortDate,
  type DeviceRun,
  type MetricKind,
  type ResultsLink,
  type RunColumn,
  type RunsView,
  type Statistic,
} from '@duel/shared';
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, messageOf, type SentShare, type ShareSettingsView } from '../api';
import { RunComparison } from '../components/RunComparison';
import { RunHistory } from '../components/RunHistory';
import { ShareDialog, ShareSettingsDialog } from '../components/ShareDialogs';
import { TopBar } from '../components/TopBar';

const KINDS: readonly MetricKind[] = ['text', 'throughput', 'transcribe', 'image'];
const SHOWN_STATES = new Set(['done', 'partial']);
/** Filters shown up front; the others wait under More filters. */
const MAIN_FILTERS = new Set([
  'machine',
  'kind',
  'gpu',
  'model',
  'quant',
  'engine',
  'context',
  'kvCache',
  'slots',
  'prompt',
  'thinking',
  'settings',
]);
const columnsKey = (view: RunsView) => `model-duel:results-columns:${view}`;
const STATISTIC_KEY = 'model-duel:results-statistic';

function savedStatistic(): Statistic {
  try {
    return localStorage.getItem(STATISTIC_KEY) === 'mean' ? 'mean' : 'median';
  } catch {
    return 'median';
  }
}

/** The columns this viewer picked for a view, kept in this browser only. */
function savedColumns(view: RunsView): string[] | null {
  try {
    const raw = localStorage.getItem(columnsKey(view));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function saveColumns(view: RunsView, ids: string[] | null) {
  try {
    if (ids) localStorage.setItem(columnsKey(view), JSON.stringify(ids));
    else localStorage.removeItem(columnsKey(view));
  } catch {
    // Private windows may refuse storage; the choice then lasts until reload.
  }
}

type Sort = { id: string; dir: 'asc' | 'desc' };

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

/** Every term must appear somewhere in the row. */
function matches(run: DeviceRun, columns: readonly RunColumn[], terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    ...columns.map((c) => c.text(run)),
    run.promptText ?? '',
    run.model ?? '',
    run.gpu ?? '',
    run.error ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The comparison and history the address asks for. Going through it keeps Back working. */
function useResultsLink(): ResultsLink {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return useMemo(() => parseResultsLink(hash), [hash]);
}

/**
 * Opens or closes a comparison or a history, keeping the other. Asked again for what is already
 * open, it brings the panel with the heading `focus` into view instead.
 */
function follow(change: Partial<ResultsLink>, focus?: string) {
  const next = resultsLink({ ...parseResultsLink(window.location.hash), ...change });
  if (next === window.location.hash) {
    if (focus) document.getElementById(focus)?.focus();
  } else window.location.hash = next;
}

const openHistory = (key: string) => follow({ history: key }, 'run-history-title');

export function ResultsPage() {
  const [runs, setRuns] = useState<DeviceRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosenView, setView] = useState<RunsView | null>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [unfinished, setUnfinished] = useState(false);
  const [sort, setSort] = useState<Sort>({ id: 'date', dir: 'desc' });
  const [picked, setPicked] = useState<Partial<Record<RunsView, string[] | null>>>({});
  const [statistic, setStatisticState] = useState<Statistic>(savedStatistic);
  const [share, setShare] = useState<ShareSettingsView | null>(null);
  const [sharing, setSharing] = useState<DeviceRun | null>(null);
  const [shareSettingsOpen, setShareSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const link = useResultsLink();
  const setStatistic = (next: Statistic) => {
    setStatisticState(next);
    try {
      localStorage.setItem(STATISTIC_KEY, next);
    } catch {
      // Kept until reload.
    }
  };

  useEffect(() => {
    let cancelled = false;
    api.shareSettings().then(
      (view) => {
        if (!cancelled) setShare(view);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.runs().then(
      ({ runs: list }) => {
        if (!cancelled) setRuns(list);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(messageOf(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    const byKind = new Map<MetricKind, number>();
    for (const run of runs ?? []) {
      if (!unfinished && !SHOWN_STATES.has(run.state)) continue;
      byKind.set(run.kind, (byKind.get(run.kind) ?? 0) + 1);
    }
    return byKind;
  }, [runs, unfinished]);
  const present = KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0);
  // Text first when there is any, since its columns carry the most.
  const fallback: RunsView =
    (present.includes('text') ? 'text' : present.length === 1 ? present[0] : 'all') ?? 'all';
  // A kind left with no rows, after unticking failed runs, gives way to the default.
  const view: RunsView =
    chosenView !== null &&
    (chosenView === 'all' ? present.length > 1 : present.includes(chosenView))
      ? chosenView
      : fallback;

  const allColumns = useMemo(() => runColumns(view, statistic), [view, statistic]);
  const chosenIds = useMemo(
    () => (picked[view] !== undefined ? picked[view] : savedColumns(view)),
    [picked, view],
  );
  const visible = useMemo(
    () =>
      allColumns.filter((c) =>
        c.id === 'machine' ? true : chosenIds ? chosenIds.includes(c.id) : c.initial,
      ),
    [allColumns, chosenIds],
  );

  const base = useMemo(
    () =>
      (runs ?? []).filter(
        (run) =>
          (view === 'all' || run.kind === view) && (unfinished || SHOWN_STATES.has(run.state)),
      ),
    [runs, view, unfinished],
  );
  const terms = useMemo(() => search.toLowerCase().split(/\s+/).filter(Boolean), [search]);
  const active = useMemo(
    () =>
      Object.entries(filters).filter(
        ([id, value]) => value !== '' && allColumns.some((c) => c.id === id),
      ),
    [filters, allColumns],
  );

  // Memoized, so ticking a run for a comparison does not filter and sort hundreds of rows again.
  const { rows, sorted, facets } = useMemo(() => {
    const pass = (run: DeviceRun, except: string | null) =>
      active.every(([id, value]) => {
        if (id === except) return true;
        const column = allColumns.find((c) => c.id === id);
        return !column || column.text(run) === value;
      }) && matches(run, visible, terms);

    const rows = base.filter((run) => pass(run, null));
    const sortColumn = allColumns.find((c) => c.id === sort.id) ?? allColumns[1];
    const sorted = [...rows].sort((a, b) => {
      const order = compare(sortColumn?.value(a) ?? null, sortColumn?.value(b) ?? null);
      // Rows without a value stay last in both directions.
      const aNull = sortColumn?.value(a) === null;
      const bNull = sortColumn?.value(b) === null;
      if (aNull !== bNull) return aNull ? 1 : -1;
      return sort.dir === 'asc' ? order : -order;
    });

    // Filters for the columns whose values differ, each listing what the other filters leave.
    const facets = allColumns
      .filter((c) => c.filter)
      .map((column) => {
        const all = new Set(base.map((run) => column.text(run)));
        const options = new Map<string, number>();
        for (const run of base) {
          if (!pass(run, column.id)) continue;
          const text = column.text(run);
          options.set(text, (options.get(text) ?? 0) + 1);
        }
        return { column, differs: all.size > 1, options };
      })
      .filter((facet) => facet.differs || filters[facet.column.id]);
    return { rows, sorted, facets };
  }, [active, allColumns, visible, terms, base, sort, filters]);
  const mainFacets = facets.filter((facet) => MAIN_FILTERS.has(facet.column.id));
  const moreFacets = facets.filter((facet) => !MAIN_FILTERS.has(facet.column.id));
  const moreActive = moreFacets.filter((facet) => filters[facet.column.id]).length;

  // The best value of each metric among the rows shown.
  const best = useMemo(() => {
    const found = new Map<string, number>();
    for (const column of visible) {
      if (!column.better) continue;
      const values = rows
        .map((run) => column.value(run))
        .filter((v): v is number => typeof v === 'number');
      if (values.length < 2) continue;
      found.set(column.id, column.better === 'lower' ? Math.min(...values) : Math.max(...values));
    }
    return found;
  }, [visible, rows]);

  // Runs ticked for a comparison, in the order they were ticked: the first is the baseline.
  const byKey = useMemo(() => new Map((runs ?? []).map((run) => [run.key, run])), [runs]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedRuns = useMemo(
    () => selected.map((key) => byKey.get(key)).filter((run): run is DeviceRun => !!run),
    [selected, byKey],
  );
  const selectionProblem = cannotCompare(selectedRuns);
  const toggleRun = useCallback(
    (key: string, on: boolean) =>
      setSelected((current) => [...current.filter((k) => k !== key), ...(on ? [key] : [])]),
    [],
  );
  const openSend = useCallback((run: DeviceRun) => setSharing(run), []);

  // What the address asks to compare, by value, so opening a history keeps the selection.
  const linkedKeys = link.compare.join('\n');
  const compareKeys = useMemo(() => (linkedKeys ? linkedKeys.split('\n') : []), [linkedKeys]);
  const compared = useMemo(
    () => compareKeys.map((key) => byKey.get(key)).filter((run): run is DeviceRun => !!run),
    [compareKeys, byKey],
  );
  // A comparison opened from a link ticks its runs, so the selection can grow from there.
  useEffect(() => {
    if (runs === null || compareKeys.length === 0) return;
    setSelected(compareKeys.filter((key) => byKey.has(key)));
  }, [compareKeys, byKey, runs]);
  const historyRun = link.history ? (byKey.get(link.history) ?? null) : null;

  const setColumns = (ids: string[] | null) => {
    setPicked((current) => ({ ...current, [view]: ids }));
    saveColumns(view, ids);
  };
  const toggleColumn = (id: string) => {
    const current = visible.map((c) => c.id);
    setColumns(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };
  const clearFilters = () => {
    setFilters({});
    setSearch('');
  };
  const sortBy = (column: RunColumn) =>
    setSort((current) =>
      current.id === column.id
        ? { id: column.id, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { id: column.id, dir: column.numeric && column.better !== 'lower' ? 'desc' : 'asc' },
    );

  const download = () => {
    const blob = new Blob([runsCsv(sorted, visible, statistic)], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `model-duel-results-${view}-${statistic === 'mean' ? 'averages' : 'medians'}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const groups = ['Race', 'Machine', 'Model', 'Settings', 'Result'] as const;
  const filtering = active.length > 0 || terms.length > 0;

  return (
    <>
      <TopBar
        title="Results"
        current="results"
        actions={
          <>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setShareSettingsOpen(true)}
              disabled={share === null}
            >
              Results service
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={download}
              disabled={sorted.length === 0}
            >
              Download CSV
            </button>
          </>
        }
      />
      <main className="main">
        <p className="subbar">
          One row per machine per finished race, with the median or average of its counted rounds.
          Filter to compare GPUs, models and settings across races; the best value of each
          measurement among the rows shown is marked. The date opens the race. Tick 2 to 6 runs to
          compare them side by side, or press History to follow a machine over its races.
        </p>
        {loadError ? (
          <div className="banner banner-error" role="alert">
            {loadError}
          </div>
        ) : null}
        {runs === null && !loadError ? <p className="loading">Loading results…</p> : null}
        {runs !== null && runs.length === 0 ? (
          <section className="empty">
            <h2 className="section-title">No finished races yet</h2>
            <p className="muted">
              Race your machines on the <a href="#/text">Text</a> tab, or any other workload. Every
              race shows up here when it ends.
            </p>
          </section>
        ) : null}

        {runs !== null && compareKeys.length > 0 ? (
          <RunComparison
            runs={compared}
            missing={compareKeys.length - compared.length}
            statistic={statistic}
            onBaseline={(key) =>
              follow({ compare: [key, ...compareKeys.filter((k) => k !== key)] })
            }
            onHistory={openHistory}
            onClose={() => follow({ compare: [] })}
          />
        ) : null}
        {runs !== null && link.history ? (
          historyRun ? (
            <RunHistory
              key={historyRun.key}
              anchor={historyRun}
              runs={runs}
              statistic={statistic}
              onClose={() => follow({ history: null })}
            />
          ) : (
            <section className="panel run-history" data-testid="run-history">
              <div className="compare-head">
                <h2 className="section-title">History</h2>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() => follow({ history: null })}
                >
                  Close
                </button>
              </div>
              <p className="muted">The run in this link no longer exists.</p>
            </section>
          )
        ) : null}

        {runs !== null && runs.length > 0 ? (
          <>
            <section className="panel results-filters" aria-label="Filters">
              <div className="field">
                <span className="field-label" id="results-view-label">
                  Workload
                </span>
                <div
                  className="toggle-chips"
                  role="radiogroup"
                  aria-labelledby="results-view-label"
                >
                  {[...present, ...(present.length > 1 ? (['all'] as const) : [])].map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={view === option}
                      className={`toggle-chip${view === option ? ' toggle-chip-on' : ''}`}
                      onClick={() => {
                        setView(option);
                        setSort({ id: 'date', dir: 'desc' });
                      }}
                    >
                      {option === 'all' ? 'All' : KIND_LABELS[option]}{' '}
                      <span className="chip-count">
                        {option === 'all'
                          ? [...counts.values()].reduce((a, b) => a + b, 0)
                          : (counts.get(option) ?? 0)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label" id="results-statistic-label">
                  Rounds summed up by
                </span>
                <div
                  className="toggle-chips"
                  role="radiogroup"
                  aria-labelledby="results-statistic-label"
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
                      onClick={() => setStatistic(option)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="results-search">Search</label>
                <input
                  id="results-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Machine, GPU, model, quant, prompt…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {mainFacets.length > 0 ? (
                <div className="results-facets">
                  {mainFacets.map((facet) => (
                    <Facet
                      key={facet.column.id}
                      facet={facet}
                      value={filters[facet.column.id] ?? ''}
                      onChange={(value) =>
                        setFilters((current) => ({ ...current, [facet.column.id]: value }))
                      }
                    />
                  ))}
                </div>
              ) : null}
              {moreFacets.length > 0 ? (
                <details className="results-columns" open={moreActive > 0}>
                  <summary>More filters{moreActive > 0 ? ` (${moreActive} set)` : ''}</summary>
                  <div className="results-facets results-more">
                    {moreFacets.map((facet) => (
                      <Facet
                        key={facet.column.id}
                        facet={facet}
                        value={filters[facet.column.id] ?? ''}
                        onChange={(value) =>
                          setFilters((current) => ({ ...current, [facet.column.id]: value }))
                        }
                      />
                    ))}
                  </div>
                </details>
              ) : null}
              <div className="results-actions">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={unfinished}
                    onChange={(event) => setUnfinished(event.target.checked)}
                  />
                  Include failed and cancelled runs
                </label>
                {filtering ? (
                  <button type="button" className="btn btn-quiet btn-small" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : null}
              </div>
              <details className="results-columns">
                <summary>Columns</summary>
                <div className="results-column-groups">
                  {groups.map((group) => {
                    const inGroup = allColumns.filter(
                      (c) => c.group === group && c.id !== 'machine',
                    );
                    if (inGroup.length === 0) return null;
                    return (
                      <fieldset key={group} className="results-column-group">
                        <legend>{group}</legend>
                        {inGroup.map((column) => (
                          <label key={column.id} className="check">
                            <input
                              type="checkbox"
                              checked={visible.some((c) => c.id === column.id)}
                              onChange={() => toggleColumn(column.id)}
                            />
                            {column.label}
                          </label>
                        ))}
                      </fieldset>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() => setColumns(null)}
                >
                  Reset columns
                </button>
              </details>
            </section>

            <p className="results-count" role="status" data-testid="results-count">
              {sorted.length === base.length
                ? `${sorted.length} ${sorted.length === 1 ? 'run' : 'runs'}`
                : `${sorted.length} of ${base.length} runs`}
            </p>

            {selected.length > 0 ? (
              <div
                className="selection-bar"
                role="region"
                aria-label="Runs to compare"
                data-testid="selection-bar"
              >
                <span className="selection-count" role="status">
                  {selected.length} {selected.length === 1 ? 'run' : 'runs'} selected
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={() => follow({ compare: selected }, 'run-comparison-title')}
                  disabled={selectionProblem !== null}
                  aria-describedby={selectionProblem ? 'selection-problem' : undefined}
                >
                  Compare
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() => setSelected([])}
                >
                  Clear
                </button>
                {selectionProblem ? (
                  <span id="selection-problem" className="field-hint">
                    {selectionProblem}
                  </span>
                ) : null}
              </div>
            ) : null}

            {sorted.length === 0 ? (
              filtering ? (
                <p className="muted">
                  No runs match these filters.{' '}
                  <button type="button" className="btn btn-quiet btn-inline" onClick={clearFilters}>
                    Clear filters
                  </button>
                </p>
              ) : !unfinished ? (
                <p className="muted">
                  Every run here failed or was cancelled, so none is shown.{' '}
                  <button
                    type="button"
                    className="btn btn-quiet btn-inline"
                    onClick={() => setUnfinished(true)}
                  >
                    Show them
                  </button>
                </p>
              ) : (
                <p className="muted">No runs of this kind yet.</p>
              )
            ) : (
              <div className="table-scroll results-scroll" tabIndex={0} aria-label="Results table">
                <table className="metrics-table results-table" data-testid="results-table">
                  <thead>
                    <tr>
                      {visible.map((column) => (
                        <th
                          key={column.id}
                          scope="col"
                          aria-sort={
                            sort.id === column.id
                              ? sort.dir === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : undefined
                          }
                          className={column.numeric ? 'num' : undefined}
                          data-column={column.id}
                        >
                          <button
                            type="button"
                            className="sort-button"
                            onClick={() => sortBy(column)}
                            title={column.hint}
                          >
                            {column.label}
                            {sort.id === column.id ? (
                              <span aria-hidden="true">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>
                            ) : null}
                          </button>
                          {column.better ? (
                            <span className="better-hint">
                              {column.better === 'lower' ? 'lower is better' : 'higher is better'}
                            </span>
                          ) : null}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((run) => (
                      <ResultRow
                        key={run.key}
                        run={run}
                        columns={visible}
                        best={best}
                        selected={selectedSet.has(run.key)}
                        canSend={share !== null}
                        sent={share?.sent[run.key]}
                        onSelect={toggleRun}
                        onHistory={openHistory}
                        onSend={openSend}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </main>
      {sharing && share ? (
        <ShareDialog
          key={sharing.key}
          run={sharing}
          settings={share}
          onSent={(key, sent) =>
            setShare((current) =>
              current ? { ...current, sent: { ...current.sent, [key]: sent } } : current,
            )
          }
          onSettings={() => {
            setSharing(null);
            setShareSettingsOpen(true);
          }}
          onClose={() => setSharing(null)}
        />
      ) : null}
      {shareSettingsOpen && share ? (
        <ShareSettingsDialog
          settings={share}
          onSaved={setShare}
          onClose={() => setShareSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * One run's row. Memoized, so ticking a run for a comparison draws that row again, not every row.
 */
const ResultRow = memo(function ResultRow({
  run,
  columns,
  best,
  selected,
  canSend,
  sent,
  onSelect,
  onHistory,
  onSend,
}: {
  run: DeviceRun;
  columns: readonly RunColumn[];
  best: ReadonlyMap<string, number>;
  selected: boolean;
  canSend: boolean;
  sent: SentShare | undefined;
  onSelect: (key: string, on: boolean) => void;
  onHistory: (key: string) => void;
  onSend: (run: DeviceRun) => void;
}) {
  const date = shortDate(run.createdAt);
  return (
    <tr
      data-testid="results-row"
      data-machine={run.machine}
      data-session={run.sessionId}
      className={
        [SHOWN_STATES.has(run.state) ? '' : 'row-muted', selected ? 'row-selected' : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      title={run.error ?? undefined}
      style={{ '--machine': run.color } as CSSProperties}
    >
      {columns.map((column) => {
        const value = column.value(run);
        const isBest =
          best.has(column.id) && typeof value === 'number' && best.get(column.id) === value;
        if (column.id === 'machine') {
          return (
            <th key={column.id} scope="row" className="results-machine">
              <input
                type="checkbox"
                className="row-select"
                checked={selected}
                onChange={(event) => onSelect(run.key, event.target.checked)}
                aria-label={`Select the run of ${run.machine} from ${date} to compare`}
                data-testid="row-select"
              />
              {SHOWN_STATES.has(run.state) && canSend ? (
                <button
                  type="button"
                  className={`btn btn-outline btn-small row-send${sent ? ' row-sent' : ''}`}
                  onClick={() => onSend(run)}
                  aria-label={`${sent ? 'Send again' : 'Send'} the run of ${run.machine} from ${date}`}
                  title={
                    sent
                      ? `Sent to ${sent.host} on ${new Date(sent.at).toLocaleString()}`
                      : 'Send this run to the results service'
                  }
                  data-testid="row-send"
                >
                  {sent ? 'Sent ✓' : 'Send'}
                </button>
              ) : null}
              {run.machine}
              <button
                type="button"
                className="btn btn-quiet btn-small row-history"
                onClick={() => onHistory(run.key)}
                aria-label={`History of ${run.machine} with ${run.model ?? 'this model'}${run.quant ? ` ${run.quant}` : ''}`}
                title="This machine’s runs of this model over time"
                data-testid="row-history"
              >
                History
              </button>
            </th>
          );
        }
        return (
          <td
            key={column.id}
            data-column={column.id}
            className={
              [column.numeric ? 'num' : '', isBest ? 'best' : ''].filter(Boolean).join(' ') ||
              undefined
            }
          >
            {column.id === 'date' ? (
              <a href={`#/${run.workload}/${run.sessionId}`}>{column.text(run)}</a>
            ) : (
              column.text(run)
            )}
            {isBest ? (
              <span className="best-mark" aria-label=", best shown">
                {' '}
                ★
              </span>
            ) : null}
          </td>
        );
      })}
    </tr>
  );
});

/** One filter: the values the other filters leave, with how many rows have each. */
function Facet({
  facet,
  value,
  onChange,
}: {
  facet: { column: RunColumn; options: Map<string, number> };
  value: string;
  onChange: (value: string) => void;
}) {
  const { column, options } = facet;
  return (
    <div className="field">
      <label htmlFor={`filter-${column.id}`}>{column.label}</label>
      <select
        id={`filter-${column.id}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Any</option>
        {[...options.entries()]
          .sort(([a], [b]) => compare(a, b))
          .map(([option, n]) => (
            <option key={option} value={option}>
              {option} ({n})
            </option>
          ))}
        {value && !options.has(value) ? <option value={value}>{value} (0)</option> : null}
      </select>
    </div>
  );
}
