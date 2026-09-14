/**
 * Rate one finished game. This is THE function that turns placements into
 * ratings — the live report path (src/services/report.ts) and the history
 * replay (scripts/recompute-ratings.mjs) both call it, so a replay reproduces
 * exactly what the live path wrote. Pure: no I/O, no clock.
 */

import { predictWinProbabilities } from './predict.ts';
import { applyRust } from './rust.ts';
import { computeTrueSkill } from './trueskill.ts';

export interface SeatInput {
  playerId: number;
  /** 1-based finish. For a draw pass 1 for everyone. */
  placement: number;
  mu: number;
  sigma: number;
  /** ended_at of the player's previous completed game, or null. */
  lastPlayedAt: number | null;
}

export interface RatedSeat {
  playerId: number;
  placement: number;
  muBefore: number;
  sigmaBefore: number;
  sigmaRusted: number | null;
  rustDays: number;
  muAfter: number;
  sigmaAfter: number;
  /** First-place probability before the game, from the rust-adjusted ratings. */
  preGameWinPct: number;
}

export interface RateGameOptions {
  draw: boolean;
  winnerOnly: boolean;
  /** The game's own timestamp (seconds) — drives rust; never the wall clock. */
  endedAt: number;
  /** Seed for the odds sampler; the game id keeps /predict and the report in step. */
  seed: number;
}

/**
 * Seats are processed in a canonical order — placement, then player id — so
 * the reporter's slot order (or a replay's row order) can never change a
 * result. Output is in that canonical order.
 */
export function rateGame(seats: SeatInput[], opts: RateGameOptions): RatedSeat[] {
  const ordered = [...seats].sort((a, b) => a.placement - b.placement || a.playerId - b.playerId);
  const rust = ordered.map((s) => applyRust(s.sigma, s.lastPlayedAt, opts.endedAt));
  const ratings = ordered.map((s, i) => ({ mu: s.mu, sigma: rust[i].sigma }));
  const places = opts.draw ? ordered.map(() => 1) : ordered.map((s) => s.placement);
  const after = computeTrueSkill(ratings, places, { draw: opts.draw, winnerOnly: opts.winnerOnly }, ordered.map((s) => s.playerId));

  // Odds are sampled on a player-id-sorted view so /predict (roster order) and
  // the report (placement order) assign the same random stream to each player.
  const byId = ordered.map((s, i) => ({ id: s.playerId, r: ratings[i] })).sort((a, b) => a.id - b.id);
  const odds = predictWinProbabilities(byId.map((x) => x.r), opts.seed);
  const oddsById = new Map(byId.map((x, i) => [x.id, odds[i]]));

  return ordered.map((s, i) => ({
    playerId: s.playerId,
    placement: opts.draw ? 1 : s.placement,
    muBefore: s.mu,
    sigmaBefore: s.sigma,
    sigmaRusted: rust[i].rusted ? rust[i].sigma : null,
    rustDays: rust[i].daysIdle,
    muAfter: after[i].mu,
    sigmaAfter: after[i].sigma,
    preGameWinPct: oddsById.get(s.playerId) ?? 0,
  }));
}
