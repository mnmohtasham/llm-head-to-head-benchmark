import {
  CLOUD_INFO,
  MAX_CONCURRENCY,
  MAX_SUITE_RACES,
  PRESETS,
  SUITE_PRESET_IDS,
  suiteRequestSchema,
  suiteSize,
  thinkingKey,
  thinkingLabel,
  type CloudModel,
  type MachineStatusView,
  type MachineView,
  type ModelStatus,
  type PrefillMode,
  type ReasoningEffort,
  type Suite,
  type SuitePresetId,
  type SuiteSummary,
  type SuiteThinking,
  type TextMode,
} from '@duel/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, messageOf } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  cloudEfforts,
  commonEfforts,
  MachinePicker,
  PLAN_LABELS,
  PlanFields,
  sharedHost,
  Toggle,
  usePlan,
} from '../components/RaceParts';
import { plural, SUITE_STATE_LABEL, SuiteReport, when } from '../components/SuiteReport';
import { TopBar } from '../components/TopBar';
import { fieldNumber, formProblem } from '../fields';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** How often a running suite is read again. */
const POLL_MS = 2000;

function suiteIdFromHash(): string | null {
  return new RegExp(`^#/suites/(${UUID})$`).exec(window.location.hash)?.[1] ?? null;
}

/** The suite named in the address, `#/suites/<id>`, so a reload or a link opens it again. */
function useRouteSuiteId(): string | null {
  const [id, setId] = useState(suiteIdFromHash);
  useEffect(() => {
    const onHashChange = () => setId(suiteIdFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return id;
}

/** "6 done, 1 skipped, 1 failed". */
function countsText(counts: SuiteSummary['counts']): string {
  const parts = (
    [
      ['done', 'done'],
      ['running', 'running'],
      ['queued', 'waiting'],
      ['skipped', 'skipped'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
      ['interrupted', 'interrupted'],
    ] as const
  )
    .filter(([state]) => counts[state] > 0)
    .map(([state, word]) => `${counts[state]} ${word}`);
  return parts.join(', ');
}

/** A thinking setting the form offers, keyed as the suite request compares them. */
interface ThinkingOption {
  key: string;
  label: string;
  value: SuiteThinking;
}

/** "512, 2048" or "512 2048": whole numbers, no thousands separators. */
function parseTokens(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
}

interface Props {
  machines: MachineView[] | null;
  loadError: string | null;
}

export function SuitesPage({ machines, loadError }: Props) {
  const routeId = useRouteSuiteId();
  const [statuses, setStatuses] = useState<Record<string, MachineStatusView>>({});
  const [selected, setSelected] = useState<string[] | null>(null);
  const [presets, setPresets] = useState<SuitePresetId[]>(['short']);
  /** Keys of the thinking settings picked; null until the user picks, then the first offered. */
  const [thinking, setThinking] = useState<string[] | null>(null);
  const [maxTokens, setMaxTokens] = useState('512, 2048');
  const [mode, setMode] = useState<TextMode>('latency');
  const [concurrency, setConcurrency] = useState('4');
  const [prefill, setPrefill] = useState<PrefillMode>('cold');
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const plan = usePlan();
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const [summaries, setSummaries] = useState<SuiteSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [shown, setShown] = useState<Suite | null>(null);
  const [shownError, setShownError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState<SuiteSummary | null>(null);

  const refresh = useCallback(() => {
    api.listSuites().then(
      ({ suites }) => {
        setSummaries(suites);
        setListError(null);
      },
      (error: unknown) => setListError(messageOf(error)),
    );
  }, []);
  useEffect(() => refresh(), [refresh]);

  useEffect(() => {
    api.machineHosts().then(
      ({ hosts: keys }) => setHosts(keys),
      () => undefined,
    );
  }, [machines]);

  // Cloud models have no status to read.
  const machineKey = (machines ?? [])
    .filter((m) => !m.cloud)
    .map((m) => m.id)
    .join(',');
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

  // Every machine that has a model, once every status is in; cloud models only when picked.
  useEffect(() => {
    if (selected !== null || !machines?.length) return;
    const local = machines.filter((m) => !m.cloud);
    if (!local.every((m) => statuses[m.id])) return;
    const ready = local.filter((m) => statuses[m.id]?.status?.activeModel).map((m) => m.id);
    const fallback = local[0] ?? machines[0];
    setSelected(ready.length > 0 ? ready : fallback ? [fallback.id] : []);
  }, [selected, machines, statuses]);

  // The suite on screen: the one in the address, or the newest.
  const shownId = shown?.id ?? null;
  const wantedId = routeId ?? summaries?.[0]?.id ?? null;
  useEffect(() => {
    if (!wantedId || wantedId === shownId) return;
    let cancelled = false;
    api.getSuite(wantedId).then(
      (suite) => {
        if (cancelled) return;
        setShown(suite);
        setShownError(null);
      },
      (error: unknown) => {
        if (!cancelled) setShownError(`Could not open that suite. ${messageOf(error)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wantedId, shownId]);

  // While a suite runs, read it and the list again every couple of seconds.
  const activeId = summaries?.find((s) => s.state === 'running')?.id ?? null;
  const shownRunning = shown?.state === 'running';
  useEffect(() => {
    if (!activeId && !shownRunning) return;
    const timer = setInterval(() => {
      refresh();
      if (!shownId || !shownRunning) return;
      api.getSuite(shownId).then(
        (suite) => setShown((current) => (current?.id === suite.id ? suite : current)),
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [activeId, shownId, shownRunning, refresh]);

  const busy = activeId !== null || shownRunning;
  const chosen = (machines ?? []).filter((m) => selected?.includes(m.id));
  const chosenIds = chosen.map((m) => m.id);
  const loaded = chosen
    .map((m) => statuses[m.id]?.status ?? null)
    .filter((s): s is ModelStatus => !!s?.activeModel);
  const cloudModels = chosen
    .map((m) => m.cloud?.model)
    .filter((model): model is CloudModel => !!model);
  const answering = loaded.length + cloudModels.length;
  const canThink =
    loaded.some((s) => s.supportsReasoning) || cloudModels.some((m) => m.thinking !== 'none');
  const alwaysThinks =
    answering > 0 &&
    loaded.every((s) => s.reasoningAlwaysOn) &&
    cloudModels.every((m) => m.thinking === 'always');
  const effortLevels = loaded.length > 0 ? commonEfforts(loaded) : cloudEfforts(cloudModels);
  const thinkingOptions: ThinkingOption[] = [
    ...(alwaysThinks
      ? []
      : [{ key: 'off', label: 'Off', value: { thinking: false, reasoningEffort: null } }]),
    ...(canThink
      ? [
          { key: 'on:', label: 'On', value: { thinking: true, reasoningEffort: null } },
          ...effortLevels.map((level) => {
            const value = { thinking: true, reasoningEffort: level as ReasoningEffort };
            return { key: thinkingKey(value), label: thinkingLabel(value), value };
          }),
        ]
      : []),
  ];
  const thinkingKeys = thinking ?? (thinkingOptions[0] ? [thinkingOptions[0].key] : []);
  const chosenThinking = thinkingOptions.filter((option) => thinkingKeys.includes(option.key));
  const tokenValues = parseTokens(maxTokens);
  const count = suiteSize({ presets, thinking: chosenThinking, maxTokens: tokenValues });

  const draft = suiteRequestSchema.safeParse({
    machineIds: chosenIds,
    presets,
    thinking: chosenThinking.map((option) => option.value),
    maxTokens: tokenValues,
    plan: plan.value,
    mode,
    // Only what is sent is checked: latency mode hides Requests at once.
    concurrency: mode === 'throughput' ? fieldNumber(concurrency) : undefined,
    prefill,
    acknowledgeWarnings: acceptWarnings,
  });
  const problem = tokenValues.some((n) => !Number.isInteger(n))
    ? 'Max tokens takes whole numbers, separated by commas.'
    : !draft.success
      ? formProblem(draft.error, { ...PLAN_LABELS, concurrency: 'Requests at once' })
      : null;
  const sharing = sharedHost(chosen, hosts);

  const togglePreset = (id: SuitePresetId) =>
    setPresets((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : SUITE_PRESET_IDS.filter((x) => x === id || current.includes(x)),
    );
  const toggleThinking = (key: string) => {
    const current = thinkingKeys;
    setThinking(
      current.includes(key)
        ? current.filter((x) => x !== key)
        : thinkingOptions.map((o) => o.key).filter((x) => x === key || current.includes(x)),
    );
  };
  const toggleMachine = (id: string) =>
    setSelected((current) => {
      const list = current ?? [];
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });

  const start = async (event?: FormEvent) => {
    event?.preventDefault();
    setFormError(null);
    if (!draft.success) {
      setFormError(problem);
      return;
    }
    setStarting(true);
    try {
      const suite = await api.startSuite(draft.data);
      setShown(suite);
      setShownError(null);
      window.location.hash = `#/suites/${suite.id}`;
      refresh();
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    const id = activeId ?? (shownRunning ? shownId : null);
    if (!id) return;
    setCancelling(true);
    try {
      const suite = await api.cancelSuite(id);
      setShown((current) => (current?.id === suite.id ? suite : current));
      refresh();
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setCancelling(false);
    }
  };

  const remove = async (target: SuiteSummary) => {
    await api.deleteSuite(target.id);
    setDeleting(null);
    setSummaries((current) => current?.filter((s) => s.id !== target.id) ?? null);
    if (shownId === target.id) {
      setShown(null);
      if (routeId) window.location.hash = '#/suites';
    }
  };

  const describe = (m: MachineView) => {
    if (m.cloud) {
      return `${CLOUD_INFO[m.cloud.provider].label} · ${m.cloud.model?.id ?? 'no model chosen'}`;
    }
    const s = statuses[m.id];
    return s
      ? s.error
        ? 'unreachable'
        : [
            m.server === 'lmstudio' ? 'LM Studio' : null,
            s.status?.activeModel ?? 'no model loaded',
            s.status?.quant,
          ]
            .filter(Boolean)
            .join(' · ')
      : 'checking…';
  };

  const rounds = plan.value.rounds;
  const requests =
    count * chosen.length * ((Number.isFinite(rounds) ? rounds : 0) + (plan.warmup ? 1 : 0));

  return (
    <>
      <TopBar
        title="Suites"
        current="suites"
        actions={
          busy ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling…' : 'Cancel suite'}
            </button>
          ) : (
            <button
              type="submit"
              form="suite-form"
              className="btn btn-primary"
              disabled={starting || !draft.success || machines === null}
            >
              Start
            </button>
          )
        }
      />
      <main className="main">
        <p className="subbar">
          A suite races every combination of the prompts, thinking settings and Max tokens values
          you pick, one race after another on the same machines, and sums them up at the end. Each
          race runs pre-flight first; one it refuses is skipped and the suite goes on.
        </p>
        {loadError ? (
          <div className="banner banner-error" role="alert">
            {loadError}
          </div>
        ) : null}
        {machines === null && !loadError ? <p className="loading">Loading machines…</p> : null}
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
            id="suite-form"
            className="panel run-config"
            onSubmit={(event) => void start(event)}
            noValidate
            aria-label="New suite"
          >
            <MachinePicker
              machines={machines}
              selected={selected}
              onToggle={toggleMachine}
              running={busy}
              describe={describe}
            />

            <div className="field">
              <span className="field-label" id="suite-presets-label">
                Prompts
              </span>
              <div className="toggle-chips" role="group" aria-labelledby="suite-presets-label">
                {PRESETS.filter((p) => p.id !== 'custom').map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={presets.includes(option.id as SuitePresetId)}
                    className={`toggle-chip${presets.includes(option.id as SuitePresetId) ? ' toggle-chip-on' : ''}`}
                    onClick={() => togglePreset(option.id as SuitePresetId)}
                    disabled={busy}
                    title={option.description}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="field-hint">
                The standard prompts only, so every race compares with the others and with LLM
                Bench.
              </p>
            </div>

            <div className="run-options">
              <div className="field">
                <span className="field-label" id="suite-thinking-label">
                  Thinking
                </span>
                {answering === 0 ? (
                  <p className="field-hint">Pick a machine with a model loaded.</p>
                ) : (
                  <div className="toggle-chips" role="group" aria-labelledby="suite-thinking-label">
                    {thinkingOptions.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        aria-pressed={thinkingKeys.includes(option.key)}
                        className={`toggle-chip${thinkingKeys.includes(option.key) ? ' toggle-chip-on' : ''}`}
                        onClick={() => toggleThinking(option.key)}
                        disabled={busy}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
                {answering > 0 && !canThink ? (
                  <p className="field-hint">These models do not think.</p>
                ) : alwaysThinks ? (
                  <p className="field-hint">These models always think.</p>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="suite-max-tokens">Max tokens</label>
                <input
                  id="suite-max-tokens"
                  inputMode="numeric"
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                  disabled={busy}
                  aria-describedby="suite-max-tokens-hint"
                />
                <p className="field-hint" id="suite-max-tokens-hint">
                  One or more values, separated by commas: 512, 2048. Thinking counts.
                </p>
              </div>
            </div>

            <div className="run-options">
              <div className="field">
                <Toggle
                  labelId="suite-mode-label"
                  label="Mode"
                  options={[
                    ['latency', 'Latency'],
                    ['throughput', 'Throughput'],
                  ]}
                  value={mode}
                  onChange={setMode}
                  disabled={busy}
                />
              </div>
              {mode === 'throughput' ? (
                <div className="field">
                  <label htmlFor="suite-concurrency">Requests at once</label>
                  <input
                    id="suite-concurrency"
                    inputMode="numeric"
                    value={concurrency}
                    onChange={(event) => setConcurrency(event.target.value)}
                    disabled={busy}
                  />
                  <p className="field-hint">1 to {MAX_CONCURRENCY}.</p>
                </div>
              ) : null}
              <Toggle
                labelId="suite-prefill-label"
                label="Prefill"
                options={[
                  ['cold', 'Cold'],
                  ['warm', 'Warm'],
                ]}
                value={prefill}
                onChange={setPrefill}
                disabled={busy}
              />
            </div>
            <PlanFields plan={plan} running={busy} sharing={sharing} />
            <label className="check-line">
              <input
                type="checkbox"
                checked={acceptWarnings}
                onChange={(event) => setAcceptWarnings(event.target.checked)}
                disabled={busy}
              />
              Accept pre-flight warnings
            </label>
            <p className="field-hint">
              {acceptWarnings
                ? 'A race whose machines differ in model, quant, backend or settings still runs, as with Race anyway.'
                : 'A race pre-flight warns about, such as machines with different quants, is skipped.'}{' '}
              Sampling is the default for every race.
            </p>

            <p
              className={count > MAX_SUITE_RACES ? 'field-error' : 'suite-count'}
              role="status"
              data-testid="suite-count"
            >
              {plural(count, 'race', 'races')}: {plural(presets.length, 'prompt', 'prompts')} ×{' '}
              {plural(chosenThinking.length, 'thinking setting', 'thinking settings')} ×{' '}
              {plural(tokenValues.length, 'Max tokens value', 'Max tokens values')}
              {count > MAX_SUITE_RACES
                ? `. A suite runs at most ${MAX_SUITE_RACES}.`
                : chosen.length > 0 && requests > 0
                  ? `, ${plural(requests, 'request', 'requests')} in all.`
                  : '.'}
            </p>
            {cloudModels.length > 0 ? (
              <p className="note-warn">
                Every request to a cloud model is billed to its key, warm-ups included.
              </p>
            ) : null}
            {problem && count <= MAX_SUITE_RACES ? (
              <p className="field-hint" data-testid="suite-problem">
                {problem}
              </p>
            ) : null}
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
          </form>
        ) : null}

        {shownError ? (
          <div className="banner banner-error" role="alert">
            {shownError}
          </div>
        ) : null}
        {shown ? <SuiteReport suite={shown} /> : null}

        <section className="panel session-list" aria-labelledby="suites-title">
          <h2 id="suites-title" className="section-title">
            Past suites
          </h2>
          {listError ? (
            <p className="field-error">Could not read the suites: {listError}</p>
          ) : summaries === null ? (
            <p className="muted">Loading suites…</p>
          ) : summaries.length === 0 ? (
            <p className="muted">Suites you run are kept here, so you can open them again.</p>
          ) : (
            <ol className="session-rows">
              {summaries.map((s) => (
                <li
                  key={s.id}
                  className={`session-row${s.id === shownId ? ' session-current' : ''}`}
                  data-testid="suite-list-row"
                  aria-current={s.id === shownId ? 'true' : undefined}
                >
                  <div className="session-main">
                    <p className="session-head">
                      <time dateTime={s.createdAt}>{when(s.createdAt)}</time>
                      <span className={`session-state session-${s.state}`}>
                        {SUITE_STATE_LABEL[s.state]}
                      </span>
                      <span>{plural(s.races, 'race', 'races')}</span>
                    </p>
                    <p className="session-prompt">{s.label}</p>
                    <p className="session-machines">
                      {s.machines.map((m) => (
                        <span key={m.id} className="session-machine" style={{ color: m.color }}>
                          {m.name}
                        </span>
                      ))}
                      <span>{countsText(s.counts)}</span>
                    </p>
                  </div>
                  <div className="session-actions">
                    <a
                      className="btn btn-quiet"
                      href={`#/suites/${s.id}`}
                      aria-label={`Open the suite from ${when(s.createdAt)}`}
                    >
                      Open
                    </a>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setDeleting(s)}
                      disabled={s.state === 'running'}
                      aria-label={`Delete the suite from ${when(s.createdAt)}`}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>

      {deleting ? (
        <ConfirmDialog
          title="Delete this suite?"
          message={`The suite from ${new Date(deleting.createdAt).toLocaleString()} will be removed from this computer. Its races stay, in the Text tab's results log and in Results.`}
          confirmLabel="Delete suite"
          onConfirm={() => (deleting ? remove(deleting) : Promise.resolve())}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}
