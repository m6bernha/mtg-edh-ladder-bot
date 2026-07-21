export interface EloOptions {
  k?: number;
  winnerOnly?: boolean;
  draw?: boolean;
}

/**
 * Pairwise multiplayer Elo: every pair of players is scored as a 1v1 using
 * pre-game ratings, with K scaled by 1/(n-1) so the total per-player swing
 * is comparable across pod sizes.
 *
 * - draw: every pair scores 0.5.
 * - winnerOnly: only pairs involving the 1st-place player update (winner
 *   beats each opponent); losers are not compared to each other.
 * - Equal placements score 0.5 for that pair.
 *
 * Returns unrounded new ratings (round only for display).
 */
export function computeElo(
  elos: number[],
  placements: number[],
  opts: EloOptions = {},
): number[] {
  const { k = 32, winnerOnly = false, draw = false } = opts;
  const n = elos.length;
  if (placements.length !== n) throw new Error('elos/placements length mismatch');
  if (n < 2) throw new Error('need at least 2 players');

  const kPair = k / (n - 1);
  const deltas = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (winnerOnly && !draw && placements[i] !== 1 && placements[j] !== 1) continue;
      let scoreI: number;
      if (draw || placements[i] === placements[j]) scoreI = 0.5;
      else scoreI = placements[i] < placements[j] ? 1 : 0;
      const expectedI = 1 / (1 + 10 ** ((elos[j] - elos[i]) / 400));
      deltas[i] += kPair * (scoreI - expectedI);
      deltas[j] += kPair * (1 - scoreI - (1 - expectedI));
    }
  }

  return elos.map((e, i) => e + deltas[i]);
}
