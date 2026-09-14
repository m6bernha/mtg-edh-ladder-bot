/**
 * Weekly digest: what happened on the ladder over a rolling window. Pure —
 * everything derives from the seats played in the window plus the current
 * board. Returns null for a quiet week so the cron posts nothing.
 */

import type { DigestSeatRow } from '../db/queries';
import { skillRating } from '../ratings/trueskill.ts';

export interface DigestView {
  games: number;
  players: number;
  mostActive: { username: string; games: number } | null;
  biggestClimber: { username: string; delta: number } | null;
  commanderOfWeek: { name: string; games: number; wins: number } | null;
  top3: { username: string; sr: number }[];
  longest: { seconds: number; winner: string | null } | null;
}

export interface BoardSnapshot {
  username: string;
  sr: number;
}

export function buildDigest(seats: DigestSeatRow[], board: BoardSnapshot[]): DigestView | null {
  const gameIds = new Set(seats.map((s) => s.game_id));
  if (gameIds.size === 0) return null;

  const perPlayer = new Map<number, { username: string; games: number; delta: number }>();
  const perCommander = new Map<string, { games: number; wins: number }>();
  const perGame = new Map<number, { seconds: number; winner: string | null }>();

  for (const s of seats) {
    const p = perPlayer.get(s.player_id) ?? { username: s.username, games: 0, delta: 0 };
    p.games++;
    if (s.mu_before != null && s.sigma_before != null && s.mu_after != null && s.sigma_after != null) {
      p.delta += skillRating(s.mu_after, s.sigma_after) - skillRating(s.mu_before, s.sigma_before);
    }
    perPlayer.set(s.player_id, p);

    if (s.commander) {
      const c = perCommander.get(s.commander) ?? { games: 0, wins: 0 };
      c.games++;
      if (s.draw === 0 && s.placement === 1) c.wins++;
      perCommander.set(s.commander, c);
    }

    const g = perGame.get(s.game_id) ?? { seconds: s.ended_at - s.started_at, winner: null };
    if (s.draw === 0 && s.placement === 1) g.winner = s.username;
    perGame.set(s.game_id, g);
  }

  const players = [...perPlayer.values()];
  const mostActive = players.sort((a, b) => b.games - a.games || a.username.localeCompare(b.username))[0] ?? null;
  const climber = [...perPlayer.values()].sort((a, b) => b.delta - a.delta || a.username.localeCompare(b.username))[0];
  const commanders = [...perCommander.entries()].sort(
    (a, b) => b[1].games - a[1].games || b[1].wins - a[1].wins || a[0].localeCompare(b[0]),
  );
  const longest = [...perGame.values()].sort((a, b) => b.seconds - a.seconds)[0] ?? null;

  return {
    games: gameIds.size,
    players: perPlayer.size,
    mostActive: mostActive ? { username: mostActive.username, games: mostActive.games } : null,
    biggestClimber: climber && climber.delta > 0 ? { username: climber.username, delta: climber.delta } : null,
    commanderOfWeek: commanders[0] ? { name: commanders[0][0], ...commanders[0][1] } : null,
    top3: board.slice(0, 3),
    longest,
  };
}
