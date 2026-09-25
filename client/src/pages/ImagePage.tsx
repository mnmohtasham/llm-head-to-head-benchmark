import {
  IMAGE_MEMORY_MODES,
  IMAGE_PRESETS,
  imageConfigSchema,
  sessionRequestSchema,
  type ImageConfig,
  type ImageModelView,
  type ImagePresetId,
  type ImageSpeedMode,
  type ImageStatus,
  type MachineView,
  type RunView,
  type SessionView,
} from '@duel/shared';
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { api, messageOf } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ImageMetrics, ImagePane } from '../components/ImagePane';
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

interface MachineImage {
  status: ImageStatus | null;
  error: string | null;
  models: ImageModelView[] | null;
}

const SIZES: ReadonlyArray<readonly [string, number, number]> = [
  ['512²', 512, 512],
  ['768²', 768, 768],
  ['1024²', 1024, 1024],
  ['1024×576', 1024, 576],
];

const SPEED_LABEL: Record<ImageSpeedMode, string> = {
  off: 'Off',
  eager: 'Eager',
  default: 'Default',
  max: 'Max',
};

/** The log line for a finished image. */
function describeRun(run: RunView): string {
  const image = run.image;
  if (!image) return 'Done.';
  return `${(image.totalMs / 1000).toFixed(1)} s for the image, ${image.stepsPerSec === null ? 'n/a' : image.stepsPerSec.toFixed(2)} steps/s, first step ${formatMsValue(image.firstStepMs)}, decode ${formatMsValue(image.decodeTailMs)}.`;
}

interface Props {
  machines: MachineView[] | null;
  loadError: string | null;
  log: LogEntry[];
  addLog: (entry: NewLogEntry) => void;
}

export function ImagePage({ machines, loadError, log, addLog }: Props) {
  const [info, setInfo] = useState<Record<string, MachineImage>>({});
  const [chat, setChat] = useState<Record<string, string | null>>({});
  const [selected, setSelected] = useState<string[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [preset, setPreset] = useState<ImagePresetId>('lighthouse');
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [width, setWidth] = useState('1024');
  const [height, setHeight] = useState('1024');
  const [steps, setSteps] = useState('9');
  const [guidance, setGuidance] = useState('0');
  const [seed, setSeed] = useState('42');
  const [memoryMode, setMemoryMode] = useState<ImageConfig['memoryMode']>('auto');
  const [speedMode, setSpeedMode] = useState<ImageSpeedMode>('off');
  const [restoreText, setRestoreText] = useState(true);
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const plan = usePlan();
  const fillPlan = plan.fill;

  const fillForm = useCallback(
    (view: SessionView) => {
      if (view.workload !== 'image') return;
      const c = view.config;
      setModel(c.model);
      setFile(c.ggufFilename);
      setPreset(c.preset);
      if (c.preset === 'custom') setPrompt(c.prompt);
      setNegative(c.negativePrompt);
      setWidth(String(c.width));
      setHeight(String(c.height));
      setSteps(String(c.steps));
      setGuidance(String(c.guidance));
      setSeed(String(c.seed));
      setMemoryMode(c.memoryMode);
      setSpeedMode(c.speedMode);
      setRestoreText(c.restoreText);
      fillPlan(view.plan);
      const known = new Set((machines ?? []).map((m) => m.id));
      const ids = view.machines.map((m) => m.id).filter((id) => known.has(id));
      if (ids.length > 0) setSelected(ids);
    },
    [machines, fillPlan],
  );
  const race = useRace({ workload: 'image', machines, addLog, describeRun, onOpen: fillForm });
  const { session, running } = race;

  useEffect(() => {
    api.machineHosts().then(
      ({ hosts: keys }) => setHosts(keys),
      () => undefined,
    );
  }, [machines]);

  // Each machine's image model and chat model, read again after every race.
  const machineKey = (machines ?? []).map((m) => m.id).join(',');
  useEffect(() => {
    if (running) return;
    for (const id of machineKey.split(',').filter(Boolean)) {
      api.imageInfo(id).then(
        (read) =>
          setInfo((current) => ({
            ...current,
            [id]: { status: read.status, error: read.error, models: read.models },
          })),
        (error: unknown) =>
          setInfo((current) => ({
            ...current,
            [id]: { status: null, error: messageOf(error), models: null },
          })),
      );
      api.machineStatus(id).then(
        (view) => setChat((current) => ({ ...current, [id]: view.status?.activeModel ?? null })),
        () => setChat((current) => ({ ...current, [id]: null })),
      );
    }
  }, [machineKey, running]);

  // Race every machine that can make images, once every status is in.
  useEffect(() => {
    if (selected !== null || !machines?.length) return;
    if (!machines.every((m) => info[m.id])) return;
    const ready = machines.filter((m) => info[m.id]?.status).map((m) => m.id);
    setSelected(ready.length > 0 ? ready : machines.slice(0, 1).map((m) => m.id));
  }, [selected, machines, info]);

  const chosen = (machines ?? []).filter((m) => selected?.includes(m.id));
  const chosenIds = chosen.map((m) => m.id);

  // Models on any picked machine, and on which ones each file is.
  const catalog = new Map<string, { model: ImageModelView; on: Set<string> }>();
  for (const m of chosen) {
    for (const entry of info[m.id]?.models ?? []) {
      const key = entry.repoId.toLowerCase();
      const known = catalog.get(key);
      if (known) {
        known.on.add(m.id);
        for (const f of entry.files) {
          if (!known.model.files.some((x) => x.filename === f.filename)) {
            known.model = { ...known.model, files: [...known.model.files, f] };
          }
        }
      } else catalog.set(key, { model: entry, on: new Set([m.id]) });
    }
  }
  const options = [...catalog.values()].sort(
    (a, b) => b.on.size - a.on.size || a.model.repoId.localeCompare(b.model.repoId),
  );
  const current =
    options.find((o) => o.model.repoId.toLowerCase() === model?.toLowerCase()) ?? null;
  const machinesWithFile = (filename: string) =>
    chosen.filter((m) =>
      info[m.id]?.models?.some(
        (x) =>
          x.repoId.toLowerCase() === model?.toLowerCase() &&
          x.files.some((f) => f.filename === filename),
      ),
    );

  // Pick the model and file every machine has, once the lists are in.
  useEffect(() => {
    if (model !== null || options.length === 0) return;
    const first = options[0];
    if (!first) return;
    setModel(first.model.repoId);
    const common =
      first.model.files.find((f) => f.quant?.toUpperCase() === 'Q4_K_M') ?? first.model.files[0];
    setFile(first.model.format === 'gguf' ? (common?.filename ?? null) : null);
  }, [model, options]);

  const draft = imageConfigSchema.safeParse({
    model: model ?? '',
    ggufFilename: current?.model.format === 'pipeline' ? null : file,
    preset,
    prompt: preset === 'custom' ? prompt : '',
    negativePrompt: negative,
    width: Number(width),
    height: Number(height),
    steps: Number(steps),
    guidance: Number(guidance),
    seed: Number(seed),
    memoryMode,
    speedMode,
    restoreText,
  });
  const preflightKey = draft.success
    ? JSON.stringify({ workload: 'image', machineIds: chosenIds, config: draft.data })
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
      workload: 'image',
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

  const round = race.round;
  const residentModel = (id: string) => {
    const status = info[id]?.status;
    return status?.loaded ? `${status.repoId ?? 'an image model'} in memory` : null;
  };
  const panes = session
    ? session.machines.map((m, i) => ({
        key: m.id,
        machine: machines?.find((x) => x.id === m.id) ?? m,
        run: round?.runs[i] ?? null,
        model: null,
      }))
    : chosen.map((m) => ({ key: m.id, machine: m, run: null, model: residentModel(m.id) }));
  const telemetry = useTelemetry(panes.map((pane) => pane.key));
  const columns = Math.min(Math.max(panes.length, 1), 4);
  const size =
    session?.workload === 'image'
      ? { width: session.config.width, height: session.config.height }
      : { width: Number(width) || 1024, height: Number(height) || 1024 };
  const presetPrompt = IMAGE_PRESETS.find((p) => p.id === preset)?.prompt ?? '';

  return (
    <>
      <TopBar
        title="Image"
        current="image"
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
                const read = info[m.id];
                if (!read) return 'checking…';
                if (!read.status) return read.error ? 'no image generation' : 'checking…';
                if (read.status.loaded) {
                  return `${read.status.repoId?.split('/').pop() ?? 'image model'} in memory`;
                }
                const text = chat[m.id];
                return text ? `chat: ${text.split('/').pop() ?? text}` : 'nothing loaded';
              }}
            />

            <div className="run-options">
              <div className="field">
                <label htmlFor="image-model">Model</label>
                <select
                  id="image-model"
                  value={current?.model.repoId ?? ''}
                  onChange={(event) => {
                    const next = options.find((o) => o.model.repoId === event.target.value);
                    setModel(event.target.value);
                    setFile(
                      next?.model.format === 'gguf'
                        ? (next.model.files[0]?.filename ?? null)
                        : null,
                    );
                  }}
                  disabled={running || options.length === 0}
                >
                  {options.length === 0 ? <option value="">No image models found</option> : null}
                  {options.map((o) => (
                    <option key={o.model.repoId} value={o.model.repoId}>
                      {o.model.displayName}
                      {o.on.size < chosen.length ? ` (on ${o.on.size} of ${chosen.length})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              {current?.model.format === 'gguf' ? (
                <div className="field">
                  <label htmlFor="image-file">Quant</label>
                  <select
                    id="image-file"
                    value={file ?? ''}
                    onChange={(event) => setFile(event.target.value)}
                    disabled={running}
                  >
                    {current.model.files.map((f) => {
                      const on = machinesWithFile(f.filename).length;
                      return (
                        <option key={f.filename} value={f.filename}>
                          {f.quant ?? f.filename}
                          {f.sizeBytes ? `, ${(f.sizeBytes / 1e9).toFixed(1)} GB` : ''}
                          {on < chosen.length ? ` (on ${on} of ${chosen.length})` : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : current ? (
                <p className="field-hint">Loads as a diffusers pipeline.</p>
              ) : null}
              <div className="field">
                <label htmlFor="image-memory">Memory mode</label>
                <select
                  id="image-memory"
                  value={memoryMode}
                  onChange={(event) =>
                    setMemoryMode(event.target.value as ImageConfig['memoryMode'])
                  }
                  disabled={running}
                >
                  {IMAGE_MEMORY_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === 'low_vram' ? 'low VRAM' : mode}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <Toggle
                  labelId="speed-label"
                  label="Speed mode"
                  options={(['off', 'eager', 'default', 'max'] as const).map(
                    (mode) => [mode, SPEED_LABEL[mode]] as const,
                  )}
                  value={speedMode}
                  onChange={setSpeedMode}
                  disabled={running}
                />
                <p className="field-hint">
                  {speedMode === 'off'
                    ? 'The baseline: no compiling, the same pixels every time.'
                    : 'Compiles during the first images; keep the warm-up on.'}
                </p>
              </div>
            </div>

            <div className="field">
              <Toggle
                labelId="image-prompt-label"
                label="Prompt"
                options={IMAGE_PRESETS.map((p) => [p.id, p.label] as const)}
                value={preset}
                onChange={setPreset}
                disabled={running}
              />
              {preset === 'custom' ? (
                <textarea
                  aria-label="Custom prompt"
                  rows={3}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  disabled={running}
                />
              ) : (
                <p className="preset-preview field-hint" data-testid="image-prompt">
                  {presetPrompt}
                </p>
              )}
              <details>
                <summary className="field-hint">Negative prompt</summary>
                <textarea
                  aria-label="Negative prompt"
                  rows={2}
                  value={negative}
                  onChange={(event) => setNegative(event.target.value)}
                  disabled={running}
                  placeholder="What to leave out. Some models ignore it."
                />
              </details>
            </div>

            <div className="field">
              <span className="field-label" id="size-label">
                Size
              </span>
              <div className="size-inputs" role="group" aria-labelledby="size-label">
                {SIZES.map(([label, w, h]) => (
                  <button
                    key={label}
                    type="button"
                    className={`toggle-chip${Number(width) === w && Number(height) === h ? ' toggle-chip-on' : ''}`}
                    aria-pressed={Number(width) === w && Number(height) === h}
                    onClick={() => {
                      setWidth(String(w));
                      setHeight(String(h));
                    }}
                    disabled={running}
                  >
                    {label}
                  </button>
                ))}
                <input
                  aria-label="Width"
                  inputMode="numeric"
                  value={width}
                  onChange={(event) => setWidth(event.target.value)}
                  disabled={running}
                />
                ×
                <input
                  aria-label="Height"
                  inputMode="numeric"
                  value={height}
                  onChange={(event) => setHeight(event.target.value)}
                  disabled={running}
                />
              </div>
            </div>
            <div className="run-options">
              <div className="field">
                <label htmlFor="image-steps">Steps</label>
                <input
                  id="image-steps"
                  inputMode="numeric"
                  value={steps}
                  onChange={(event) => setSteps(event.target.value)}
                  disabled={running}
                />
              </div>
              <div className="field">
                <label htmlFor="image-guidance">Guidance</label>
                <input
                  id="image-guidance"
                  inputMode="decimal"
                  value={guidance}
                  onChange={(event) => setGuidance(event.target.value)}
                  disabled={running}
                />
              </div>
              <div className="field">
                <label htmlFor="image-seed">Seed</label>
                <input
                  id="image-seed"
                  inputMode="numeric"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value)}
                  disabled={running}
                />
              </div>
              <TelemetrySwitch enabled={telemetry.enabled} onError={race.setFormError} />
            </div>
            <p className="field-hint">
              Unsloth&apos;s defaults are 9 steps and guidance 0, which suit distilled models such
              as FLUX.2 klein. Guidance above 0 runs the model twice a step on some families.
            </p>

            <label className="check-line">
              <input
                type="checkbox"
                checked={restoreText}
                onChange={(event) => setRestoreText(event.target.checked)}
                disabled={running}
              />
              Load each machine&apos;s chat model again after the race
            </label>
            <p className="field-hint">
              An image model and a chat model do not share a GPU in Unsloth: loading the image model
              unloads the chat model on that machine.
            </p>

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
              clear="All clear: every machine has the model on disk."
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
              <ImagePane
                key={pane.key}
                machine={pane.machine}
                modelName={pane.model}
                sessionId={session?.id ?? null}
                run={pane.run}
                size={size}
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
          details={(run) => (run.image ? <ImageMetrics run={run} /> : null)}
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
          message={`The race from ${new Date(race.deleting.createdAt).toLocaleString()}, its results and its images will be removed from this computer.`}
          confirmLabel="Delete race"
          onConfirm={() => (race.deleting ? race.remove(race.deleting) : Promise.resolve())}
          onClose={() => race.setDeleting(null)}
        />
      ) : null}
    </>
  );
}
