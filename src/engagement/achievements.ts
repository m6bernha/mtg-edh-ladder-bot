/**
 * Badges shown on /stats. Computed on read from a player's game history — no
 * table to keep in sync, no backfill. Each badge records the game that earned
 * it first. Pure.
 */

import type { PlayerGameRow, PodSnapshotRow } from '../db/queries';

export interface Badge {
  id: string;
  emoji: string;
  label: string;
  description: string;
  earnedAt: number;
}

const HOUR = 3600;
const IRON_PILOT_GAMES = 10;
const LOYALIST_WINS = 5;
const MAINSTAY_GAMES = 25;
const MARATHON_SECONDS = 3 * HOUR;
const BLITZ_SECONDS = 30 * 60;
const HAT_TRICK = 3;
const COMEBACK_LOSSES = 3;

const isWin = (g: PlayerGameRow) => g.draw === 0 && g.placement === 1;
const isLoss = (g: PlayerGameRow) => g.draw === 0 && g.placement !== 1;

/**
 * @param games   the player's completed games, NEWEST FIRST (as getPlayerGames returns)
 * @param pods    pre-game snapshots for every seat of those games (Giant Killer)
 * @param topByGame  games.top_player_id per game (Kingslayer); missing/null → not awarded
 */
export function computeBadges(
  games: PlayerGameRow[],
  pods: Map<number, PodSnapshotRow[]>,
  topByGame: Map<number, number | null>,
  playerId: number,
): Badge[] {
  const chrono = [...games].reverse(); // oldest → newest
  const out: Badge[] = [];
  const award = (id: string, emoji: string, label: string, description: string, earnedAt: number) => {
    if (!out.some((b) => b.id === id)) out.push({ id, emoji, label, description, earnedAt });
  };

  const byCommander = new Map<string, { games: number; wins: number }>();
  let winRun = 0;
  let lossRun = 0;
  let played = 0;

  for (const g of chrono) {
    played++;
    const won = isWin(g);
    const lost = isLoss(g);

    if (won) award('first-blood', '🩸', 'First Blood', 'Won a pod', g.ended_at);

    winRun = won ? winRun + 1 : 0;
    if (winRun >= HAT_TRICK) award('hat-trick', '🎩', 'Hat Trick', `${HAT_TRICK} wins in a row`, g.ended_at);

    if (won && lossRun >= COMEBACK_LOSSES) {
      award('comeback', '💪', 'Comeback', `Won right after ${COMEBACK_LOSSES} straight losses`, g.ended_at);
    }
    lossRun = lost ? lossRun + 1 : 0;

    if (g.commander) {
      const c = byCommander.get(g.commander) ?? { games: 0, wins: 0 };
      c.games++;
      if (won) c.wins++;
      byCommander.set(g.commander, c);
      if (c.games >= IRON_PILOT_GAMES) {
        award('iron-pilot', '🛡️', 'Iron Pilot', `${IRON_PILOT_GAMES} games with one commander`, g.ended_at);
      }
      if (c.wins >= LOYALIST_WINS) {
        award('loyalist', '🤝', 'Loyalist', `${LOYALIST_WINS} wins with one commander`, g.ended_at);
      }
    }

    if (played >= MAINSTAY_GAMES) award('mainstay', '🪑', 'Table Mainstay', `${MAINSTAY_GAMES} games played`, g.ended_at);

    const length = g.ended_at - g.started_at;
    if (won && length >= MARATHON_SECONDS) award('marathon', '🏃', 'Marathon', 'Won a game over 3 hours long', g.ended_at);
    if (won && length < BLITZ_SECONDS) award('blitz', '⚡', 'Blitz', 'Won a game in under 30 minutes', g.ended_at);

    if (won) {
      const pod = pods.get(g.game_id);
      if (pod && pod.length > 2) {
        const conservative = (r: PodSnapshotRow) =>
          r.mu_before != null ? r.mu_before - 3 * (r.sigma_rusted ?? r.sigma_before ?? 0) : Infinity;
        const mine = pod.find((r) => r.player_id === playerId);
        if (mine && pod.every((r) => r.player_id === playerId || conservative(r) > conservative(mine))) {
          award('giant-killer', '🗡️', 'Giant Killer', 'Won as the lowest-rated player at the table', g.ended_at);
        }
      }
      const top = topByGame.get(g.game_id);
      if (top != null && top !== playerId && pod?.some((r) => r.player_id === top)) {
        award('kingslayer', '⚔️', 'Kingslayer', 'Beat the #1 player while they held the crown', g.ended_at);
      }
    }
  }

  return out.sort((a, b) => a.earnedAt - b.earnedAt);
}
