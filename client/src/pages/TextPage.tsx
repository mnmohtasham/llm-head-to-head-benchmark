import {
  isActiveJob,
  raceWarnings,
  REASONING_EFFORTS,
  sessionRequestSchema,
  type MachineStatusView,
  type MachineView,
  type ModelStatus,
  type RunView,
  type SessionStreamMessage,
  type SessionSummary,
  type SessionView,
} from '@duel/shared';
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { api, messageOf } from '../api';
import { CompareTable } from '../components/CompareTable';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LogPanel, type LogEntry, type NewLogEntry } from '../components/LogPanel';
import { RunMetrics } from '../components/RunMetrics';
import { RunPane } from '../components/RunPane';
import { SessionList } from '../components/SessionList';
import { SetupTable } from '../components/SetupTable';
import { TopBar } from '../components/TopBar';
import { formatMsValue, formatRate } from '../format';

const DEFAULT_PROMPT =
  'Explain in about 150 words why memory bandwidth limits how fast a local language model writes text.';

const SESSION_HASH = /^#\/text\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function sessionIdFromHash(): string | null {
  return SESSION_HASH.exec(window.location.hash)?.[1] ?? null;
}

/** The race named in the address, `#/text/<id>`, so a reload or a shared link opens it again. */
function useRouteSessionId(): string | null {
  const [id, setId] = useState(sessionIdFromHash);
  useEffect(() => {
    const onHashChange = () => setId(sessionIdFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return id;
}

function withRound(
  session: SessionView,
  index: number,
  update: (runs: RunView[]) => RunView[],
): SessionView {
  return {
    ...session,
    rounds: session.rounds.map((round) =>
      round.index === index ? { ...round, runs: update(round.runs) } : round,
    ),
  };
}

function applyMessage(session: SessionView, message: SessionStreamMessage): SessionView {
  if (message.type === 'snapshot' || message.type === 'finished') return message.session;
  if (message.type === 'run') {
    return withRound(session, message.round, (runs) =>
      runs.map((run) => (run.machineId === message.run.machineId ? message.run : run)),
    );
  }
  return withRound(session, message.round, (runs) =>
    runs.map((run) => {
      const delta = message.runs.find((d) => d.machineId === run.machineId);
      if (!delta || run.finishedAt !== null) return run;
      return {
        ...run,
        state: delta.state,
        reasoning: run.reasoning + delta.reasoning,
        answer: run.answer + delta.answer,
        live: delta.live,
      };
    }),
  );
}

/** Effort levels every selected model accepts. */
function commonEfforts(statuses: ModelStatus[]): string[] {
  if (statuses.length === 0) return [];
  const [first, ...rest] = statuses.map((s) =>
    s.reasoningEffortLevels.filter((level) =>
      (REASONING_EFFORTS as readonly string[]).includes(level),
    ),
  );
  return (first ?? []).filter((level) => rest.every((levels) => levels.includes(level)));
}

interface Props {
  machines: MachineView[] | null;
  loadError: string | null;
  log: LogEntry[];
  addLog: (entry: NewLogEntry) => void;
}

export function TextPage({ machines, loadError, log, addLog }: Props) {
  const routeId = useRouteSessionId();
  const [statuses, setStatuses] = useState<Record<string, MachineStatusView>>({});
  const [selected, setSelected] = useState<string[] | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maxTokens, setMaxTokens] = useState('2048');
  const [thinking, setThinking] = useState(true);
  /** null until the user picks: then low where every model offers it. */
  const [effort, setEffort] = useState<string | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [summaries, setSummaries] = useState<SessionSummary[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);

  const refreshSummaries = useCallback(() => {
    api.listSessions().then(
      ({ sessions }) => setSummaries(sessions),
      (error: unknown) => setFormError(messageOf(error)),
    );
  }, []);

  useEffect(() => {
    api.health().then(
      (health) => setDevMode(health.mode === 'dev'),
      () => undefined,
    );
    refreshSummaries();
  }, [refreshSummaries]);

  const machineKey = (machines ?? []).map((m) => m.id).join(',');
  useEffect(() => {
    for (const id of machineKey.split(',').filter(Boolean)) {
      api.machineStatus(id).then(
        (view) => setStatuses((current) => ({ ...current, [id]: view })),
        (error: unknown) =>
          setStatuses((current) => ({
            ...current,
            [id]: {
              machineId: id,
              status: null,
              error: messageOf(error),
              job: null,
              checkedAt: '',
            },
          })),
      );
    }
  }, [machineKey]);

  // Race every machine that has a model, once every status is in.
  useEffect(() => {
    if (selected !== null || !machines?.length) return;
    if (!machines.every((m) => statuses[m.id])) return;
    const ready = machines.filter((m) => statuses[m.id]?.status?.activeModel).map((m) => m.id);
    setSelected(ready.length > 0 ? ready : machines.slice(0, 1).map((m) => m.id));
  }, [selected, machines, statuses]);

  const fillForm = useCallback(
    (view: SessionView) => {
      setPrompt(view.config.prompt);
      setMaxTokens(String(view.config.maxTokens));
      setThinking(view.config.thinking);
      setEffort(view.config.reasoningEffort ?? '');
      const known = new Set((machines ?? []).map((m) => m.id));
      const ids = view.machines.map((m) => m.id).filter((id) => known.has(id));
      if (ids.length > 0) setSelected(ids);
    },
    [machines],
  );

  // Open the race in the address, or the latest one.
  const shownId = session?.id ?? null;
  const latestId = summaries?.[0]?.id ?? null;
  const wantedId = routeId ?? latestId;
  useEffect(() => {
    if (!wantedId || wantedId === shownId) return;
    let cancelled = false;
    api.getSession(wantedId).then(
      (view) => {
        if (cancelled) return;
        setSession(view);
        // Opening a race on purpose loads its settings, so Start runs it again.
        if (view.id === routeId) fillForm(view);
      },
      (error: unknown) => {
        if (!cancelled) setFormError(`Could not open that race. ${messageOf(error)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wantedId, shownId, routeId, fillForm]);

  const reportRun = useCallback(
    (run: RunView) => {
      const machine = machines?.find((m) => m.id === run.machineId);
      const c = run.client;
      addLog({
        machineName: machine?.name ?? run.machineName,
        color: machine?.color ?? null,
        tone: run.state === 'done' ? 'ok' : run.state === 'cancelled' ? 'info' : 'error',
        text:
          run.state === 'done' && c
            ? c.firstAnswerMs === null
              ? `No answer: stopped at ${c.finishReason === 'length' ? `Max tokens (${run.maxTokens})` : (c.finishReason ?? 'the end')} before answering. First token ${formatMsValue(c.ttftMs)}, ${formatRate(c.decodeTokPerSec, 'tok/s')}.`
              : `First word ${formatMsValue(c.firstAnswerMs)}, first token ${formatMsValue(c.ttftMs)}, ${formatRate(c.decodeTokPerSec, 'tok/s')}.`
            : run.state === 'cancelled'
              ? 'Run cancelled.'
              : `Run failed: ${run.error ?? 'unknown error'}`,
      });
    },
    [machines, addLog],
  );

  const running = session !== null && session.finishedAt === null;
  useEffect(() => {
    if (!shownId || !running) return;
    const source = new EventSource(api.sessionStreamUrl(shownId));
    source.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as SessionStreamMessage;
      setSession((current) =>
        message.type === 'snapshot'
          ? message.session
          : current && current.id === shownId
            ? applyMessage(current, message)
            : current,
      );
      if (message.type === 'run') reportRun(message.run);
      if (message.type === 'finished') {
        source.close();
        refreshSummaries();
      }
    };
    return () => source.close();
  }, [shownId, running, reportRun, refreshSummaries]);

  const chosen = (machines ?? []).filter((m) => selected?.includes(m.id));
  const chosenStatuses = chosen.map((m) => statuses[m.id]?.status ?? null);
  const loaded = chosenStatuses.filter((s): s is ModelStatus => !!s?.activeModel);
  const canThink = loaded.some((s) => s.supportsReasoning);
  const alwaysThinks = loaded.length > 0 && loaded.every((s) => s.reasoningAlwaysOn);
  const effortLevels = commonEfforts(loaded);
  const effortValue = effort ?? (effortLevels.includes('low') ? 'low' : '');

  const blockers = chosen.flatMap((m) => {
    const view = statuses[m.id];
    if (!view) return [`Checking ${m.name}…`];
    if (view.error) return [`${m.name} is not answering: ${view.error}`];
    if (isActiveJob(view.job)) return [`A model is loading on ${m.name}. Wait for it to finish.`];
    if (!view.status?.activeModel) return [`No model is loaded on ${m.name}.`];
    return [];
  });
  const warnings = raceWarnings(
    chosen.map((m) => ({ name: m.name, status: statuses[m.id]?.status ?? null })),
  );

  const toggle = (id: string) => {
    setSelected((current) => {
      const list = current ?? [];
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });
  };

  const start = async (event?: FormEvent) => {
    event?.preventDefault();
    setFormError(null);
    const parsed = sessionRequestSchema.safeParse({
      workload: 'text',
      machineIds: chosen.map((m) => m.id),
      config: {
        prompt,
        maxTokens: Number(maxTokens),
        thinking: alwaysThinks || (canThink && thinking),
        reasoningEffort: effortValue && effortLevels.includes(effortValue) ? effortValue : null,
      },
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the settings.');
      return;
    }
    setStarting(true);
    try {
      const created = await api.startSession(parsed.data);
      setSession(created);
      window.location.hash = `#/text/${created.id}`;
      refreshSummaries();
      addLog({
        machineName: null,
        color: null,
        tone: 'info',
        text:
          chosen.length === 1
            ? `Run started on ${chosen[0]?.name ?? 'one machine'}.`
            : `Race started: ${chosen.map((m) => m.name).join(', ')}.`,
      });
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!session) return;
    try {
      setSession(await api.cancelSession(session.id));
      refreshSummaries();
    } catch (error) {
      setFormError(messageOf(error));
    }
  };

  const remove = async (target: SessionSummary) => {
    await api.deleteSession(target.id);
    setDeleting(null);
    setSummaries((current) => current?.filter((s) => s.id !== target.id) ?? null);
    if (session?.id === target.id) {
      setSession(null);
      if (routeId) window.location.hash = '#/text';
    }
  };

  // Panes: the race on screen, or the chosen machines waiting for one.
  const round = session?.rounds[0] ?? null;
  const panes = session
    ? session.machines.map((m, i) => ({
        key: m.id,
        machine: machines?.find((x) => x.id === m.id) ?? m,
        run: round?.runs[i] ?? null,
        model: null,
      }))
    : chosen.map((m) => ({
        key: m.id,
        machine: m,
        run: null,
        model: statuses[m.id]?.status?.activeModel ?? null,
      }));
  const finishedRuns = round?.runs.filter((run) => run.finishedAt !== null && run.client) ?? [];
  const columns = Math.min(Math.max(panes.length, 1), 4);

  return (
    <>
      <TopBar
        title="Text"
        current="text"
        actions={
          running ? (
            <button type="button" className="btn btn-primary" onClick={() => void cancel()}>
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              form="run-form"
              className="btn btn-primary"
              disabled={starting || blockers.length > 0 || chosen.length === 0}
            >
              Start
            </button>
          )
        }
      />

      <main className="main">
        {devMode ? (
          <div className="banner banner-warn" role="status">
            This is the development server. Its extra work can skew timings. For measurements, run
            npm run build and npm start.
          </div>
        ) : null}
        {loadError ? (
          <div className="banner banner-error" role="alert">
            {loadError}
          </div>
        ) : null}
        {machines && machines.length === 0 ? (
          <section className="empty">
            <h2 className="section-title">No machines yet</h2>
            <p className="muted">
              Add your machines on the <a href="#/machines">Machines</a> screen first.
            </p>
          </section>
        ) : null}

        {machines && machines.length > 0 ? (
          <form
            id="run-form"
            className="panel run-config"
            onSubmit={(event) => void start(event)}
            noValidate
          >
            <fieldset className="chip-group">
              <legend className="hero-label">Machines</legend>
              {machines.map((m) => {
                const s = statuses[m.id];
                return (
                  <label
                    key={m.id}
                    className="chip-radio"
                    style={{ '--machine': m.color } as CSSProperties}
                  >
                    <input
                      type="checkbox"
                      name="machines"
                      value={m.id}
                      checked={selected?.includes(m.id) ?? false}
                      onChange={() => toggle(m.id)}
                      disabled={running}
                    />
                    <span className="chip-radio-body">
                      <span className="chip-radio-name">{m.name}</span>
                      <span className="chip-radio-model">
                        {s
                          ? s.error
                            ? 'unreachable'
                            : [s.status?.activeModel ?? 'no model loaded', s.status?.quant]
                                .filter(Boolean)
                                .join(' · ')
                          : 'checking…'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <div className="field">
              <label htmlFor="run-prompt">Prompt</label>
              <textarea
                id="run-prompt"
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={running}
              />
            </div>

            <div className="run-options">
              <div className="field">
                <label htmlFor="run-max-tokens">Max tokens</label>
                <input
                  id="run-max-tokens"
                  inputMode="numeric"
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                  disabled={running}
                />
              </div>
              <div className="field">
                <span className="field-label" id="thinking-label">
                  Thinking
                </span>
                {loaded.length === 0 ? (
                  <p className="field-hint">Pick a machine with a model loaded.</p>
                ) : alwaysThinks ? (
                  <p className="field-hint">These models always think.</p>
                ) : canThink ? (
                  <div className="toggle-chips" role="radiogroup" aria-labelledby="thinking-label">
                    {[true, false].map((on) => (
                      <button
                        key={String(on)}
                        type="button"
                        role="radio"
                        aria-checked={thinking === on}
                        className={`toggle-chip${thinking === on ? ' toggle-chip-on' : ''}`}
                        onClick={() => setThinking(on)}
                        disabled={running}
                      >
                        {on ? 'On' : 'Off'}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="field-hint">These models do not think.</p>
                )}
              </div>
              {effortLevels.length > 0 && thinking && canThink ? (
                <div className="field">
                  <label htmlFor="run-effort">Reasoning effort</label>
                  <select
                    id="run-effort"
                    value={effortValue}
                    onChange={(event) => setEffort(event.target.value)}
                    disabled={running}
                  >
                    <option value="">Model default</option>
                    {effortLevels.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            {thinking && canThink ? (
              <p className="field-hint">
                Max tokens includes the thinking. If a model thinks until the limit, it never
                answers; lower the effort or raise the limit.
              </p>
            ) : null}
            {blockers.length > 0 ? (
              <ul className="start-check" data-testid="start-blockers">
                {blockers.map((text) => (
                  <li key={text} className="field-error">
                    {text}
                    {text.startsWith('No model') ? (
                      <>
                        {' '}
                        Load one on the <a href="#/models">Models</a> tab.
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {warnings.length > 0 ? (
              <ul className="start-check" data-testid="race-warnings">
                {warnings.map((text) => (
                  <li key={text} className="note-warn">
                    {text}
                  </li>
                ))}
              </ul>
            ) : null}
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
          </form>
        ) : null}

        {panes.length > 0 ? (
          <div
            className={`race-panes cols-${columns}`}
            style={{ '--cols': columns } as CSSProperties}
            data-testid="race-panes"
          >
            {panes.map((pane) => (
              <RunPane
                key={pane.key}
                machine={pane.machine}
                modelName={pane.model}
                run={pane.run}
              />
            ))}
          </div>
        ) : null}

        {session && session.state === 'interrupted' ? (
          <div className="banner banner-warn" role="status">
            {session.error}
          </div>
        ) : null}

        {session && session.machines.length > 1 && finishedRuns.length > 0 && !running ? (
          <CompareTable session={session} />
        ) : null}
        {session && !running
          ? finishedRuns.map((run) =>
              session.machines.length === 1 ? (
                <RunMetrics key={run.id} run={run} />
              ) : (
                <details key={run.id} className="panel run-details">
                  <summary>Measurements for {run.machineName}</summary>
                  <RunMetrics run={run} />
                </details>
              ),
            )
          : null}
        {session && !running ? <SetupTable session={session} /> : null}

        <SessionList
          sessions={summaries}
          currentId={session?.id ?? null}
          onDelete={(target) => setDeleting(target)}
        />
        <LogPanel machines={machines ?? []} entries={log} />
      </main>

      {deleting ? (
        <ConfirmDialog
          title="Delete this race?"
          message={`The race from ${new Date(deleting.createdAt).toLocaleString()} and its results will be removed from this computer.`}
          confirmLabel="Delete race"
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}
