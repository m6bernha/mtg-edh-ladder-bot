import { describe, expect, it } from 'vitest';
import { rateGame, type SeatInput } from '../src/ratings/engine';
import { computeTrueSkill } from '../src/ratings/trueskill';

const fresh = (playerId: number, placement: number): SeatInput => ({
  playerId,
  placement,
  mu: 25,
  sigma: 25 / 3,
  lastPlayedAt: null,
});
const byId = (seats: ReturnType<typeof rateGame>) => [...seats].sort((a, b) => a.playerId - b.playerId);

describe('rateGame — input order never matters', () => {
  it('a draw between identical fresh players rates identically whatever order they arrive in', () => {
    const opts = { draw: true, winnerOnly: false, endedAt: 1_000_000, seed: 7 };
    const a = byId(rateGame([fresh(3, 1), fresh(1, 1), fresh(2, 1)], opts));
    const b = byId(rateGame([fresh(1, 1), fresh(2, 1), fresh(3, 1)], opts));
    const c = byId(rateGame([fresh(2, 1), fresh(3, 1), fresh(1, 1)], opts));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // TrueSkill's adjacent-pair draw factors give the middle seat a slightly
    // different sigma (~0.003) — inherent to the algorithm. What matters is that
    // the SAME player gets it every time, which the equalities above prove.
  });

  it('winner-only with identical losers is also order-independent', () => {
    const opts = { draw: false, winnerOnly: true, endedAt: 1_000_000, seed: 7 };
    const a = byId(rateGame([fresh(1, 1), fresh(2, 2), fresh(3, 3), fresh(4, 4)], opts));
    const b = byId(rateGame([fresh(1, 1), fresh(4, 2), fresh(3, 3), fresh(2, 4)], opts));
    expect(a.map((x) => [x.muAfter, x.sigmaAfter])).toEqual(b.map((x) => [x.muAfter, x.sigmaAfter]));
  });

  it('computeTrueSkill honours keys as the final tie-break', () => {
    const even = [{ mu: 25, sigma: 3 }, { mu: 25, sigma: 3 }, { mu: 25, sigma: 3 }];
    const a = computeTrueSkill(even, [1, 1, 1], { draw: true }, [1, 2, 3]);
    const b = computeTrueSkill(even, [1, 1, 1], { draw: true }, [3, 1, 2]);
    // player 1 is index 0 in a and index 1 in b
    expect(b[1]).toEqual(a[0]);
    expect(b[2]).toEqual(a[1]);
    expect(b[0]).toEqual(a[2]);
  });
});

describe('rateGame — fields', () => {
  it('records rust only past the grace window and keeps the raw sigma in sigmaBefore', () => {
    const endedAt = 100 * 86_400;
    const out = byId(
      rateGame(
        [
          { playerId: 1, placement: 1, mu: 25, sigma: 2, lastPlayedAt: endedAt - 40 * 86_400 },
          { playerId: 2, placement: 2, mu: 25, sigma: 2, lastPlayedAt: endedAt - 2 * 86_400 },
          { playerId: 3, placement: 3, mu: 25, sigma: 2, lastPlayedAt: null },
        ],
        { draw: false, winnerOnly: false, endedAt, seed: 1 },
      ),
    );
    expect(out[0]).toMatchObject({ sigmaBefore: 2, rustDays: 40 });
    expect(out[0].sigmaRusted).toBeGreaterThan(2);
    expect(out[1]).toMatchObject({ sigmaBefore: 2, sigmaRusted: null, rustDays: 2 });
    expect(out[2]).toMatchObject({ sigmaBefore: 2, sigmaRusted: null, rustDays: 0 });
    expect(out[0].muAfter).toBeGreaterThan(out[1].muAfter);
    expect(out[1].muAfter).toBeGreaterThan(out[2].muAfter);
  });

  it('a draw stores placement 1 for everyone and odds sum to 1', () => {
    const out = rateGame([fresh(1, 1), fresh(2, 1)], { draw: true, winnerOnly: false, endedAt: 1, seed: 1 });
    expect(out.every((x) => x.placement === 1)).toBe(true);
    expect(out.reduce((s, x) => s + x.preGameWinPct, 0)).toBeCloseTo(1, 9);
  });

  it('odds do not depend on the placement order handed in', () => {
    const opts = { draw: false, winnerOnly: false, endedAt: 1, seed: 99 };
    const a = byId(rateGame([{ ...fresh(1, 1), mu: 30 }, fresh(2, 2), fresh(3, 3)], opts));
    const b = byId(rateGame([fresh(3, 1), fresh(2, 2), { ...fresh(1, 3), mu: 30 }], opts));
    expect(a.map((x) => x.preGameWinPct)).toEqual(b.map((x) => x.preGameWinPct));
  });
});
