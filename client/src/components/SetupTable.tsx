import { setupTable, type SessionView } from '@duel/shared';
import type { CSSProperties } from 'react';

/**
 * What each machine ran, from the snapshot taken with the race: versions, model, quant, backend,
 * context, slots, decoding path, GPUs, system and notes, then the exact request bodies.
 */
export function SetupTable({ session }: { session: SessionView }) {
  const table = setupTable(session);
  return (
    <section className="panel setup" aria-labelledby="setup-title" data-testid="setup">
      <h2 id="setup-title" className="section-title">
        Setup
      </h2>
      <div className="table-scroll">
        <table className="metrics-table setup-table">
          <thead>
            <tr>
              <th scope="col">Setting</th>
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
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.key} className={row.differs ? 'differs' : undefined}>
                <th scope="row">
                  {row.label}
                  {row.differs ? <span className="better-hint">differs</span> : null}
                </th>
                {row.cells.map((cell, i) => (
                  <td key={session.machines[i]?.id ?? i}>{cell.text}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {session.machines.map((machine) => {
        const request = session.provenance.find((p) => p.machineId === machine.id)?.request;
        if (!request) return null;
        const body = {
          ...request,
          messages: (request.messages as Array<{ role: string; content: string }> | undefined)?.map(
            (m) => ({
              ...m,
              content:
                m.content.length > 400
                  ? `${m.content.slice(0, 400)}… (${m.content.length.toLocaleString('en-US')} characters)`
                  : m.content,
            }),
          ),
        };
        return (
          <details key={machine.id} className="request-body">
            <summary>Request sent to {machine.name}</summary>
            <pre>{JSON.stringify(body, null, 2)}</pre>
          </details>
        );
      })}
    </section>
  );
}
