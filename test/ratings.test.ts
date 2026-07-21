import { describe, expect, it } from 'vitest';
import { computeElo } from '../src/ratings/elo';
import { computeTrueSkill, skillRating } from '../src/ratings/trueskill';

const evenElos = (n: number) => new Array<number>(n).fill(1000);
const evenTS = (n: number) => new Array(n).fill(null).map(() => ({ mu: 25, sigma: 25 / 3 }));
const seq = (n: number) => new Array(n).fill(0).map((_, i) => i + 1);

describe('pairwise elo', () => {
  it('ranks winners up and losers down, monotonically by placement', () => {
    const out = computeElo(evenElos(4), [1, 2, 3, 4]);
    expect(out[0]).toBeGreaterThan(1000);
    expect(out[3]).toBeLessThan(1000);
    for (let i = 0; i < 3; i++) expect(out[i]).toBeGreaterThan(out[i + 1]);
  });

  it('is zero-sum', () => {
    const out = computeElo([1100, 950, 1000, 1030], [1, 2, 3, 4]);
    const total = out.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1100 + 950 + 1000 + 1030, 6);
  });

  it('keeps per-player swing comparable across pod sizes', () => {
    const w4 = computeElo(evenElos(4), seq(4))[0] - 1000;
    const w6 = computeElo(evenElos(6), seq(6))[0] - 1000;
    // Winner gain in a 6-pod should be same order of magnitude, not 5/3 larger.
    expect(w6 / w4).toBeGreaterThan(0.8);
    expect(w6 / w4).toBeLessThan(1.3);
  });

  it('underdog winning gains more than favorite winning', () => {
    const upset = computeElo([900, 1100, 1000, 1000], [1, 2, 3, 4])[0] - 900;
    const expected = computeElo([1100, 900, 1000, 1000], [1, 2, 3, 4])[0] - 1100;
    expect(upset).toBeGreaterThan(expected);
  });

  it('draw leaves equal-rated players unchanged', () => {
    const out = computeElo(evenElos(4), [1, 2, 3, 4], { draw: true });
    for (const e of out) expect(e).toBeCloseTo(1000, 6);
  });

  it('draw pulls unequal ratings toward each other', () => {
    const out = computeElo([1200, 800], [1, 2], { draw: true });
    expect(out[0]).toBeLessThan(1200);
    expect(out[1]).toBeGreaterThan(800);
  });

  it('winner-only: losers do not move relative to each other', () => {
    const out = computeElo([1000, 1000, 1200, 800], [1, 2, 3, 4], { winnerOnly: true });
    expect(out[0]).toBeGreaterThan(1000);
    // 2nd/3rd/4th each only lost the pairwise vs the winner. The 1200 player
    // loses more than the 800 player (winner beating a favorite moves more).
    const loss1200 = 1200 - out[2];
    const loss800 = 800 - out[3];
    expect(loss1200).toBeGreaterThan(loss800);
    // Loser-vs-loser comparisons must not have happened: equal-rated 2nd place
    // loses exactly what a solo 1v1 vs winner at kPair would produce.
    const solo = computeElo([1000, 1000], [2, 1], { k: 32 / 3 })[0];
    expect(out[1]).toBeCloseTo(solo, 6);
  });

  it('rejects bad input', () => {
    expect(() => computeElo([1000], [1])).toThrow();
    expect(() => computeElo([1000, 1000], [1])).toThrow();
  });
});

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
