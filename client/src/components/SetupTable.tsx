import { backendLabel, type MachineProvenance, type SessionView } from '@duel/shared';
import type { CSSProperties } from 'react';

interface Row {
  label: string;
  /** Differences in these rows change what the race compares. */
  matters: boolean;
  pick: (p: MachineProvenance, session: SessionView, index: number) => string;
}

const text = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? 'n/a' : String(value);

const ROWS: readonly Row[] = [
  { label: 'Model', matters: true, pick: (p) => text(p.statusBefore?.activeModel) },
  { label: 'Quant', matters: true, pick: (p) => text(p.statusBefore?.quant) },
  {
    label: 'Backend',
    matters: true,
    pick: (p) => (p.statusBefore ? backendLabel(p.statusBefore.backend) : 'n/a'),
  },
  {
    label: 'Context',
    matters: false,
    pick: (p) =>
      p.statusBefore?.contextLength
        ? `${p.statusBefore.contextLength.toLocaleString('en-US')} tokens`
        : 'n/a',
  },
  {
    label: 'Speculative decoding',
    matters: true,
    pick: (p) => {
      const s = p.statusBefore;
      if (!s) return 'n/a';
      const type = s.speculativeType ?? 'off';
      if (type === 'off') return 'off';
      const drafter = s.specDrafterKind ? ` · ${s.specDrafterKind}` : '';
      return s.specFallbackReason
        ? `${type}, fell back: ${s.specFallbackReason}`
        : `${type}${drafter}`;
    },
  },
  {
    label: 'KV cache',
    matters: true,
    pick: (p) => (p.statusBefore ? (p.statusBefore.cacheTypeKv ?? 'Unsloth default') : 'n/a'),
  },
  {
    label: 'Thinking',
    matters: true,
    pick: (p) => {
      const body = p.request;
      if (!body) return 'n/a';
      const effort = typeof body.reasoning_effort === 'string' ? `, ${body.reasoning_effort}` : '';
      return body.enable_thinking === false ? 'off' : `on${effort}`;
    },
  },
  {
    label: 'Unsloth Studio',
    matters: false,
    pick: (p) => text(p.versions.studio ?? p.versions.unsloth),
  },
  { label: 'llama.cpp', matters: false, pick: (p) => text(p.versions.llamaCpp) },
  {
    label: 'GPU',
    matters: false,
    pick: (p) =>
      p.gpus.length === 0
        ? text(p.platform.backend)
        : p.gpus
            .map((gpu) => (gpu.memoryGb ? `${gpu.name}, ${gpu.memoryGb} GB` : gpu.name))
            .join('; '),
  },
  {
    label: 'Address',
    matters: false,
    pick: (_p, session, i) => text(session.machines[i]?.baseUrl),
  },
];

/** What each machine ran, from the snapshot taken with the race. Differences that matter are marked. */
export function SetupTable({ session }: { session: SessionView }) {
  const provenance = session.machines.map(
    (machine) => session.provenance.find((p) => p.machineId === machine.id) ?? null,
  );
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
            {ROWS.map((row) => {
              const values = provenance.map((p, i) => (p ? row.pick(p, session, i) : 'n/a'));
              const differs =
                row.matters && session.machines.length > 1 && new Set(values).size > 1;
              return (
                <tr key={row.label} className={differs ? 'differs' : undefined}>
                  <th scope="row">
                    {row.label}
                    {differs ? <span className="better-hint">differs</span> : null}
                  </th>
                  {values.map((value, i) => (
                    <td key={session.machines[i]?.id ?? i}>{value}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
