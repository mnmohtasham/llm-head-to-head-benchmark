import {
  blindRounds,
  modelLabel,
  shuffleSides,
  sidesOf,
  type PairTally,
  type SessionView,
  type Vote,
} from '@duel/shared';
import { useRef, useState } from 'react';
import { api, messageOf } from '../api';

const CHOICES: ReadonlyArray<[Vote['choice'], string]> = [
  ['left', 'Left is better'],
  ['tie', 'Tie'],
  ['right', 'Right is better'],
];

/**
 * Judge the answers without knowing whose they are: two per round, sides shuffled, and nothing on
 * the page that names a machine until every round has a vote and the reveal is asked for.
 */
export function BlindVote({
  session,
  onClose,
}: {
  session: SessionView;
  onClose: (updated: SessionView | null) => void;
}) {
  const [sides] = useState(() => shuffleSides(session.rounds.length));
  const rounds = blindRounds(session, sides);
  const [choices, setChoices] = useState<Record<number, Vote['choice']>>({});
  const [revealed, setRevealed] = useState(false);
  const [tally, setTally] = useState<PairTally[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<SessionView | null>(null);
  const complete = rounds.length > 0 && rounds.every((r) => choices[r.round]);

  const vote = async (round: number, choice: Vote['choice']) => {
    const where = sidesOf(session, sides, round);
    if (!where) return;
    setError(null);
    try {
      latest.current = await api.vote(session.id, { round, ...where, choice });
      setChoices((current) => ({ ...current, [round]: choice }));
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const reveal = async () => {
    setRevealed(true);
    try {
      setTally((await api.voteTally()).tally);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  if (!revealed) {
    return (
      <section className="panel blind" aria-labelledby="blind-title" data-testid="blind">
        <h2 id="blind-title" className="section-title">
          Blind vote
        </h2>
        <p className="muted">
          Each round shows the two answers side by side, in a random order. Which machine wrote
          which stays hidden until you have voted on every round.
        </p>
        {rounds.length === 0 ? (
          <p className="field-error">No round has an answer from both machines to compare.</p>
        ) : null}
        {rounds.map((r) => (
          <article key={r.round} className="blind-round" data-testid="blind-round">
            <h3 className="hero-label">Round {r.round + 1}</h3>
            <div className="blind-answers">
              <div className="run-text" data-testid="blind-left">
                {r.left}
              </div>
              <div className="run-text" data-testid="blind-right">
                {r.right}
              </div>
            </div>
            <div className="toggle-chips" role="radiogroup" aria-label={`Round ${r.round + 1}`}>
              {CHOICES.map(([choice, label]) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={choices[r.round] === choice}
                  className={`toggle-chip${choices[r.round] === choice ? ' toggle-chip-on' : ''}`}
                  onClick={() => void vote(r.round, choice)}
                >
                  {label}
                </button>
              ))}
            </div>
          </article>
        ))}
        {error ? <p className="field-error">{error}</p> : null}
        <div className="blind-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void reveal()}
            disabled={!complete}
          >
            Reveal
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => onClose(null)}>
            Leave without revealing
          </button>
        </div>
      </section>
    );
  }

  const name = (id: string) => session.machines.find((m) => m.id === id)?.name ?? 'unknown';
  return (
    <section className="panel blind" aria-labelledby="blind-title" data-testid="blind-reveal">
      <h2 id="blind-title" className="section-title">
        Blind vote, revealed
      </h2>
      <ul className="blind-results">
        {rounds.map((r) => {
          const where = sidesOf(session, sides, r.round);
          const choice = choices[r.round];
          if (!where) return null;
          const picked =
            choice === 'tie'
              ? 'You called it a tie.'
              : `You picked ${name(choice === 'left' ? where.left : where.right)}.`;
          return (
            <li key={r.round}>
              Round {r.round + 1}: left was {name(where.left)} ({modelLabel(session, where.left)}),
              right was {name(where.right)} ({modelLabel(session, where.right)}). {picked}
            </li>
          );
        })}
      </ul>
      {tally && tally.length > 0 ? (
        <>
          <h3 className="hero-label">All your blind votes, by model pair</h3>
          <table className="metrics-table" data-testid="tally">
            <thead>
              <tr>
                <th scope="col">Models</th>
                <th scope="col">Wins</th>
                <th scope="col">Ties</th>
              </tr>
            </thead>
            <tbody>
              {tally.map((pair) => (
                <tr key={`${pair.a}|${pair.b}`}>
                  <th scope="row">
                    {pair.a} against {pair.b}
                  </th>
                  <td>
                    {pair.winsA} to {pair.winsB}
                  </td>
                  <td>{pair.ties}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {error ? <p className="field-error">{error}</p> : null}
      <button type="button" className="btn btn-primary" onClick={() => onClose(latest.current)}>
        Done
      </button>
    </section>
  );
}
