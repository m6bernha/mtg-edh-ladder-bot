import { Rating, TrueSkill } from 'ts-trueskill';
import { RATING } from './config.ts';

export interface TSRating {
  mu: number;
  sigma: number;
}

export interface TSOptions {
  winnerOnly?: boolean;
  draw?: boolean;
}

/** One environment for every call — tau and the draw prior live in config.ts. */
export function ratingEnv(): TrueSkill {
  return new TrueSkill(RATING.MU0, RATING.SIGMA0, RATING.BETA, RATING.TAU, RATING.DRAW_PROBABILITY);
}

/**
 * TrueSkill update for a free-for-all pod: each player is their own rating
 * group; ranks mirror placements (lower = better, equal = tie).
 *
 * - draw: everyone gets the same rank.
 * - winnerOnly: ranks [0, 1, 1, ...] — 1st vs everyone-else-tied.
 *
 * Output sigma is floored at SIGMA_MIN so a rating can never freeze solid.
 */
export function computeTrueSkill(
  ratings: TSRating[],
  placements: number[],
  opts: TSOptions = {},
): TSRating[] {
  if (ratings.length !== placements.length) {
    throw new Error('ratings/placements length mismatch');
  }
  const env = ratingEnv();
  let ranks: number[];
  if (opts.draw) ranks = ratings.map(() => 0);
  else if (opts.winnerOnly) ranks = placements.map((p) => (p === 1 ? 0 : 1));
  else ranks = placements;

  // Ties are resolved through adjacent-pair factors, so results vary slightly
  // (<0.01 mu) with input order among tied players. Canonicalize the order so
  // the reporter's arbitrary slot order can never change the outcome.
  const order = ratings
    .map((_, i) => i)
    .sort(
      (a, b) =>
        ranks[a] - ranks[b] ||
        ratings[a].mu - ratings[b].mu ||
        ratings[a].sigma - ratings[b].sigma,
    );
  const groups = order.map((i) => [new Rating(ratings[i].mu, ratings[i].sigma)]);
  const sortedRanks = order.map((i) => ranks[i]);
  const rated = env.rate(groups, sortedRanks) as Rating[][];

  const out = new Array<TSRating>(ratings.length);
  order.forEach((origIdx, pos) => {
    out[origIdx] = { mu: rated[pos][0].mu, sigma: Math.max(RATING.SIGMA_MIN, rated[pos][0].sigma) };
  });
  return out;
}

/**
 * FaceIt-feeling display number from the conservative TrueSkill estimate
 * (mu − 3·sigma: the rating we are ~99.7% confident the player exceeds).
 * Fresh players start around 500 and climb as sigma shrinks — early games move
 * SR fast because the system is still resolving uncertainty, not because the
 * player improved.
 */
export function skillRating(mu: number, sigma: number): number {
  return Math.max(0, Math.round((mu - 3 * sigma) * RATING.SR_SCALE + RATING.SR_OFFSET));
}
