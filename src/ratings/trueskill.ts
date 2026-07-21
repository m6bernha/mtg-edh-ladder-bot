import { Rating, TrueSkill } from 'ts-trueskill';

export interface TSRating {
  mu: number;
  sigma: number;
}

export interface TSOptions {
  winnerOnly?: boolean;
  draw?: boolean;
}

/**
 * TrueSkill update for a free-for-all pod: each player is their own rating
 * group; ranks mirror placements (lower = better, equal = tie).
 *
 * - draw: everyone gets the same rank.
 * - winnerOnly: ranks [0, 1, 1, ...] — 1st vs everyone-else-tied.
 */
export function computeTrueSkill(
  ratings: TSRating[],
  placements: number[],
  opts: TSOptions = {},
): TSRating[] {
  if (ratings.length !== placements.length) {
    throw new Error('ratings/placements length mismatch');
  }
  const env = new TrueSkill(); // defaults: mu 25, sigma 25/3
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
    out[origIdx] = { mu: rated[pos][0].mu, sigma: rated[pos][0].sigma };
  });
  return out;
}

// mu - 3*sigma is TrueSkill's conservative skill estimate: the rating we are
// ~99.7% confident the player exceeds. It lives on a roughly 0-50 scale, which
// reads as meaningless to players, so we stretch it into FaceIt-like territory.
// SCALE widens the visible gap between skill levels; OFFSET lifts a fresh
// player (mu 25, sigma 25/3) off zero to a recognisable starting number.
const SR_SCALE = 40;
const SR_OFFSET = 500;

/**
 * FaceIt-feeling display number from the conservative TrueSkill estimate.
 * Fresh players start around 500 and climb as sigma shrinks — early games move
 * SR fast because the system is still resolving uncertainty, not because the
 * player improved.
 */
export function skillRating(mu: number, sigma: number): number {
  return Math.max(0, Math.round((mu - 3 * sigma) * SR_SCALE + SR_OFFSET));
}
