import {
  CLOUD_INFO,
  DEFAULT_SAMPLING,
  MAX_CONCURRENCY,
  PRESETS,
  REASONING_EFFORTS,
  sessionRequestSchema,
  textConfigSchema,
  type CloudModel,
  type MachineStatusView,
  type MachineView,
  type ModelStatus,
  type PrefillMode,
  type PresetId,
  type PreflightIssue,
  type RunView,
  type SessionView,
  type TextMode,
} from '@duel/shared';
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { api, messageOf, type PresetView } from '../api';
import { BlindVote } from '../components/BlindVote';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LogPanel, type LogEntry, type NewLogEntry } from '../components/LogPanel';
import {
  MachinePicker,
  PlanFields,
  PreflightPanel,
  ProgressLine,
  RaceReport,
  sharedHost,
  Toggle,
  usePlan,
} from '../components/RaceParts';
import { RunMetrics } from '../components/RunMetrics';
import { ThroughputTable } from '../components/ThroughputTable';
import { RunPane } from '../components/RunPane';
import { SessionList } from '../components/SessionList';
import { TelemetrySwitch } from '../components/TelemetryChips';
import { TopBar } from '../components/TopBar';
import { formatMsValue, formatRate } from '../format';
import { usePreflight } from '../usePreflight';
import { useRace } from '../useRace';
import { useTelemetry } from '../useTelemetry';

const DEFAULT_PROMPT =
  'Explain in about 150 words why memory bandwidth limits how fast a local language model writes text.';

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

/** Effort levels any of these cloud models takes; each gets the nearest level it offers. */
function cloudEfforts(models: CloudModel[]): string[] {
  return REASONING_EFFORTS.filter(
    (level) => level !== 'none' && models.some((m) => m.efforts.includes(level)),
  );
}

interface Props {
  machines: MachineView[] | null;
  loadError: string | null;
  log: LogEntry[];
  addLog: (entry: NewLogEntry) => void;
}

/** The log line for a finished text run. */
function describeRun(run: RunView): string {
  const c = run.client;
  if (!c) return 'Done.';
  return c.firstAnswerMs === null
    ? `No answer: stopped at ${c.finishReason === 'length' ? `Max tokens (${run.maxTokens})` : (c.finishReason ?? 'the end')} before answering. First token ${formatMsValue(c.ttftMs)}, ${formatRate(c.decodeTokPerSec, 'tok/s')}.`
    : `First word ${formatMsValue(c.firstAnswerMs)}, first token ${formatMsValue(c.ttftMs)}, ${formatRate(c.decodeTokPerSec, 'tok/s')}.`;
}

export function TextPage({ machines, loadError, log, addLog }: Props) {
  const [statuses, setStatuses] = useState<Record<string, MachineStatusView>>({});
  const [selected, setSelected] = useState<string[] | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maxTokens, setMaxTokens] = useState('2048');
  const [thinking, setThinking] = useState(true);
  /** null until the user picks: then low where every model offers it. */
  const [effort, setEffort] = useState<string | null>(null);
  const plan = usePlan();
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const [preset, setPreset] = useState<PresetId>('custom');
  const [presetViews, setPresetViews] = useState<PresetView[]>([]);
  const [prefill, setPrefill] = useState<PrefillMode>('cold');
  const [mode, setMode] = useState<TextMode>('latency');
  const [concurrency, setConcurrency] = useState('4');
  /** Machines whose model is loading again with more slots, from pre-flight's shortcut. */
  const [reloading, setReloading] = useState<Record<string, string>>({});
  const [sampling, setSampling] = useState(() => ({
    temperature: String(DEFAULT_SAMPLING.temperature),
    topP: String(DEFAULT_SAMPLING.topP),
    topK: String(DEFAULT_SAMPLING.topK),
    minP: String(DEFAULT_SAMPLING.minP),
    repetitionPenalty: String(DEFAULT_SAMPLING.repetitionPenalty),
    seed: String(DEFAULT_SAMPLING.seed),
  }));
  const fillPlan = plan.fill;

  const fillForm = useCallback(
    (view: SessionView) => {
      if (view.workload !== 'text') return;
      if (view.config.preset === 'custom') setPrompt(view.config.prompt);
      setMaxTokens(String(view.config.maxTokens));
      setThinking(view.config.thinking);
      setEffort(view.config.reasoningEffort ?? '');
      setPreset(view.config.preset);
      setPrefill(view.config.prefill);
      setMode(view.config.mode);
      setConcurrency(String(view.config.concurrency));
      setSampling({
        temperature: String(view.config.sampling.temperature),
        topP: String(view.config.sampling.topP),
        topK: String(view.config.sampling.topK),
        minP: String(view.config.sampling.minP),
        repetitionPenalty: String(view.config.sampling.repetitionPenalty),
        seed: String(view.config.sampling.seed),
      });
      fillPlan(view.plan);
      const known = new Set((machines ?? []).map((m) => m.id));
      const ids = view.machines.map((m) => m.id).filter((id) => known.has(id));
      if (ids.length > 0) setSelected(ids);
    },
    [machines, fillPlan],
  );
  const race = useRace({ workload: 'text', machines, addLog, describeRun, onOpen: fillForm });
  const { session, running } = race;

  useEffect(() => {
    api.presets().then(
      ({ presets }) => setPresetViews(presets),
      () => undefined,
    );
  }, []);

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

  // Race every machine that has a model, once every status is in. Cloud models, which cost
  // money, join only when picked, unless there is nothing else.
  useEffect(() => {
    if (selected !== null || !machines?.length) return;
    const local = machines.filter((m) => !m.cloud);
    if (!local.every((m) => statuses[m.id])) return;
    const ready = local.filter((m) => statuses[m.id]?.status?.activeModel).map((m) => m.id);
    const fallback = local[0] ?? machines.find((m) => m.cloud?.model) ?? machines[0];
    setSelected(ready.length > 0 ? ready : fallback ? [fallback.id] : []);
  }, [selected, machines, statuses]);

  const chosen = (machines ?? []).filter((m) => selected?.includes(m.id));
  const chosenStatuses = chosen.map((m) => statuses[m.id]?.status ?? null);
  const loaded = chosenStatuses.filter((s): s is ModelStatus => !!s?.activeModel);
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
  // Local models set the levels when there are any; cloud models take the nearest they offer.
  const effortLevels = loaded.length > 0 ? commonEfforts(loaded) : cloudEfforts(cloudModels);
  const effortValue = effort ?? (effortLevels.includes('low') ? 'low' : '');

  // The config the form describes, or the reason it cannot be sent yet.
  const draft = textConfigSchema.safeParse({
    mode,
    concurrency: Number(concurrency),
    preset,
    prompt: preset === 'custom' ? prompt : '',
    maxTokens: Number(maxTokens),
    thinking: alwaysThinks || (canThink && thinking),
    reasoningEffort: effortValue && effortLevels.includes(effortValue) ? effortValue : null,
    prefill,
    sampling: {
      temperature: Number(sampling.temperature),
      topP: Number(sampling.topP),
      topK: Number(sampling.topK),
      minP: Number(sampling.minP),
      repetitionPenalty: Number(sampling.repetitionPenalty),
      seed: Number(sampling.seed),
    },
  });
  const chosenIds = chosen.map((m) => m.id);
  const preflightKey = draft.success
    ? JSON.stringify({ workload: 'text', machineIds: chosenIds, config: draft.data })
    : null;
  const preflight = usePreflight(preflightKey, running);
  const blocked = !draft.success || chosen.length === 0 || preflight.stops;
  // Machines on one computer compete for it, so they should take turns.
  const sharing = sharedHost(chosen, hosts);

  /** Pre-flight's shortcut when a machine has too few slots: reload its model with enough. */
  const reloadWithSlots = async (machineId: string, slots: number) => {
    setReloading((current) => ({ ...current, [machineId]: 'Loading again…' }));
    try {
      await api.reloadSlots(machineId, slots);
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const view = await api.machineStatus(machineId);
        setStatuses((current) => ({ ...current, [machineId]: view }));
        if (view.job && view.job.state !== 'loading' && view.job.state !== 'cancelling') {
          setReloading((current) => ({
            ...current,
            [machineId]:
              view.job?.state === 'loaded'
                ? ''
                : `The load ended: ${view.job?.error ?? view.job?.state ?? 'unknown'}`,
          }));
          break;
        }
      }
    } catch (error) {
      setReloading((current) => ({ ...current, [machineId]: messageOf(error) }));
    }
    preflight.recheck();
  };
  const slotShortcut = (issue: PreflightIssue) => {
    if (issue.code !== 'slots' || issue.level !== 'error' || !issue.machineId) return null;
    const id = issue.machineId;
    const state = reloading[id];
    return state ? (
      <span className="field-hint">{state}</span>
    ) : (
      <button
        type="button"
        className="btn btn-quiet btn-inline"
        onClick={() => void reloadWithSlots(id, Number(concurrency))}
        disabled={running}
      >
        Reload with {concurrency} slots
      </button>
    );
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const list = current ?? [];
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });
  };

  const start = async (event?: FormEvent) => {
    event?.preventDefault();
    race.setFormError(null);
    if (!draft.success) {
      race.setFormError(draft.error.issues[0]?.message ?? 'Check the settings.');
      return;
    }
    const parsed = sessionRequestSchema.safeParse({
      workload: 'text',
      machineIds: chosenIds,
      config: draft.data,
      acknowledgeWarnings: preflight.raceAnyway,
      plan: plan.value,
    });
    if (!parsed.success) {
      race.setFormError(parsed.error.issues[0]?.message ?? 'Check the settings.');
      return;
    }
    const refused = await race.start(
      parsed.data,
      chosen.map((m) => m.name),
    );
    // Pre-flight on the server found something the form had not seen yet.
    if (refused?.issues) preflight.showIssues(refused.issues);
  };

  const round = race.round;
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
        model: m.cloud
          ? (m.cloud.model?.id ?? null)
          : (statuses[m.id]?.status?.activeModel ?? null),
      }));
  const cloudIds = new Set((machines ?? []).filter((m) => m.cloud).map((m) => m.id));
  const telemetry = useTelemetry(panes.map((pane) => pane.key).filter((id) => !cloudIds.has(id)));
  const columns = Math.min(Math.max(panes.length, 1), 4);

  const votable =
    session !== null &&
    !running &&
    session.machines.length === 2 &&
    session.rounds.some((r) => r.runs.every((run) => run.answer.length > 0));
  if (race.blind && session) {
    return (
      <>
        <TopBar title="Blind vote" current="text" />
        <main className="main">
          <BlindVote
            key={session.id}
            session={session}
            onClose={(updated) => {
              if (updated) race.setSession(updated);
              race.setBlind(false);
              race.refreshSummaries();
            }}
          />
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Text"
        current="text"
        actions={
          running ? (
            <button type="button" className="btn btn-primary" onClick={() => void race.cancel()}>
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              form="run-form"
              className="btn btn-primary"
              disabled={race.starting || blocked}
            >
              Start
            </button>
          )
        }
      />

      <main className="main">
        {race.devMode ? (
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
            <MachinePicker
              machines={machines}
              selected={selected}
              onToggle={toggle}
              running={running}
              describe={(m) => {
                if (m.cloud) {
                  return `${CLOUD_INFO[m.cloud.provider].label} · ${m.cloud.model?.id ?? 'no model chosen'}`;
                }
                const s = statuses[m.id];
                return s
                  ? s.error
                    ? 'unreachable'
                    : [s.status?.activeModel ?? 'no model loaded', s.status?.quant]
                        .filter(Boolean)
                        .join(' · ')
                  : 'checking…';
              }}
            />

            <div className="field">
              <span className="field-label" id="preset-label">
                Prompt
              </span>
              <div className="toggle-chips" role="radiogroup" aria-labelledby="preset-label">
                {PRESETS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={preset === option.id}
                    className={`toggle-chip${preset === option.id ? ' toggle-chip-on' : ''}`}
                    onClick={() => setPreset(option.id)}
                    disabled={running}
                    title={option.description}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {preset === 'custom' ? (
                <textarea
                  id="run-prompt"
                  aria-label="Custom prompt"
                  rows={3}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  disabled={running}
                />
              ) : (
                <div className="preset-preview" data-testid="preset-preview">
                  <p className="field-hint">
                    {PRESETS.find((option) => option.id === preset)?.description}
                    {presetViews.find((v) => v.id === preset)
                      ? ` ${presetViews
                          .find((v) => v.id === preset)
                          ?.words.toLocaleString('en-US')} words.`
                      : ''}
                  </p>
                  <pre className="preset-text">
                    {presetViews.find((v) => v.id === preset)?.preview ?? 'Loading…'}
                  </pre>
                </div>
              )}
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
                {answering === 0 ? (
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
                  {cloudModels.length > 0 ? (
                    <p className="field-hint">Cloud models take the nearest level they offer.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="run-options">
              <div className="field">
                <span className="field-label" id="prefill-label">
                  Prefill
                </span>
                <div className="toggle-chips" role="radiogroup" aria-labelledby="prefill-label">
                  {(['cold', 'warm'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={prefill === mode}
                      className={`toggle-chip${prefill === mode ? ' toggle-chip-on' : ''}`}
                      onClick={() => setPrefill(mode)}
                      disabled={running}
                    >
                      {mode === 'cold' ? 'Cold' : 'Warm'}
                    </button>
                  ))}
                </div>
                <p className="field-hint">
                  {prefill === 'cold'
                    ? 'A fresh line starts each round’s prompt and a seed is sent, so no cached prompt helps.'
                    : 'The same prompt every round and no seed: rounds after the first may reuse the cache.'}
                </p>
              </div>
              <TelemetrySwitch enabled={telemetry.enabled} onError={race.setFormError} />
            </div>
            <div className="run-options">
              <div className="field">
                <Toggle
                  labelId="mode-label"
                  label="Mode"
                  options={[
                    ['latency', 'Latency'],
                    ['throughput', 'Throughput'],
                  ]}
                  value={mode}
                  onChange={setMode}
                  disabled={running}
                />
                <p className="field-hint">
                  {mode === 'latency'
                    ? 'One request per machine: how fast one answer comes.'
                    : 'Several copies of the prompt at once on each machine: how many tokens it delivers in total.'}
                </p>
              </div>
              {mode === 'throughput' ? (
                <div className="field">
                  <label htmlFor="run-concurrency">Requests at once</label>
                  <input
                    id="run-concurrency"
                    inputMode="numeric"
                    value={concurrency}
                    onChange={(event) => setConcurrency(event.target.value)}
                    disabled={running}
                  />
                  <p className="field-hint">
                    1 to {MAX_CONCURRENCY}. Each machine needs its model loaded with at least this
                    many slots.
                  </p>
                </div>
              ) : null}
            </div>
            <details className="sampling">
              <summary>Sampling</summary>
              <div className="run-options">
                {(
                  [
                    ['temperature', 'Temperature'],
                    ['topP', 'Top-p'],
                    ['topK', 'Top-k'],
                    ['minP', 'Min-p'],
                    ['repetitionPenalty', 'Repetition penalty'],
                    ['seed', 'Seed'],
                  ] as const
                ).map(([key, label]) => (
                  <div className="field" key={key}>
                    <label htmlFor={`sampling-${key}`}>{label}</label>
                    <input
                      id={`sampling-${key}`}
                      inputMode="decimal"
                      value={sampling[key]}
                      onChange={(event) =>
                        setSampling((currentSampling) => ({
                          ...currentSampling,
                          [key]: event.target.value,
                        }))
                      }
                      disabled={running || (key === 'seed' && prefill === 'warm')}
                    />
                  </div>
                ))}
              </div>
              <p className="field-hint">
                Every field is sent to every machine. The seed goes out with cold prefill only.
                {cloudModels.length > 0
                  ? ' Cloud models get only the fields their API takes, and newer ones none.'
                  : ''}
              </p>
            </details>
            <PlanFields plan={plan} running={running} sharing={sharing} />
            {thinking && canThink ? (
              <p className="field-hint">
                Max tokens includes the thinking. If a model thinks until the limit, it never
                answers; lower the effort or raise the limit.
              </p>
            ) : null}
            <PreflightPanel
              problem={
                !draft.success
                  ? { text: draft.error.issues[0]?.message ?? 'Check the settings.', error: true }
                  : chosen.length === 0
                    ? { text: 'Pick at least one machine.', error: false }
                    : null
              }
              checking={preflight.current === null}
              error={preflight.current?.error ?? null}
              errors={preflight.errors}
              warnings={preflight.warnings}
              notes={preflight.notes}
              action={slotShortcut}
              clear="All clear: the machines match and the prompt fits."
              details={chosen
                .map((m) => {
                  const tokens = preflight.current?.result?.promptTokens[m.id];
                  return typeof tokens === 'number'
                    ? `${m.name} counts ${tokens.toLocaleString('en-US')} prompt tokens.`
                    : null;
                })
                .filter(Boolean)
                .join(' ')}
              raceAnyway={preflight.raceAnyway}
              setRaceAnyway={preflight.setRaceAnyway}
              running={running}
            />
            {race.formError ? (
              <p className="form-error" role="alert">
                {race.formError}
              </p>
            ) : null}
          </form>
        ) : null}

        <ProgressLine
          session={session}
          running={running}
          roundIndex={race.roundIndex}
          manyRounds={race.manyRounds}
        />
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
                telemetry={
                  cloudIds.has(pane.key)
                    ? undefined
                    : {
                        enabled: telemetry.enabled,
                        status: telemetry.statuses[pane.key],
                        sample: telemetry.latest[pane.key],
                      }
                }
              />
            ))}
          </div>
        ) : null}

        <RaceReport
          race={race}
          details={(run) =>
            run.client ? (
              <>
                <ThroughputTable run={run} />
                <RunMetrics run={run} />
              </>
            ) : null
          }
          votable={votable}
        />

        <SessionList
          sessions={race.summaries}
          currentId={session?.id ?? null}
          onDelete={(target) => race.setDeleting(target)}
        />
        <LogPanel machines={machines ?? []} entries={log} />
      </main>

      {race.deleting ? (
        <ConfirmDialog
          title="Delete this race?"
          message={`The race from ${new Date(race.deleting.createdAt).toLocaleString()} and its results will be removed from this computer.`}
          confirmLabel="Delete race"
          onConfirm={() => (race.deleting ? race.remove(race.deleting) : Promise.resolve())}
          onClose={() => race.setDeleting(null)}
        />
      ) : null}
    </>
  );
}
