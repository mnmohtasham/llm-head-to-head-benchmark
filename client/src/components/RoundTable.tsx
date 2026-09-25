import { roundTable, type SessionView } from '@duel/shared';
import type { CSSProperties } from 'react';

/**
 * One row per round from the shared table model: each machine's first answer word, speed and
 * round trip. Picking a row shows that round in the panes and charts.
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
  const table = roundTable(session);
  const machines = session.machines;
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
              {machines.map((machine) => (
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
            {table.rows.map((row) => {
              const index = row.key === 'warmup' ? -1 : Number(row.key.slice('round-'.length));
              const selected = shown === index;
              return (
                <tr
                  key={row.key}
                  className={selected ? 'round-selected' : undefined}
                  data-testid="round-row"
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="round-pick"
                      onClick={() => onShow(index)}
                      aria-pressed={selected}
                    >
                      {row.label}
                    </button>
                  </th>
                  {machines.map((machine, i) => {
                    const [first, speed, rtt] = row.cells.slice(i * 3, i * 3 + 3);
                    return (
                      <td key={machine.id} data-machine={machine.name}>
                        {[first?.text, speed?.text].filter((part) => part).join(' · ')}
                        {rtt?.text ? <span className="cell-detail">{rtt.text}</span> : null}
                      </td>
                    );
                  })}
                  <td className="round-flags">{row.cells[row.cells.length - 1]?.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
