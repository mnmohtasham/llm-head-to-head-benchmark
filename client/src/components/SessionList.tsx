import type { SessionSummary } from '@duel/shared';
import { formatRate, formatSeconds } from '../format';

const STATE_LABEL: Record<SessionSummary['state'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

interface Props {
  sessions: SessionSummary[] | null;
  currentId: string | null;
  onDelete: (session: SessionSummary) => void;
}

/** Every saved race, newest first. Open shows it again; delete removes its file. */
export function SessionList({ sessions, currentId, onDelete }: Props) {
  return (
    <section className="panel session-list" aria-labelledby="results-title">
      <h2 id="results-title" className="section-title">
        Results log
      </h2>
      {sessions === null ? (
        <p className="muted">Loading past races…</p>
      ) : sessions.length === 0 ? (
        <p className="muted">Races you run are saved here, so you can open them again.</p>
      ) : (
        <ol className="session-rows">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`session-row${s.id === currentId ? ' session-current' : ''}`}
              data-testid="session-row"
              aria-current={s.id === currentId ? 'true' : undefined}
            >
              <div className="session-main">
                <p className="session-head">
                  <time dateTime={s.createdAt}>{when(s.createdAt)}</time>
                  <span className={`session-state session-${s.state}`}>{STATE_LABEL[s.state]}</span>
                  {s.rounds > 1 ? <span>{s.rounds} rounds, medians</span> : null}
                </p>
                <p className="session-prompt">{s.prompt}</p>
                <ul className="session-machines">
                  {s.machines.map((m) => (
                    <li key={m.id}>
                      <span className="session-machine" style={{ color: m.color }}>
                        {m.name}
                      </span>{' '}
                      {m.state !== 'done'
                        ? m.state
                        : s.workload === 'image'
                          ? `${m.imageMs === null ? 'n/a' : `${(m.imageMs / 1000).toFixed(1)} s`} per image, ${m.stepsPerSec === null ? 'n/a' : m.stepsPerSec.toFixed(2)} steps/s`
                          : s.workload === 'transcribe'
                            ? `${m.rtf === null ? 'n/a' : `${m.rtf.toFixed(m.rtf < 10 ? 1 : 0)}×`} real time${m.wer === null ? '' : `, WER ${(m.wer * 100).toFixed(1)}%`}`
                            : m.firstAnswerMs === null
                              ? `no answer, ${formatRate(m.decodeTokPerSec, 'tok/s')}`
                              : `${formatSeconds(m.firstAnswerMs)} s first word, ${formatRate(m.decodeTokPerSec, 'tok/s')}`}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="session-actions">
                <a className="btn btn-quiet" href={`#/${s.workload ?? 'text'}/${s.id}`}>
                  Open
                </a>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => onDelete(s)}
                  disabled={s.state === 'running'}
                  aria-label={`Delete the race from ${when(s.createdAt)}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
