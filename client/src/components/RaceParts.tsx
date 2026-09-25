import {
  DEFAULT_PLAN,
  MAX_ROUNDS,
  type MachineView,
  type PreflightIssue,
  type RunPlan,
  type RunView,
  type SessionProgress,
  type SessionView,
  type Workload,
} from '@duel/shared';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { BlindVote } from './BlindVote';
import { RaceCharts } from './RaceCharts';
import { RoundTable } from './RoundTable';
import { ExportLinks, Scoreboard } from './Scoreboard';
import { SetupTable } from './SetupTable';
import { StatsTable } from './StatsTable';

/** The machines to race, each with a line about what it has loaded. */
export function MachinePicker({
  machines,
  selected,
  onToggle,
  running,
  describe,
}: {
  machines: MachineView[];
  selected: string[] | null;
  onToggle: (id: string) => void;
  running: boolean;
  describe: (machine: MachineView) => string;
}) {
  return (
    <fieldset className="chip-group">
      <legend className="hero-label">Machines</legend>
      {machines.map((m) => (
        <label key={m.id} className="chip-radio" style={{ '--machine': m.color } as CSSProperties}>
          <input
            type="checkbox"
            name="machines"
            value={m.id}
            checked={selected?.includes(m.id) ?? false}
            onChange={() => onToggle(m.id)}
            // Enabled once the default choice is made, so it cannot undo a click.
            disabled={running || selected === null}
          />
          <span className="chip-radio-body">
            <span className="chip-radio-name">{m.name}</span>
            <span className="chip-radio-model">{describe(m)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The rounds, warm-up, pause and order fields, kept as text while the user types. */
export function usePlan() {
  const [rounds, setRounds] = useState(String(DEFAULT_PLAN.rounds));
  const [warmup, setWarmup] = useState(DEFAULT_PLAN.warmup);
  const [settleSeconds, setSettleSeconds] = useState(String(DEFAULT_PLAN.settleMs / 1000));
  const [sequencing, setSequencing] = useState(DEFAULT_PLAN.sequencing);
  return {
    rounds,
    setRounds,
    warmup,
    setWarmup,
    settleSeconds,
    setSettleSeconds,
    sequencing,
    setSequencing,
    value: {
      rounds: Number(rounds),
      warmup,
      settleMs: Math.round(Number(settleSeconds) * 1000),
      sequencing,
    } satisfies RunPlan,
    fill: (plan: RunPlan) => {
      setRounds(String(plan.rounds));
      setWarmup(plan.warmup);
      setSettleSeconds(String(plan.settleMs / 1000));
      setSequencing(plan.sequencing);
    },
  };
}

/** Names of chosen machines that share a computer, which should take turns. */
export function sharedHost(chosen: MachineView[], hosts: Record<string, string>): string[] | null {
  const byHost = new Map<string, string[]>();
  for (const m of chosen) {
    const key = hosts[m.id];
    if (key) byHost.set(key, [...(byHost.get(key) ?? []), m.name]);
  }
  return [...byHost.values()].find((names) => names.length > 1) ?? null;
}

function Toggle<T extends string | boolean>({
  labelId,
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  labelId: string;
  label: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="field">
      <span className="field-label" id={labelId}>
        {label}
      </span>
      <div className="toggle-chips" role="radiogroup" aria-labelledby={labelId}>
        {options.map(([option, text]) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={`toggle-chip${value === option ? ' toggle-chip-on' : ''}`}
            onClick={() => onChange(option)}
            disabled={disabled}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PlanFields({
  plan,
  running,
  sharing,
}: {
  plan: ReturnType<typeof usePlan>;
  running: boolean;
  sharing: string[] | null;
}) {
  return (
    <>
      <div className="run-options">
        <div className="field">
          <label htmlFor="run-rounds">Rounds</label>
          <input
            id="run-rounds"
            inputMode="numeric"
            value={plan.rounds}
            onChange={(event) => plan.setRounds(event.target.value)}
            disabled={running}
            aria-describedby="rounds-hint"
          />
          <p className="field-hint" id="rounds-hint">
            1 to {MAX_ROUNDS}. Results are medians.
          </p>
        </div>
        <Toggle
          labelId="warmup-label"
          label="Warm-up"
          options={[
            [true, 'On'],
            [false, 'Off'],
          ]}
          value={plan.warmup}
          onChange={plan.setWarmup}
          disabled={running}
        />
        <div className="field">
          <label htmlFor="run-settle">Pause between rounds, seconds</label>
          <input
            id="run-settle"
            inputMode="decimal"
            value={plan.settleSeconds}
            onChange={(event) => plan.setSettleSeconds(event.target.value)}
            disabled={running}
          />
        </div>
        <Toggle
          labelId="order-label"
          label="Order"
          options={[
            ['concurrent', 'Together'],
            ['sequential', 'Take turns'],
          ]}
          value={plan.sequencing}
          onChange={plan.setSequencing}
          disabled={running}
        />
      </div>
      {sharing && plan.sequencing === 'concurrent' ? (
        <p className="note-warn" data-testid="same-host">
          {sharing.join(' and ')} run on the same computer, so racing them together makes them
          compete for it.{' '}
          <button
            type="button"
            className="btn btn-quiet btn-inline"
            onClick={() => plan.setSequencing('sequential')}
            disabled={running}
          >
            Take turns instead
          </button>
        </p>
      ) : null}
    </>
  );
}

export { Toggle };

/** What pre-flight found, and the Race anyway switch when it only warns. */
export function PreflightPanel({
  problem,
  checking,
  error,
  errors,
  warnings,
  notes = [],
  clear,
  details,
  raceAnyway,
  setRaceAnyway,
  running,
}: {
  /** Why pre-flight cannot run yet: a form error, or no machine picked. */
  problem: { text: string; error: boolean } | null;
  checking: boolean;
  error: string | null;
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
  /** Things to know that never hold a race back. */
  notes?: PreflightIssue[];
  /** What an all-clear means for this workload. */
  clear: string;
  details: string;
  raceAnyway: boolean;
  setRaceAnyway: (on: boolean) => void;
  running: boolean;
}) {
  return (
    <section className="preflight" aria-labelledby="preflight-title" data-testid="preflight">
      <h3 id="preflight-title" className="hero-label">
        Pre-flight
      </h3>
      {problem ? (
        <p className={problem.error ? 'field-error' : 'field-hint'}>{problem.text}</p>
      ) : checking ? (
        <p className="field-hint" data-testid="preflight-status">
          Checking the machines…
        </p>
      ) : error ? (
        <p className="field-error">Pre-flight could not run: {error}</p>
      ) : (
        <>
          <p className="field-hint" data-testid="preflight-status">
            {errors.length > 0
              ? 'This race cannot start.'
              : warnings.length > 0
                ? 'This race can start, but it compares more than the hardware.'
                : clear}{' '}
            {details}
          </p>
          {errors.length > 0 ? (
            <ul className="start-check" data-testid="start-blockers">
              {errors.map((issue) => (
                <li key={issue.text} className="field-error">
                  {issue.text}
                </li>
              ))}
            </ul>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="start-check" data-testid="race-warnings">
              {warnings.map((issue) => (
                <li key={issue.text} className="note-warn">
                  {issue.text}
                </li>
              ))}
            </ul>
          ) : null}
          {notes.length > 0 ? (
            <ul className="start-check" data-testid="race-notes">
              {notes.map((issue) => (
                <li key={issue.text} className="field-hint">
                  {issue.text}
                </li>
              ))}
            </ul>
          ) : null}
          {warnings.length > 0 && errors.length === 0 ? (
            <label className="check-line">
              <input
                type="checkbox"
                checked={raceAnyway}
                onChange={(event) => setRaceAnyway(event.target.checked)}
                disabled={running}
              />
              Race anyway
            </label>
          ) : null}
        </>
      )}
    </section>
  );
}

/** A line about where a running session is. */
function progressText(workload: Workload, progress: SessionProgress, rounds: number): string {
  const round = progress.round === null ? '' : `round ${progress.round + 1} of ${rounds}`;
  switch (progress.phase) {
    case 'preparing':
      return workload === 'transcribe'
        ? 'Reading each machine’s speech-to-text…'
        : workload === 'image'
          ? 'Reading each machine’s image and chat models…'
          : 'Reading each machine’s model…';
    case 'baseline':
      return 'Reading idle power before the first request…';
    case 'loading':
      return `Loading the ${workload === 'image' ? 'image' : 'speech'} model where it is not in memory${round ? `, before ${round}` : ''}. Load time is kept apart.`;
    case 'restoring':
      return 'Loading each machine’s chat model again…';
    case 'warmup':
      return workload === 'transcribe'
        ? 'Warm-up: five seconds of audio per machine, not counted.'
        : workload === 'image'
          ? 'Warm-up: a two-step image per machine, not counted.'
          : 'Warm-up: one short request per machine, not counted.';
    case 'rtt':
      return `Measuring round trips before ${round}.`;
    case 'settling':
      return `Pausing before ${round}.`;
    case 'running':
      return rounds > 1 ? `Running ${round}.` : 'Running.';
    default:
      return '';
  }
}

export function ProgressLine({
  session,
  running,
  roundIndex,
  manyRounds,
}: {
  session: SessionView | null;
  running: boolean;
  roundIndex: number | null;
  manyRounds: boolean;
}) {
  if (session && running) {
    return (
      <p className="race-progress" role="status" data-testid="race-progress">
        {progressText(session.workload, session.progress, session.plan.rounds)}
      </p>
    );
  }
  if (session && roundIndex !== null && manyRounds) {
    return (
      <p className="race-progress" data-testid="race-progress">
        Showing{' '}
        {roundIndex === -1 ? 'the warm-up' : `round ${roundIndex + 1} of ${session.rounds.length}`}.
        Pick another in the round table.
      </p>
    );
  }
  return null;
}

/** Everything under the panes once a race has finished: scores, charts, rounds, setup, exports. */
export function RaceReport({
  race,
  details,
  votable,
}: {
  race: {
    session: SessionView | null;
    running: boolean;
    counted: boolean;
    manyRounds: boolean;
    round: SessionView['warmup'];
    roundIndex: number | null;
    setShownRound: (index: number | null) => void;
    setBlind: (on: boolean) => void;
  };
  /** The measurements of one finished run; null when it has none. */
  details: (run: RunView) => ReactNode | null;
  votable: boolean;
}) {
  const { session, running, counted, manyRounds, round, roundIndex } = race;
  if (!session) return null;
  const measured = (round?.runs ?? [])
    .filter((run) => run.finishedAt !== null)
    .map((run) => ({ run, node: details(run) }))
    .filter((entry) => entry.node !== null);
  const label = roundIndex === -1 ? 'warm-up' : `round ${(roundIndex ?? 0) + 1}`;
  return (
    <>
      {session.state === 'interrupted' ? (
        <div className="banner banner-warn" role="status">
          {session.error}
        </div>
      ) : null}
      {!running && counted ? <Scoreboard session={session} /> : null}
      {!running && round && counted ? (
        <RaceCharts session={session} round={round} label={label} />
      ) : null}
      {!running && counted && (session.machines.length > 1 || session.rounds.length > 1) ? (
        <StatsTable session={session} />
      ) : null}
      {manyRounds ? (
        <RoundTable
          session={session}
          shown={running ? -2 : (roundIndex ?? -2)}
          onShow={(index) => race.setShownRound(index)}
        />
      ) : null}
      {!running
        ? measured.map(({ run, node }) =>
            session.machines.length === 1 && !manyRounds ? (
              <div key={run.id}>{node}</div>
            ) : (
              <details key={run.id} className="panel run-details">
                <summary>
                  Measurements for {run.machineName}
                  {manyRounds ? (roundIndex === -1 ? ', warm-up' : `, ${label}`) : ''}
                </summary>
                {node}
              </details>
            ),
          )
        : null}
      {!running ? <SetupTable session={session} /> : null}
      {!running ? (
        <div className="report-actions">
          <ExportLinks session={session} />
          {votable ? (
            <button type="button" className="btn btn-outline" onClick={() => race.setBlind(true)}>
              Blind vote
            </button>
          ) : null}
          {session.votes.length > 0 ? (
            <span className="muted">
              {session.votes.length} blind {session.votes.length === 1 ? 'vote' : 'votes'} cast
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export { BlindVote };
