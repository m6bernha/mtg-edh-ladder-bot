import { describe, expect, it } from 'vitest';
import { TrueSkill, Rating } from 'ts-trueskill';
import { restoreFromSnapshots } from '../src/db/snapshots';
import { RATING } from '../src/ratings/config';
import { matchQuality, mulberry32, predictWinProbabilities } from '../src/ratings/predict';
import { applyRust } from '../src/ratings/rust';
import { computeTrueSkill, skillRating } from '../src/ratings/trueskill';

const DAY = 86_400;
const settled = (n: number, sigma = 2) => new Array(n).fill(null).map(() => ({ mu: 25, sigma }));

describe('applyRust', () => {
  it('does nothing for a player with no history', () => {
    expect(applyRust(2, null, 1000)).toEqual({ sigma: 2, daysIdle: 0, rusted: false });
  });
  it('is identity inside the grace window', () => {
    const r = applyRust(2, 100_000 - RATING.RUST_GRACE_DAYS * DAY, 100_000);
    expect(r).toEqual({ sigma: 2, daysIdle: RATING.RUST_GRACE_DAYS, rusted: false });
  });
  it('grows monotonically with idle time and is capped at sigma0', () => {
    let prev = 2;
    for (const days of [8, 14, 21, 30, 60, 90, 365]) {
      const r = applyRust(2, 0, days * DAY);
      expect(r.rusted).toBe(true);
      expect(r.daysIdle).toBe(days);
      expect(r.sigma).toBeGreaterThanOrEqual(prev);
      expect(r.sigma).toBeLessThanOrEqual(RATING.SIGMA0);
      prev = r.sigma;
    }
    expect(applyRust(2, 0, 3650 * DAY).sigma).toBe(RATING.SIGMA0);
  });
  it('matches the documented table: 30 idle days takes sigma 2.0 to ~3.12 (about −135 SR)', () => {
    const r = applyRust(2, 0, 30 * DAY);
    expect(r.sigma).toBeCloseTo(3.12, 2);
    expect(skillRating(25, r.sigma) - skillRating(25, 2)).toBeCloseTo(-135, -1);
  });
  it('never inflates a sigma that is already at the cap', () => {
    expect(applyRust(RATING.SIGMA0, 0, 100 * DAY)).toMatchObject({ sigma: RATING.SIGMA0, rusted: false });
  });
});

describe('rating dynamics (tau)', () => {
  it('a settled 4-pod still moves: winner ≥ +40 SR, last ≤ −40 SR', () => {
    const before = skillRating(25, 2);
    const out = computeTrueSkill(settled(4), [1, 2, 3, 4]);
    expect(skillRating(out[0].mu, out[0].sigma) - before).toBeGreaterThanOrEqual(40);
    expect(skillRating(out[3].mu, out[3].sigma) - before).toBeLessThanOrEqual(-40);
  });
  it('the old default tau would have frozen the same pod (sanity check on the complaint)', () => {
    const env = new TrueSkill(25, 25 / 3, 25 / 6, 25 / 300, 0.1);
    const groups = settled(4, 0.7).map((r) => [new Rating(r.mu, r.sigma)]);
    const out = env.rate(groups, [0, 1, 2, 3]) as Rating[][];
    expect(skillRating(out[0][0].mu, out[0][0].sigma) - skillRating(25, 0.7)).toBeLessThanOrEqual(10);
  });
  it('sigma never drops below SIGMA_MIN', () => {
    let ratings = settled(4, 1.6);
    for (let i = 0; i < 20; i++) {
      ratings = computeTrueSkill(ratings, [1, 2, 3, 4]);
      for (const r of ratings) expect(r.sigma).toBeGreaterThanOrEqual(RATING.SIGMA_MIN);
    }
  });
  it('a rusted player who wins against settled players gains a lot and re-settles', () => {
    const out = computeTrueSkill([{ mu: 25, sigma: 4 }, ...settled(3)], [1, 2, 3, 4]);
    expect(skillRating(out[0].mu, out[0].sigma) - skillRating(25, 4)).toBeGreaterThan(150);
    expect(out[0].sigma).toBeLessThan(4);
  });
});

describe('undo stays exact with rust', () => {
  it('restores sigma_before (the stored value), not the rusted one', () => {
    const rows = [
      { game_id: 1, player_id: 1, placement: 1, commander: null, commander_image: null, mu_before: 25, mu_after: 28, sigma_before: 2, sigma_after: 2.4, sigma_rusted: 3.5, rust_days: 40 },
      { game_id: 1, player_id: 2, placement: 2, commander: null, commander_image: null, mu_before: 25, mu_after: 23, sigma_before: 2, sigma_after: 2, sigma_rusted: null, rust_days: 0 },
    ];
    expect(restoreFromSnapshots(rows)).toEqual([
      { playerId: 1, mu: 25, sigma: 2 },
      { playerId: 2, mu: 25, sigma: 2 },
    ]);
  });
});

describe('predictWinProbabilities', () => {
  it('sums to 1, favours the higher mu, and is deterministic for a seed', () => {
    const pod = [{ mu: 30, sigma: 2 }, { mu: 26, sigma: 2 }, { mu: 24, sigma: 2 }, { mu: 21, sigma: 2 }];
    const a = predictWinProbabilities(pod, 42);
    const b = predictWinProbabilities(pod, 42);
    expect(a).toEqual(b);
    expect(a.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    for (let i = 0; i < a.length - 1; i++) expect(a[i]).toBeGreaterThan(a[i + 1]);
    expect(a[0]).toBeGreaterThan(0.5);
  });
  it('an even pod is close to 25% each', () => {
    const p = predictWinProbabilities(settled(4), 7, 20_000);
    for (const x of p) expect(x).toBeCloseTo(0.25, 1);
  });
  it('handles degenerate pods', () => {
    expect(predictWinProbabilities([], 1)).toEqual([]);
    expect(predictWinProbabilities([{ mu: 25, sigma: 2 }], 1)).toEqual([1]);
  });
  it('different seeds give different but similar draws', () => {
    const pod = [{ mu: 27, sigma: 3 }, { mu: 25, sigma: 3 }];
    const a = predictWinProbabilities(pod, 1);
    const b = predictWinProbabilities(pod, 2);
    expect(a).not.toEqual(b);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(0.05);
  });
  it('mulberry32 is uniform-ish on [0,1)', () => {
    const rnd = mulberry32(99);
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = rnd();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 10_000).toBeCloseTo(0.5, 1);
  });
});

describe('matchQuality', () => {
  it('rates an even pod above a lopsided one', () => {
    const even = matchQuality(settled(4));
    const lopsided = matchQuality([{ mu: 35, sigma: 2 }, { mu: 25, sigma: 2 }, { mu: 22, sigma: 2 }, { mu: 18, sigma: 2 }]);
    expect(even).toBeGreaterThan(lopsided);
    expect(matchQuality([{ mu: 25, sigma: 2 }])).toBe(1);
  });
});
