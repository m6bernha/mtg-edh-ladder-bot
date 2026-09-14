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
import { predictWinProbabilities } from '../ratings/predict.ts';
import { applyRust } from '../ratings/rust.ts';
import { computeTrueSkill, skillRating } from '../ratings/trueskill.ts';
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
  const ordered = [...req.placements].sort((a, b) => a.place - b.place).map((p) => byId.get(p.userId)!);
  const playerIds = ordered.map((r) => r.player_id);
  const endedAt = now();

  const [lastPlayed, board, history] = await Promise.all([
    getLastPlayedAt(env.DB, playerIds),
    getGuildBoard(env.DB, req.guildId),
    getGamesForPlayers(env.DB, playerIds),
  ]);

  // Rust: inflate sigma for time away. The engine sees the rusted value; the
  // snapshot keeps the raw one so /undo restores exactly what was stored.
  const rust = ordered.map((r) => applyRust(r.ts_sigma, lastPlayed.get(r.player_id) ?? null, endedAt));
  const ratingsIn = ordered.map((r, i) => ({ mu: r.ts_mu, sigma: rust[i].sigma }));
  const places = ordered.map((_, idx) => idx + 1);
  const odds = predictWinProbabilities(ratingsIn, active.id);
  const newTs = computeTrueSkill(ratingsIn, places, { draw: req.draw, winnerOnly: req.winnerOnly });

  const before = rankBoard(board);
  const topPlayerId = before[0]?.playerId ?? null;

  const entries: CompletionEntry[] = ordered.map((r, idx) => ({
    playerId: r.player_id,
    placement: req.draw ? 1 : idx + 1, // a draw is everyone tied for 1st
    muBefore: r.ts_mu,
    muAfter: newTs[idx].mu,
    sigmaBefore: r.ts_sigma,
    sigmaAfter: newTs[idx].sigma,
    sigmaRusted: rust[idx].rusted ? rust[idx].sigma : null,
    rustDays: rust[idx].daysIdle,
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
    placement: entries[idx].placement,
    mu_before: r.ts_mu,
    sigma_before: r.ts_sigma,
    mu_after: newTs[idx].mu,
    sigma_after: newTs[idx].sigma,
    sigma_rusted: entries[idx].sigmaRusted,
    rust_days: entries[idx].rustDays,
    ts_mu: newTs[idx].mu,
    ts_sigma: newTs[idx].sigma,
  }));

  // After-board: the pre-game board with this pod's ratings replaced (new players appended).
  const afterEntries = board.map((b) => {
    const i = playerIds.indexOf(b.playerId);
    return i === -1 ? b : { ...b, mu: newTs[i].mu, sigma: newTs[i].sigma };
  });
  for (const [i, r] of ordered.entries()) {
    if (!board.some((b) => b.playerId === r.player_id)) {
      afterEntries.push({ playerId: r.player_id, username: r.username, mu: newTs[i].mu, sigma: newTs[i].sigma, games: 0 });
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
    return {
      playerId: r.player_id,
      username: r.username,
      placement: entries[idx].placement,
      srBefore: skillRating(r.ts_mu, r.ts_sigma),
      srAfter: skillRating(newTs[idx].mu, newTs[idx].sigma),
      gamesBefore: mine.length,
      personalBestBefore: mine.reduce((m, h) => Math.max(m, skillRating(h.mu_after, h.sigma_after)), 0),
      winStreakBefore: winStreak,
      lossStreakBefore: lossStreak,
      hasWonBefore: mine.some((h) => h.draw === 0 && h.placement === 1),
      preGameWinPct: odds[idx],
      rustDays: rust[idx].rusted ? rust[idx].daysIdle : null,
    };
  });
  const shoutouts = buildShoutouts({ before, after, pod, draw: req.draw });

  return { ok: true, game, roster: finalRoster, shoutouts };
}
