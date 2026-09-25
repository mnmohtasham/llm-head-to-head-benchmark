import type { SessionView, Vote } from './session';

/** One round as a blind voter sees it: two answers, nothing about who wrote them. */
export interface BlindRound {
  round: number;
  left: string;
  right: string;
}

/** Which machine goes left in each round: true puts the first machine left. */
export function shuffleSides(rounds: number, random: () => number = Math.random): boolean[] {
  return Array.from({ length: rounds }, () => random() < 0.5);
}

/**
 * The rounds of a two-machine session for a blind vote: only the answers, sides shuffled. Names,
 * colours, models and timings stay out, since each would give the machine away.
 */
export function blindRounds(session: SessionView, sides: readonly boolean[]): BlindRound[] {
  const [a, b] = session.machines;
  if (!a || !b || session.machines.length !== 2) return [];
  return session.rounds.flatMap((round) => {
    const first = round.runs.find((run) => run.machineId === a.id);
    const second = round.runs.find((run) => run.machineId === b.id);
    if (!first?.answer || !second?.answer) return [];
    const flip = !(sides[round.index] ?? true);
    return [
      {
        round: round.index,
        left: flip ? second.answer : first.answer,
        right: flip ? first.answer : second.answer,
      },
    ];
  });
}

/** Which machine sat where in a round, to record with the vote. */
export function sidesOf(
  session: SessionView,
  sides: readonly boolean[],
  round: number,
): { left: string; right: string } | null {
  const [a, b] = session.machines;
  if (!a || !b) return null;
  return (sides[round] ?? true) ? { left: a.id, right: b.id } : { left: b.id, right: a.id };
}

/** The model a machine ran in a session, as the tally names it. */
export function modelLabel(session: SessionView, machineId: string): string {
  const status = session.provenance.find((p) => p.machineId === machineId)?.statusBefore;
  if (!status?.activeModel) return 'unknown model';
  return status.quant ? `${status.activeModel} ${status.quant}` : status.activeModel;
}

/** A vote with the models' names instead of machine ids, as the results log keeps it. */
export interface LabeledVote {
  leftModel: string;
  rightModel: string;
  choice: Vote['choice'];
}

export function labelVotes(
  session: Pick<SessionView, 'provenance'> & { votes: Vote[] },
): LabeledVote[] {
  return session.votes.map((vote) => ({
    leftModel: modelLabel(session as SessionView, vote.left),
    rightModel: modelLabel(session as SessionView, vote.right),
    choice: vote.choice,
  }));
}

export interface PairTally {
  /** The two models, in alphabetical order. */
  a: string;
  b: string;
  winsA: number;
  winsB: number;
  ties: number;
}

/** Votes added up per pair of models, across sessions. */
export function tallyVotes(votes: readonly LabeledVote[]): PairTally[] {
  const pairs = new Map<string, PairTally>();
  for (const vote of votes) {
    const [a, b] = [vote.leftModel, vote.rightModel].sort();
    if (a === undefined || b === undefined) continue;
    const key = JSON.stringify([a, b]);
    const tally = pairs.get(key) ?? { a, b, winsA: 0, winsB: 0, ties: 0 };
    if (vote.choice === 'tie') tally.ties += 1;
    else {
      const winner = vote.choice === 'left' ? vote.leftModel : vote.rightModel;
      if (winner === a) tally.winsA += 1;
      else tally.winsB += 1;
    }
    pairs.set(key, tally);
  }
  return [...pairs.values()].sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}
