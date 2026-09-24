import type { RoundView, RunView, SessionView } from '@duel/shared';
import type { CSSProperties } from 'react';
import { formatMsValue, formatRate, formatSeconds } from '../format';

function cell(run: RunView | undefined): string {
  if (!run) return 'n/a';
  if (run.state !== 'done') return run.state === 'queued' ? 'waiting' : run.state;
  const c = run.client;
  const first =
    c?.firstAnswerMs === null || c?.firstAnswerMs === undefined
      ? 'no answer'
      : `${formatSeconds(c.firstAnswerMs)} s`;
  return `${first} · ${formatRate(c?.decodeTokPerSec, 'tok/s')}`;
}

function Row({
  session,
  round,
  label,
  selected,
  onSelect,
}: {
  session: SessionView;
  round: RoundView;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr className={selected ? 'round-selected' : undefined} data-testid="round-row">
      <th scope="row">
        <button type="button" className="round-pick" onClick={onSelect} aria-pressed={selected}>
          {label}
        </button>
      </th>
      {session.machines.map((machine) => {
        const run = round.runs.find((r) => r.machineId === machine.id);
        return (
          <td key={machine.id} data-machine={machine.name}>
            {cell(run)}
            {run?.rtt?.medianMs !== null && run?.rtt?.medianMs !== undefined ? (
              <span className="cell-detail">RTT {formatMsValue(run.rtt.medianMs)}</span>
            ) : null}
          </td>
        );
      })}
      <td className="round-flags">
        {round.flags.length === 0 ? '' : round.flags.map((flag) => flag.text).join(' ')}
      </td>
    </tr>
  );
}

/**
 * One row per round: each machine's first answer word, speed and round trip. Picking a row shows
 * that round in the panes above.
 */
export function RoundTable({
  session,
  shown,
  onShow,
}: {
  session: SessionView;
  /** Index of the round shown in the panes; -1 is the warm-up. */
  shown: number;
  onShow: (index: number) => void;
}) {
  return (
    <section className="panel rounds" aria-labelledby="rounds-title" data-testid="rounds">
      <h2 id="rounds-title" className="section-title">
        Rounds
      </h2>
      <div className="table-scroll">
        <table className="metrics-table round-table">
          <thead>
            <tr>
              <th scope="col">Round</th>
              {session.machines.map((machine) => (
                <th
                  scope="col"
                  key={machine.id}
                  className="compare-machine"
                  style={{ '--machine': machine.color } as CSSProperties}
                >
                  {machine.name}
                </th>
              ))}
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {session.warmup ? (
              <Row
                session={session}
                round={session.warmup}
                label="Warm-up, not counted"
                selected={shown === -1}
                onSelect={() => onShow(-1)}
              />
            ) : null}
            {session.rounds.map((round) => (
              <Row
                key={round.index}
                session={session}
                round={round}
                label={`Round ${round.index + 1}`}
                selected={shown === round.index}
                onSelect={() => onShow(round.index)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
