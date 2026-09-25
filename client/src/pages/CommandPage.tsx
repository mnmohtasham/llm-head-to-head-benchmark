import {
  COMMAND_TEMPLATES,
  commandConfigSchema,
  sessionRequestSchema,
  TEMPLATE_INFO,
  X265_PRESETS,
  type AgentHealth,
  type CommandConfig,
  type CommandTemplate,
  type MachineView,
  type RunView,
  type SessionView,
} from '@duel/shared';
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { api, messageOf } from '../api';
import { CommandMetrics, CommandPane } from '../components/CommandPane';
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
import { SessionList } from '../components/SessionList';
import { TelemetrySwitch } from '../components/TelemetryChips';
import { TopBar } from '../components/TopBar';
import { formatMsValue } from '../format';
import { usePreflight } from '../usePreflight';
import { useRace } from '../useRace';
import { useTelemetry } from '../useTelemetry';

type AgentRead = { health: AgentHealth | null; error: string | null };

/** The log line for a finished encode. */
function describeRun(run: RunView): string {
  const c = run.command;
  if (!c) return 'Done.';
  return `${c.fps === null ? 'n/a' : c.fps.toFixed(0)} fps, ${c.speed === null ? 'n/a' : `${c.speed.toFixed(1)}×`} real time, ${formatMsValue(c.wallMs)} with ${c.encoder ?? 'an unknown encoder'}.`;
}

interface Props {
  machines: MachineView[] | null;
  loadError: string | null;
  log: LogEntry[];
  addLog: (entry: NewLogEntry) => void;
}

export function CommandPage({ machines, loadError, log, addLog }: Props) {
  const [agents, setAgents] = useState<Record<string, AgentRead>>({});
  const [selected, setSelected] = useState<string[] | null>(null);
  const [template, setTemplate] = useState<CommandTemplate>('hevc-hardware');
  const [clip, setClip] = useState<string | null>(null);
  const [bitrate, setBitrate] = useState('10');
  const [crf, setCrf] = useState('28');
  const [preset, setPreset] = useState<CommandConfig['x265Preset']>('medium');
  const [maxSeconds, setMaxSeconds] = useState('');
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const plan = usePlan();
  const fillPlan = plan.fill;

  const fillForm = useCallback(
    (view: SessionView) => {
      if (view.workload !== 'command') return;
      const c = view.config;
      setTemplate(c.template);
      setClip(c.clip);
      setBitrate(String(c.bitrateMbps));
      setCrf(String(c.crf));
      setPreset(c.x265Preset);
      setMaxSeconds(c.maxSeconds === null ? '' : String(c.maxSeconds));
      fillPlan(view.plan);
      const known = new Set((machines ?? []).map((m) => m.id));
      const ids = view.machines.map((m) => m.id).filter((id) => known.has(id));
      if (ids.length > 0) setSelected(ids);
    },
    [machines, fillPlan],
  );
  const race = useRace({ workload: 'command', machines, addLog, describeRun, onOpen: fillForm });
  const { session, running } = race;

  useEffect(() => {
    api.machineHosts().then(
      ({ hosts: keys }) => setHosts(keys),
      () => undefined,
    );
  }, [machines]);

  // Each machine's agent, read again after every race.
  const machineKey = (machines ?? []).map((m) => `${m.id}:${m.agentUrl ?? ''}`).join(',');
  useEffect(() => {
    if (running) return;
    for (const entry of machineKey.split(',').filter(Boolean)) {
      const [id = '', url] = entry.split(/:(.*)/s);
      if (!url) {
        setAgents((current) => ({ ...current, [id]: { health: null, error: 'no agent' } }));
        continue;
      }
      api.agentInfo(id).then(
        (read) =>
          setAgents((current) => ({
            ...current,
            [id]: { health: read.health, error: read.error },
          })),
        (error: unknown) =>
          setAgents((current) => ({ ...current, [id]: { health: null, error: messageOf(error) } })),
      );
    }
  }, [machineKey, running]);

  // Race every machine with an agent that answers, once every agent is read.
  useEffect(() => {
    if (selected !== null || !machines?.length) return;
    if (!machines.every((m) => agents[m.id])) return;
    const ready = machines.filter((m) => agents[m.id]?.health).map((m) => m.id);
    setSelected(ready.length > 0 ? ready : machines.slice(0, 1).map((m) => m.id));
  }, [selected, machines, agents]);

  const chosen = (machines ?? []).filter((m) => selected?.includes(m.id));
  const chosenIds = chosen.map((m) => m.id);
  const healths = chosen.map((m) => agents[m.id]?.health ?? null);
  const anyFake = healths.some((h) => h?.fake);
  const templates = COMMAND_TEMPLATES.filter((t) => t !== 'fake' || anyFake);
  // Clips by name across the picked agents, and how many have each.
  const clipCounts = new Map<string, number>();
  for (const h of healths)
    for (const c of h?.clips ?? []) clipCounts.set(c.name, (clipCounts.get(c.name) ?? 0) + 1);
  const clipNames = [...clipCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  // Pick the clip every agent has once the lists are in, and the fake one for fake agents.
  useEffect(() => {
    if (clip !== null || clipNames.length === 0) return;
    const fake = healths.every((h) => h?.fake);
    if (fake) setTemplate('fake');
    setClip(fake ? 'fake-clip.mp4' : (clipNames[0] ?? null));
  }, [clip, clipNames, healths]);

  const draft = commandConfigSchema.safeParse({
    template,
    clip: clip ?? '',
    bitrateMbps: Number(bitrate),
    crf: Number(crf),
    x265Preset: preset,
    maxSeconds: maxSeconds.trim() ? Number(maxSeconds) : null,
  });
  const preflightKey = draft.success
    ? JSON.stringify({ workload: 'command', machineIds: chosenIds, config: draft.data })
    : null;
  const preflight = usePreflight(preflightKey, running);
  const blocked = !draft.success || chosen.length === 0 || preflight.stops;
  const sharing = sharedHost(chosen, hosts);

  const toggle = (id: string) => {
    setSelected((list) => {
      const now = list ?? [];
      return now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
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
      workload: 'command',
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
    if (refused?.issues) preflight.showIssues(refused.issues);
  };

  const encoderOf = (id: string) =>
    agents[id]?.health?.templates.find((t) => t.id === template)?.encoder ?? null;
  const round = race.round;
  const panes = session
    ? session.machines.map((m, i) => ({
        key: m.id,
        machine: machines?.find((x) => x.id === m.id) ?? m,
        run: round?.runs[i] ?? null,
        encoder: null,
      }))
    : chosen.map((m) => ({ key: m.id, machine: m, run: null, encoder: encoderOf(m.id) }));
  const telemetry = useTelemetry(panes.map((pane) => pane.key));
  const columns = Math.min(Math.max(panes.length, 1), 4);
  const clipInfo = healths.flatMap((h) => h?.clips ?? []).find((c) => c.name === clip);

  return (
    <>
      <TopBar
        title="Command"
        current="command"
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
                const read = agents[m.id];
                if (!m.agentUrl) return 'no agent';
                if (!read) return 'checking…';
                if (!read.health) return read.error ?? 'agent not answering';
                const h = read.health;
                return h.ffmpeg
                  ? `ffmpeg ${h.ffmpeg.version}${h.fake ? ', fake' : ''}`
                  : h.fake
                    ? 'fake agent'
                    : 'no ffmpeg';
              }}
            />

            <div className="field">
              <Toggle
                labelId="template-label"
                label="Encode"
                options={templates.map((t) => [t, TEMPLATE_INFO[t].label] as const)}
                value={template}
                onChange={setTemplate}
                disabled={running}
              />
              <p className="field-hint" data-testid="template-hint">
                {TEMPLATE_INFO[template].description}{' '}
                {chosen
                  .map((m) => {
                    const t = agents[m.id]?.health?.templates.find((x) => x.id === template);
                    return t ? `${m.name}: ${t.encoder ?? 'cannot run it'}.` : null;
                  })
                  .filter(Boolean)
                  .join(' ')}
              </p>
            </div>

            <div className="run-options">
              <div className="field">
                <label htmlFor="command-clip">Clip</label>
                <select
                  id="command-clip"
                  value={clip ?? ''}
                  onChange={(event) => setClip(event.target.value)}
                  disabled={running || clipNames.length === 0}
                >
                  {clipNames.length === 0 ? <option value="">No clips found</option> : null}
                  {clipNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                      {(clipCounts.get(name) ?? 0) < chosen.length
                        ? ` (on ${clipCounts.get(name)} of ${chosen.length})`
                        : ''}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  {clipInfo
                    ? `${clipInfo.width ?? '?'}×${clipInfo.height ?? '?'}, ${clipInfo.frames ?? '?'} frames, ${clipInfo.durationSec?.toFixed(1) ?? '?'} s. `
                    : ''}
                  Clips live in each agent&apos;s clips folder; npm run agent -- --make-clip makes
                  one.
                </p>
              </div>
              {template === 'hevc-hardware' ? (
                <div className="field">
                  <label htmlFor="command-bitrate">Bitrate, Mbit/s</label>
                  <input
                    id="command-bitrate"
                    inputMode="numeric"
                    value={bitrate}
                    onChange={(event) => setBitrate(event.target.value)}
                    disabled={running}
                  />
                </div>
              ) : null}
              {template === 'x265' ? (
                <>
                  <div className="field">
                    <label htmlFor="command-crf">CRF</label>
                    <input
                      id="command-crf"
                      inputMode="numeric"
                      value={crf}
                      onChange={(event) => setCrf(event.target.value)}
                      disabled={running}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="command-preset">x265 preset</label>
                    <select
                      id="command-preset"
                      value={preset}
                      onChange={(event) =>
                        setPreset(event.target.value as CommandConfig['x265Preset'])
                      }
                      disabled={running}
                    >
                      {X265_PRESETS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : null}
              <div className="field">
                <label htmlFor="command-seconds">Only the first seconds</label>
                <input
                  id="command-seconds"
                  inputMode="numeric"
                  value={maxSeconds}
                  onChange={(event) => setMaxSeconds(event.target.value)}
                  placeholder="all of it"
                  disabled={running}
                />
              </div>
              <TelemetrySwitch enabled={telemetry.enabled} onError={race.setFormError} />
            </div>

            <PlanFields plan={plan} running={running} sharing={sharing} />
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
              clear="All clear: every agent is free and has the encoder and the same clip."
              details=""
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
              <CommandPane
                key={pane.key}
                machine={pane.machine}
                encoder={pane.encoder}
                run={pane.run}
                telemetry={{
                  enabled: telemetry.enabled,
                  status: telemetry.statuses[pane.key],
                  sample: telemetry.latest[pane.key],
                }}
              />
            ))}
          </div>
        ) : null}

        <RaceReport
          race={race}
          details={(run) => (run.command ? <CommandMetrics run={run} /> : null)}
          votable={false}
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
