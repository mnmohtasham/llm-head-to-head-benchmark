import { scoreboard, type SessionView } from '@duel/shared';

/** The race in a few sentences: ratios on length-independent metrics, gated, or a tie. */
export function Scoreboard({ session }: { session: SessionView }) {
  const lines = scoreboard(session);
  if (lines.length === 0) return null;
  const colour = (id: string | null) => session.machines.find((m) => m.id === id)?.color;
  return (
    <section
      className="panel scoreboard"
      aria-labelledby="scoreboard-title"
      data-testid="scoreboard"
    >
      <h2 id="scoreboard-title" className="section-title">
        Scoreboard
      </h2>
      <ul>
        {lines.map((line) => (
          <li
            key={line.key}
            className={`score score-${line.kind}`}
            data-key={line.key}
            style={line.winnerId ? { borderColor: colour(line.winnerId) } : undefined}
          >
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The race as files: the whole session, the tables, and a summary that reads on its own. */
export function ExportLinks({ session }: { session: SessionView }) {
  const base = `/api/sessions/${encodeURIComponent(session.id)}/export`;
  return (
    <p className="export-links" data-testid="exports">
      <span className="hero-label">Export</span>
      <a
        className="btn btn-outline"
        href={`/api/sessions/${encodeURIComponent(session.id)}/result.json`}
        download
        title="Every measurement in Model Duel's public result format, ready to share"
      >
        Result file
      </a>
      <a
        className="btn btn-outline"
        href={`${base}.json`}
        download
        title="The session as Model Duel stores it, for debugging"
      >
        Raw JSON
      </a>
      <a className="btn btn-outline" href={`${base}.csv`} download>
        CSV
      </a>
      <a className="btn btn-outline" href={`${base}.md`} download>
        Markdown
      </a>
    </p>
  );
}
