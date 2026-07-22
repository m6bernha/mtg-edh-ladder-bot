import type { GamePlayerRow } from '../types';

export interface PlayerRatingUpdate {
  playerId: number;
  mu: number;
  sigma: number;
}

/**
 * Map a completed game's snapshot rows back to the player rating values that
 * were in effect *before* that game — the heart of /undo.
 * Throws if any row is missing snapshots (i.e. the game never completed).
 */
export function restoreFromSnapshots(rows: GamePlayerRow[]): PlayerRatingUpdate[] {
  return rows.map((r) => {
    if (r.mu_before == null || r.sigma_before == null) {
      throw new Error(`game_players row for player ${r.player_id} has no snapshots`);
    }
    return {
      playerId: r.player_id,
      mu: r.mu_before,
      sigma: r.sigma_before,
    };
  });
}
