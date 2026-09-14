import { Rating } from 'ts-trueskill';
import { RATING } from './config.ts';
import { ratingEnv, type TSRating } from './trueskill.ts';

/** Deterministic 32-bit PRNG (mulberry32) so /predict is reproducible and testable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller over the given uniform source. */
function gaussian(rnd: () => number): number {
  let u = 0;
  while (u === 0) u = rnd();
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Probability that each player finishes first, by Monte Carlo: every iteration
 * draws a performance from N(mu, sigma² + beta²) per player and credits the
 * highest. Returns probabilities that sum to 1 (up to float error).
 */
export function predictWinProbabilities(
  players: TSRating[],
  seed: number,
  iterations: number = RATING.PREDICT_ITERATIONS,
): number[] {
  if (players.length === 0) return [];
  if (players.length === 1) return [1];
  const rnd = mulberry32(seed);
  const wins = new Array<number>(players.length).fill(0);
  const spread = players.map((p) => Math.sqrt(p.sigma * p.sigma + RATING.BETA * RATING.BETA));
  for (let it = 0; it < iterations; it++) {
    let best = -Infinity;
    let who = 0;
    for (let i = 0; i < players.length; i++) {
      const perf = players[i].mu + spread[i] * gaussian(rnd);
      if (perf > best) {
        best = perf;
        who = i;
      }
    }
    wins[who]++;
  }
  return wins.map((w) => w / iterations);
}

/** TrueSkill's match-quality score (0..1): how likely the pod is to be a draw, i.e. how even it is. */
export function matchQuality(players: TSRating[]): number {
  if (players.length < 2) return 1;
  return ratingEnv().quality(players.map((p) => [new Rating(p.mu, p.sigma)]));
}
