import type { MachineView } from '@duel/shared';
import { clockTime } from '../format';

export interface LogEntry {
  id: number;
  at: Date;
  machineName: string | null;
  color: string | null;
  tone: 'ok' | 'warning' | 'error' | 'info';
  text: string;
}

export type NewLogEntry = Omit<LogEntry, 'id' | 'at'>;

export function LogPanel({ machines, entries }: { machines: MachineView[]; entries: LogEntry[] }) {
  const roster =
    machines.length === 0
      ? 'No machines yet.'
      : `${machines.length} ${machines.length === 1 ? 'machine' : 'machines'}: ${machines
          .map((machine) => machine.name)
          .join(', ')}.`;
  return (
    <section className="log" aria-labelledby="log-title">
      <h2 id="log-title" className="section-title">
        Activity
      </h2>
      <ol className="log-lines" aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.id} className={`log-line log-${entry.tone}`}>
            <time className="log-time" dateTime={entry.at.toISOString()}>
              {clockTime(entry.at)}
            </time>
            {entry.machineName ? (
              <span className="log-machine" style={{ color: entry.color ?? undefined }}>
                {entry.machineName}
              </span>
            ) : null}
            <span className="log-text">{entry.text}</span>
          </li>
        ))}
        <li className="log-line log-info">
          <span className="log-text">{roster}</span>
        </li>
      </ol>
    </section>
  );
}
