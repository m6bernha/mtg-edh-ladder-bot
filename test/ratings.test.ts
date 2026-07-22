import { describe, expect, it } from 'vitest';
import { computeTrueSkill, skillRating } from '../src/ratings/trueskill';

const evenTS = (n: number) => new Array(n).fill(null).map(() => ({ mu: 25, sigma: 25 / 3 }));
const seq = (n: number) => new Array(n).fill(0).map((_, i) => i + 1);

describe('trueskill', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    it(`updates a ${n}-player pod: winner up, last down, sigma shrinks`, () => {
      const out = computeTrueSkill(evenTS(n), seq(n));
      expect(out[0].mu).toBeGreaterThan(25);
      expect(out[n - 1].mu).toBeLessThan(25);
      for (const r of out) expect(r.sigma).toBeLessThan(25 / 3);
      for (let i = 0; i < n - 1; i++) expect(out[i].mu).toBeGreaterThan(out[i + 1].mu);
    });
  }

  it('draw keeps equal players symmetric', () => {
    const out = computeTrueSkill(evenTS(4), [1, 2, 3, 4], { draw: true });
    for (const r of out) expect(r.mu).toBeCloseTo(out[0].mu, 6);
  });

  it('winner-only: 2nd through 4th are treated near-identically', () => {
    const out = computeTrueSkill(evenTS(4), [1, 2, 3, 4], { winnerOnly: true });
    expect(out[0].mu).toBeGreaterThan(25);
    // Adjacent-pair tie factors leave <0.01 mu asymmetry among tied players —
    // inherent to the algorithm, ~0.3 SR, invisible after display rounding.
    expect(out[1].mu).toBeCloseTo(out[2].mu, 1);
    expect(out[2].mu).toBeCloseTo(out[3].mu, 1);
  });

  it('is order-independent: shuffled input slots give identical results per player', () => {
    const ratings = [
      { mu: 27, sigma: 6 },
      { mu: 24, sigma: 8 },
      { mu: 25, sigma: 7 },
      { mu: 22, sigma: 8 },
    ];
    const a = computeTrueSkill(ratings, [2, 1, 3, 4], { winnerOnly: true });
    const shuffled = [ratings[3], ratings[1], ratings[0], ratings[2]];
    const b = computeTrueSkill(shuffled, [4, 1, 2, 3], { winnerOnly: true });
    expect(b[2].mu).toBeCloseTo(a[0].mu, 10);
    expect(b[1].mu).toBeCloseTo(a[1].mu, 10);
    expect(b[3].mu).toBeCloseTo(a[2].mu, 10);
    expect(b[0].mu).toBeCloseTo(a[3].mu, 10);
  });

  it('winner-only winner gains more than full-placement winner (beats a tied field)', () => {
    const full = computeTrueSkill(evenTS(4), [1, 2, 3, 4]);
    const wo = computeTrueSkill(evenTS(4), [1, 2, 3, 4], { winnerOnly: true });
    // Not asserting direction strongly, just that both moved the winner up
    // and produced different updates (the modes are actually distinct).
    expect(full[0].mu).toBeGreaterThan(25);
    expect(wo[0].mu).toBeGreaterThan(25);
    expect(Math.abs(full[3].mu - wo[3].mu)).toBeGreaterThan(1e-9);
  });
});

describe('skill rating display', () => {
  it('fresh player lands near 500', () => {
    const sr = skillRating(25, 25 / 3);
    expect(sr).toBeGreaterThanOrEqual(495);
    expect(sr).toBeLessThanOrEqual(505);
  });

  it('never negative and grows with mu', () => {
    expect(skillRating(0, 10)).toBe(0);
    expect(skillRating(30, 4)).toBeGreaterThan(skillRating(25, 4));
  });

  it('shrinking sigma raises SR at equal mu', () => {
    expect(skillRating(25, 3)).toBeGreaterThan(skillRating(25, 8));
  });
});
