/**
 * The single write path for finishing a game. `/game report` calls this with
 * parsed options; the button-driven report flow calls it with the same shape.
 * Everything rating-related happens here, in this order:
 *
 *   validate → rust → pre-game odds → TrueSkill → snapshot writes → shoutouts
 */

import { buildShoutouts, type PodFact, type RankedEntry } from '../engagement/shoutouts.ts';
import {
  completeGame,
  getActiveGame,
  getGamesForPlayers,
  getGuildBoard,
  getLastPlayedAt,
  getRoster,
  type CompletionEntry,
} from '../db/queries';
import { rateGame } from '../ratings/engine.ts';
import { skillRating } from '../ratings/trueskill.ts';
import { isPlayerOrAdmin, validateReport, type PlacementInput } from '../validation';
import type { Env, GameRow, RosterEntry } from '../types';

export interface ReportRequest {
  guildId: string;
  channelId: string;
  reporterId: string;
  reporterPermissions: string | undefined;
  placements: PlacementInput[];
  draw: boolean;
  winnerOnly: boolean;
}

export type ReportOutcome =
  | { ok: false; error: string }
  | { ok: true; game: GameRow; roster: RosterEntry[]; shoutouts: string[] };

const now = () => Math.floor(Date.now() / 1000);

function rankBoard(entries: { playerId: number; username: string; mu: number; sigma: number }[]): RankedEntry[] {
  return entries
    .map((e) => ({ playerId: e.playerId, username: e.username, sr: skillRating(e.mu, e.sigma) }))
    .sort((a, b) => b.sr - a.sr || a.username.localeCompare(b.username));
}

export async function reportGame(env: Env, req: ReportRequest): Promise<ReportOutcome> {
  const active = await getActiveGame(env.DB, req.guildId, req.channelId);
  if (!active) return { ok: false, error: 'No active game in this channel. Start one with `/game start`.' };

  const roster = await getRoster(env.DB, active.id);
  if (!isPlayerOrAdmin(roster, req.reporterId, req.reporterPermissions)) {
    return { ok: false, error: 'Only players in this game (or admins) can report it.' };
  }
  const val = validateReport(
    roster.map((r) => r.discord_user_id),
    req.placements,
    { draw: req.draw, winnerOnly: req.winnerOnly },
  );
  if (!val.ok) return { ok: false, error: val.error };

  const byId = new Map(roster.map((r) => [r.discord_user_id, r]));
  const placeOf = new Map(req.placements.map((p) => [byId.get(p.userId)!.player_id, p.place]));
  const playerIds = roster.map((r) => r.player_id);
  const endedAt = now();

  const [lastPlayed, board, history] = await Promise.all([
    getLastPlayedAt(env.DB, playerIds),
    getGuildBoard(env.DB, req.guildId),
    getGamesForPlayers(env.DB, playerIds),
  ]);

  // One engine for the live path and the history replay (see src/ratings/engine.ts).
  const rated = rateGame(
    roster.map((r) => ({
      playerId: r.player_id,
      placement: placeOf.get(r.player_id)!,
      mu: r.ts_mu,
      sigma: r.ts_sigma,
      lastPlayedAt: lastPlayed.get(r.player_id) ?? null,
    })),
    { draw: req.draw, winnerOnly: req.winnerOnly, endedAt, seed: active.id },
  );
  const ordered = rated.map((x) => roster.find((r) => r.player_id === x.playerId)!);

  const before = rankBoard(board);
  const topPlayerId = before[0]?.playerId ?? null;

  const entries: CompletionEntry[] = rated.map((x) => ({
    playerId: x.playerId,
    placement: x.placement,
    muBefore: x.muBefore,
    muAfter: x.muAfter,
    sigmaBefore: x.sigmaBefore,
    sigmaAfter: x.sigmaAfter,
    sigmaRusted: x.sigmaRusted,
    rustDays: x.rustDays,
  }));
  await completeGame(env.DB, active.id, { winnerOnly: req.winnerOnly, draw: req.draw, topPlayerId }, req.reporterId, entries, endedAt);

  const game: GameRow = {
    ...active,
    status: 'completed',
    ended_at: endedAt,
    winner_only: req.winnerOnly ? 1 : 0,
    draw: req.draw ? 1 : 0,
    top_player_id: topPlayerId,
  };
  const finalRoster: RosterEntry[] = ordered.map((r, idx) => ({
    ...r,
    placement: rated[idx].placement,
    mu_before: rated[idx].muBefore,
    sigma_before: rated[idx].sigmaBefore,
    mu_after: rated[idx].muAfter,
    sigma_after: rated[idx].sigmaAfter,
    sigma_rusted: rated[idx].sigmaRusted,
    rust_days: rated[idx].rustDays,
    ts_mu: rated[idx].muAfter,
    ts_sigma: rated[idx].sigmaAfter,
  }));

  // After-board: the pre-game board with this pod's ratings replaced (new players appended).
  const ratedById = new Map(rated.map((x) => [x.playerId, x]));
  const afterEntries = board.map((b) => {
    const x = ratedById.get(b.playerId);
    return x ? { ...b, mu: x.muAfter, sigma: x.sigmaAfter } : b;
  });
  for (const [idx, r] of ordered.entries()) {
    if (!board.some((b) => b.playerId === r.player_id)) {
      afterEntries.push({ playerId: r.player_id, username: r.username, mu: rated[idx].muAfter, sigma: rated[idx].sigmaAfter, games: 0 });
    }
  }
  const after = rankBoard(afterEntries);

  const pod: PodFact[] = ordered.map((r, idx) => {
    const mine = history.filter((h) => h.player_id === r.player_id); // newest first
    let winStreak = 0;
    let lossStreak = 0;
    for (const h of mine) {
      if (h.draw) break;
      if (h.placement === 1 && lossStreak === 0) winStreak++;
      else if (h.placement !== 1 && winStreak === 0) lossStreak++;
      else break;
    }
    const x = rated[idx];
    return {
      playerId: r.player_id,
      username: r.username,
      placement: x.placement,
      srBefore: skillRating(x.muBefore, x.sigmaBefore),
      srAfter: skillRating(x.muAfter, x.sigmaAfter),
      gamesBefore: mine.length,
      personalBestBefore: mine.reduce((m, h) => Math.max(m, skillRating(h.mu_after, h.sigma_after)), 0),
      winStreakBefore: winStreak,
      lossStreakBefore: lossStreak,
      hasWonBefore: mine.some((h) => h.draw === 0 && h.placement === 1),
      preGameWinPct: x.preGameWinPct,
      rustDays: x.sigmaRusted != null ? x.rustDays : null,
    };
  });
  const shoutouts = buildShoutouts({ before, after, pod, draw: req.draw });

  return { ok: true, game, roster: finalRoster, shoutouts };
}
