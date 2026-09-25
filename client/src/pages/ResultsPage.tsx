import {
  KIND_LABELS,
  runColumns,
  runsCsv,
  type DeviceRun,
  type MetricKind,
  type RunColumn,
  type RunsView,
} from '@duel/shared';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, messageOf } from '../api';
import { TopBar } from '../components/TopBar';

const KINDS: readonly MetricKind[] = ['text', 'throughput', 'transcribe', 'image', 'command'];
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

export function ResultsPage() {
  const [runs, setRuns] = useState<DeviceRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosenView, setView] = useState<RunsView | null>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [unfinished, setUnfinished] = useState(false);
  const [sort, setSort] = useState<Sort>({ id: 'date', dir: 'desc' });
  const [picked, setPicked] = useState<Partial<Record<RunsView, string[] | null>>>({});

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

  const allColumns = useMemo(() => runColumns(view), [view]);
  const chosenIds = picked[view] !== undefined ? picked[view] : savedColumns(view);
  const visible = allColumns.filter((c) =>
    c.id === 'machine' ? true : chosenIds ? chosenIds.includes(c.id) : c.initial,
  );

  const base = useMemo(
    () =>
      (runs ?? []).filter(
        (run) =>
          (view === 'all' || run.kind === view) && (unfinished || SHOWN_STATES.has(run.state)),
      ),
    [runs, view, unfinished],
  );
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const active = Object.entries(filters).filter(
    ([id, value]) => value !== '' && allColumns.some((c) => c.id === id),
  );
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
  const mainFacets = facets.filter((facet) => MAIN_FILTERS.has(facet.column.id));
  const moreFacets = facets.filter((facet) => !MAIN_FILTERS.has(facet.column.id));
  const moreActive = moreFacets.filter((facet) => filters[facet.column.id]).length;

  // The best value of each metric among the rows shown.
  const best = new Map<string, number>();
  for (const column of visible) {
    if (!column.better) continue;
    const values = rows
      .map((run) => column.value(run))
      .filter((v): v is number => typeof v === 'number');
    if (values.length < 2) continue;
    best.set(column.id, column.better === 'lower' ? Math.min(...values) : Math.max(...values));
  }

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
    const blob = new Blob([runsCsv(sorted, visible)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `model-duel-results-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
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
          <button
            type="button"
            className="btn btn-outline"
            onClick={download}
            disabled={sorted.length === 0}
          >
            Download CSV
          </button>
        }
      />
      <main className="main">
        <p className="subbar">
          One row per machine per finished race, with the medians of its counted rounds. Filter to
          compare GPUs, models and settings across races; the best value of each measurement among
          the rows shown is marked. The date opens the race.
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

            {sorted.length === 0 ? (
              <p className="muted">
                No runs match these filters.{' '}
                <button type="button" className="btn btn-quiet btn-inline" onClick={clearFilters}>
                  Clear filters
                </button>
              </p>
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
                      <tr
                        key={run.key}
                        data-testid="results-row"
                        data-machine={run.machine}
                        className={SHOWN_STATES.has(run.state) ? undefined : 'row-muted'}
                        title={run.error ?? undefined}
                        style={{ '--machine': run.color } as CSSProperties}
                      >
                        {visible.map((column) => {
                          const value = column.value(run);
                          const isBest =
                            best.has(column.id) &&
                            typeof value === 'number' &&
                            best.get(column.id) === value;
                          if (column.id === 'machine') {
                            return (
                              <th key={column.id} scope="row" className="results-machine">
                                {run.machine}
                              </th>
                            );
                          }
                          return (
                            <td
                              key={column.id}
                              data-column={column.id}
                              className={
                                [column.numeric ? 'num' : '', isBest ? 'best' : '']
                                  .filter(Boolean)
                                  .join(' ') || undefined
                              }
                            >
                              {column.id === 'date' ? (
                                <a href={`#/${run.workload}/${run.sessionId}`}>
                                  {column.text(run)}
                                </a>
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
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </main>
    </>
  );
}

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
