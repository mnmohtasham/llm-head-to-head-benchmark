import {
  LIBRISPEECH_CLIP,
  repeatsFor,
  sessionRequestSchema,
  STT_DEVICES,
  STT_MODELS,
  transcribeConfigSchema,
  type MachineView,
  type RunView,
  type SessionView,
  type SttEngineName,
  type SttStatus,
  type TranscribeConfig,
} from '@duel/shared';
import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { api, messageOf, type UploadedAudio } from '../api';
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
import { TranscriptMetrics, TranscriptPane } from '../components/TranscriptPane';
import { formatMsValue } from '../format';
import { usePreflight } from '../usePreflight';
import { useRace } from '../useRace';
import { useTelemetry } from '../useTelemetry';

type AudioKind = TranscribeConfig['audio']['kind'];
type SttRead = { status: SttStatus | null; error: string | null };

const QWEN_ASR = ['qwen3-asr-0.6b', 'qwen3-asr-1.7b'];
const OTHER = 'other';
const modelsFor = (engine: SttEngineName): readonly string[] =>
  engine === 'mtmd' ? QWEN_ASR : STT_MODELS;

const ENGINE_LABEL: Record<SttEngineName, string> = {
  gguf: 'GGUF',
  transformers: 'Transformers',
  mtmd: 'Qwen3-ASR',
};
const ENGINE_HINT: Record<SttEngineName, string> = {
  gguf: 'Whisper on whisper.cpp. Machines without it fall back to transformers.',
  transformers: 'Whisper on PyTorch.',
  mtmd: 'Qwen3-ASR on llama.cpp.',
};

/** The log line for a finished transcription. */
function describeRun(run: RunView): string {
  const t = run.transcription;
  if (!t) return 'Done.';
  const rtf = t.rtf === null ? 'n/a' : `${t.rtf.toFixed(t.rtf < 10 ? 1 : 0)}×`;
  const wer = t.wer ? `, WER ${(t.wer.wer * 100).toFixed(1)}%` : '';
  return `${rtf} real time: ${formatMsValue(t.processingMs)} for ${t.audioSeconds?.toFixed(1) ?? 'n/a'} s of audio, upload ${formatMsValue(t.uploadMs)}${wer}.`;
}

interface Props {
  machines: MachineView[] | null;
  loadError: string | null;
  log: LogEntry[];
  addLog: (entry: NewLogEntry) => void;
}

export function TranscribePage({ machines, loadError, log, addLog }: Props) {
  const [stt, setStt] = useState<Record<string, SttRead>>({});
  const [selected, setSelected] = useState<string[] | null>(null);
  const [audioKind, setAudioKind] = useState<AudioKind>('clip');
  const [minutes, setMinutes] = useState('10');
  const [upload, setUpload] = useState<UploadedAudio | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reference, setReference] = useState('');
  const [engine, setEngine] = useState<SttEngineName>('gguf');
  const [model, setModel] = useState<string>('large-v3-turbo');
  const [customModel, setCustomModel] = useState('');
  const [device, setDevice] = useState<TranscribeConfig['device']>('auto');
  const [language, setLanguage] = useState('en');
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const plan = usePlan();
  const fillPlan = plan.fill;

  const fillForm = useCallback(
    (view: SessionView) => {
      if (view.workload !== 'transcribe') return;
      const { audio } = view.config;
      setAudioKind(audio.kind);
      if (audio.kind === 'long') setMinutes(String(audio.minutes));
      if (audio.kind === 'upload') {
        setUpload({
          id: audio.audioId,
          name: audio.name,
          bytes: 0,
          contentType: '',
          seconds: null,
        });
        setReference(audio.reference ?? '');
      }
      setEngine(view.config.engine);
      if (modelsFor(view.config.engine).includes(view.config.model)) setModel(view.config.model);
      else {
        setModel(OTHER);
        setCustomModel(view.config.model);
      }
      setDevice(view.config.device);
      setLanguage(view.config.language);
      fillPlan(view.plan);
      const known = new Set((machines ?? []).map((m) => m.id));
      const ids = view.machines.map((m) => m.id).filter((id) => known.has(id));
      if (ids.length > 0) setSelected(ids);
    },
    [machines, fillPlan],
  );
  const race = useRace({
    workload: 'transcribe',
    machines,
    addLog,
    describeRun,
    onOpen: fillForm,
  });
  const { session, running } = race;

  useEffect(() => {
    api.machineHosts().then(
      ({ hosts: keys }) => setHosts(keys),
      () => undefined,
    );
  }, [machines]);

  // Each machine's speech-to-text, read again after every race: the sidecar loads and unloads.
  const machineKey = (machines ?? []).map((m) => m.id).join(',');
  useEffect(() => {
    if (running) return;
    for (const id of machineKey.split(',').filter(Boolean)) {
      api.sttStatus(id).then(
        (read) => setStt((current) => ({ ...current, [id]: read })),
        (error: unknown) =>
          setStt((current) => ({ ...current, [id]: { status: null, error: messageOf(error) } })),
      );
    }
  }, [machineKey, running]);

  // Race every machine with speech-to-text, once every status is in.
  useEffect(() => {
    if (selected !== null || !machines?.length) return;
    if (!machines.every((m) => stt[m.id])) return;
    const ready = machines.filter((m) => stt[m.id]?.status?.available).map((m) => m.id);
    setSelected(ready.length > 0 ? ready : machines.slice(0, 1).map((m) => m.id));
  }, [selected, machines, stt]);

  const chosen = (machines ?? []).filter((m) => selected?.includes(m.id));
  const chosenIds = chosen.map((m) => m.id);
  const effectiveModel = model === OTHER ? customModel.trim() : model;
  const draft = transcribeConfigSchema.safeParse({
    audio:
      audioKind === 'clip'
        ? { kind: 'clip' }
        : audioKind === 'long'
          ? { kind: 'long', minutes: Number(minutes) }
          : {
              kind: 'upload',
              audioId: upload?.id ?? '',
              name: upload?.name ?? '',
              reference: reference.trim() || null,
            },
    model: effectiveModel,
    engine,
    device,
    language,
  });
  const preflightKey = draft.success
    ? JSON.stringify({ workload: 'transcribe', machineIds: chosenIds, config: draft.data })
    : null;
  const preflight = usePreflight(preflightKey, running || uploading);
  const blocked = !draft.success || chosen.length === 0 || uploading || preflight.stops;
  const sharing = sharedHost(chosen, hosts);

  const toggle = (id: string) => {
    setSelected((current) => {
      const list = current ?? [];
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });
  };

  const pickEngine = (next: SttEngineName) => {
    setEngine(next);
    if (model !== OTHER && !modelsFor(next).includes(model)) {
      setModel(next === 'mtmd' ? 'qwen3-asr-0.6b' : 'large-v3-turbo');
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    race.setFormError(null);
    setUploading(true);
    try {
      const saved = await api.uploadAudio(file);
      setUpload(saved);
      addLog({
        machineName: null,
        color: null,
        tone: 'info',
        text: `Audio ready: ${saved.name}, ${(saved.bytes / 1_000_000).toFixed(1)} MB${saved.seconds ? `, ${saved.seconds.toFixed(1)} s` : ''}.`,
      });
    } catch (error) {
      race.setFormError(`The upload failed. ${messageOf(error)}`);
    } finally {
      setUploading(false);
    }
  };

  const start = async (event?: FormEvent) => {
    event?.preventDefault();
    race.setFormError(null);
    if (!draft.success) {
      race.setFormError(draft.error.issues[0]?.message ?? 'Check the settings.');
      return;
    }
    const parsed = sessionRequestSchema.safeParse({
      workload: 'transcribe',
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
  const loadedModel = (id: string) => {
    const status = stt[id]?.status;
    return status?.loadedModel ? `${status.loadedModel} · ${status.loadedEngine ?? ''}` : null;
  };
  const panes = session
    ? session.machines.map((m, i) => ({
        key: m.id,
        machine: machines?.find((x) => x.id === m.id) ?? m,
        run: round?.runs[i] ?? null,
        model: null,
      }))
    : chosen.map((m) => ({ key: m.id, machine: m, run: null, model: loadedModel(m.id) }));
  const telemetry = useTelemetry(panes.map((pane) => pane.key));
  const columns = Math.min(Math.max(panes.length, 1), 4);
  const audio = preflight.current?.result?.audio ?? null;
  const onDisk = chosen
    .filter((m) => stt[m.id]?.status?.engines[engine].downloaded.includes(effectiveModel))
    .map((m) => m.name);

  return (
    <>
      <TopBar
        title="Transcribe"
        current="transcribe"
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
                const read = stt[m.id];
                if (!read) return 'checking…';
                if (read.error || !read.status) return read.error ? 'unreachable' : 'checking…';
                if (!read.status.available) return 'no speech-to-text';
                return read.status.loadedModel
                  ? `${read.status.loadedModel} on ${read.status.loadedEngine ?? 'unknown'} in memory`
                  : 'no speech model in memory';
              }}
            />

            <div className="field audio-source">
              <Toggle
                labelId="audio-label"
                label="Audio"
                options={[
                  ['clip', `LibriSpeech clip, ${Math.round(LIBRISPEECH_CLIP.seconds)} s`],
                  ['long', 'Long audio'],
                  ['upload', 'Upload a file'],
                ]}
                value={audioKind}
                onChange={setAudioKind}
                disabled={running}
              />
              {audioKind === 'upload' ? (
                <>
                  <input
                    type="file"
                    aria-label="Audio file"
                    accept="audio/*,video/*,.wav,.mp3,.flac,.m4a,.ogg,.opus,.webm"
                    onChange={(event) => void onFile(event)}
                    disabled={running || uploading}
                  />
                  <p className="field-hint" data-testid="upload-status">
                    {uploading
                      ? 'Uploading to Model Duel…'
                      : upload
                        ? `${upload.name}${upload.bytes ? `, ${(upload.bytes / 1_000_000).toFixed(1)} MB` : ''}${upload.seconds ? `, ${upload.seconds.toFixed(1)} s` : ''}. Every machine gets the same file.`
                        : 'WAV, MP3, FLAC, M4A, OGG or WebM, up to 256 MB. It stays on this computer and goes to each machine in turn or together, as the race says.'}
                  </p>
                  <label className="field-label" htmlFor="audio-reference">
                    What was said, for the word error rate (optional)
                  </label>
                  <textarea
                    id="audio-reference"
                    rows={3}
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    disabled={running}
                    placeholder="Paste the exact words, or leave empty to skip the word error rate."
                  />
                </>
              ) : (
                <>
                  {audioKind === 'long' ? (
                    <div className="field">
                      <label htmlFor="audio-minutes">Minutes, at least</label>
                      <input
                        id="audio-minutes"
                        inputMode="numeric"
                        value={minutes}
                        onChange={(event) => setMinutes(event.target.value)}
                        disabled={running}
                      />
                      <p className="field-hint">
                        The clip repeated{' '}
                        {Number.isInteger(Number(minutes)) && Number(minutes) >= 1
                          ? `${repeatsFor(Number(minutes))} times`
                          : ''}{' '}
                        into one file, 1 to 30 minutes, to show how speed holds up on long audio.
                      </p>
                    </div>
                  ) : null}
                  <audio
                    controls
                    preload="none"
                    src={api.clipUrl}
                    aria-label="Listen to the clip"
                  />
                  <details>
                    <summary className="field-hint">What is said in the clip</summary>
                    <p className="audio-reference">{LIBRISPEECH_CLIP.reference.toLowerCase()}</p>
                  </details>
                  <p className="field-hint">
                    From LibriSpeech test-clean (speaker {LIBRISPEECH_CLIP.speaker}, CC BY 4.0),
                    with its checked transcript for the word error rate.
                  </p>
                </>
              )}
            </div>

            <div className="run-options">
              <div className="field">
                <Toggle
                  labelId="engine-label"
                  label="Engine"
                  options={(['gguf', 'transformers', 'mtmd'] as const).map(
                    (e) => [e, ENGINE_LABEL[e]] as const,
                  )}
                  value={engine}
                  onChange={pickEngine}
                  disabled={running}
                />
                <p className="field-hint">{ENGINE_HINT[engine]}</p>
              </div>
              <div className="field">
                <label htmlFor="stt-model">Model</label>
                <select
                  id="stt-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={running}
                >
                  {modelsFor(engine).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value={OTHER}>Other: a Hugging Face id</option>
                </select>
                {model === OTHER ? (
                  <input
                    aria-label="Hugging Face model id"
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    placeholder="owner/model"
                    disabled={running}
                  />
                ) : null}
                <p className="field-hint" data-testid="model-on-disk">
                  {chosen.length === 0
                    ? ''
                    : onDisk.length === chosen.length
                      ? `On disk on every machine for ${engine}.`
                      : onDisk.length > 0
                        ? `On disk for ${engine} on ${onDisk.join(', ')} only.`
                        : `Not on disk for ${engine} on any picked machine.`}
                </p>
              </div>
              <Toggle
                labelId="device-label"
                label="Device"
                options={STT_DEVICES.map(
                  (d) => [d, d === 'auto' ? 'Best' : d.toUpperCase()] as const,
                )}
                value={device}
                onChange={setDevice}
                disabled={running}
              />
              <div className="field">
                <label htmlFor="stt-language">Language</label>
                <input
                  id="stt-language"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  disabled={running}
                />
              </div>
              <TelemetrySwitch enabled={telemetry.enabled} onError={race.setFormError} />
            </div>

            <PlanFields plan={plan} running={running} sharing={sharing} />
            <PreflightPanel
              problem={
                uploading
                  ? { text: 'Waiting for the upload…', error: false }
                  : !draft.success
                    ? { text: draft.error.issues[0]?.message ?? 'Check the settings.', error: true }
                    : chosen.length === 0
                      ? { text: 'Pick at least one machine.', error: false }
                      : null
              }
              checking={preflight.current === null}
              error={preflight.current?.error ?? null}
              errors={preflight.errors}
              warnings={preflight.warnings}
              clear="All clear: every machine has the model on disk and runs the same engine."
              details={
                audio
                  ? `The audio is ${audio.name}, ${audio.seconds === null ? 'length unknown' : `${audio.seconds.toFixed(1)} s`}, ${(audio.bytes / 1_000_000).toFixed(1)} MB.`
                  : ''
              }
              raceAnyway={preflight.raceAnyway}
              setRaceAnyway={preflight.setRaceAnyway}
              running={running}
            />
            <p className="field-hint">
              A model that is not in memory is loaded before each round that needs it, and that time
              is shown apart. Unsloth unloads a speech model after five idle minutes.
            </p>
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
              <TranscriptPane
                key={pane.key}
                machine={pane.machine}
                modelName={pane.model}
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
          details={(run) => (run.transcription ? <TranscriptMetrics run={run} /> : null)}
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
