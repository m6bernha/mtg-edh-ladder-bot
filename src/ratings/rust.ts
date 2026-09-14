import { RATING } from './config.ts';

export interface RustResult {
  /** The sigma to feed the rating engine. */
  sigma: number;
  /** Whole days since the player's last completed game (0 when unknown). */
  daysIdle: number;
  /** True when sigma was inflated — i.e. daysIdle exceeded the grace window. */
  rusted: boolean;
}

const DAY_SECONDS = 86_400;

/**
 * Inflate a player's uncertainty for time away from the table:
 *
 *   sigma' = min(SIGMA0, sqrt(sigma² + RUST_K² · max(0, daysIdle − RUST_GRACE_DAYS)))
 *
 * Pure. `now` is the game's own timestamp (its ended_at, in seconds), never the
 * wall clock, so a replay reproduces every historical value exactly. A player
 * with no completed game yet has nothing to be rusty about.
 */
export function applyRust(sigma: number, lastPlayedAt: number | null, now: number): RustResult {
  if (lastPlayedAt == null) return { sigma, daysIdle: 0, rusted: false };
  const daysIdle = Math.max(0, Math.floor((now - lastPlayedAt) / DAY_SECONDS));
  const excess = Math.max(0, daysIdle - RATING.RUST_GRACE_DAYS);
  if (excess === 0) return { sigma, daysIdle, rusted: false };
  const inflated = Math.min(RATING.SIGMA0, Math.sqrt(sigma * sigma + RATING.RUST_K ** 2 * excess));
  return { sigma: inflated, daysIdle, rusted: inflated > sigma };
}
