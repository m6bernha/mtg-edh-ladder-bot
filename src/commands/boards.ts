import { getCommanderByName } from '../commanders';
import {
  getGuildBoard,
  getLeaderboard,
  getLeaderboardCount,
  getPlayerByDiscordId,
  getPlayerGames,
  getPodSnapshotsForPlayer,
  getRecentResults,
  getRivals,
  getSharedGames,
} from '../db/queries';
import { computeBadges } from '../engagement/achievements.ts';
import { skillRating } from '../ratings/trueskill.ts';
import {
  leaderboardMessage,
  statsMessage,
  vsMessage,
  type LeaderboardEntry,
  type LeaderboardView,
  type StatsView,
} from '../discord/boards.ts';
import { errorMessage, infoMessage } from '../discord/embeds';
import { displayName, invoker, optInteger, optString, requireGuild, resolvedUser } from '../discord/options';
import type { Env, Interaction, MessageData } from '../types';

/** How many recent games feed the form string and the SR trend. */
const RECENT_FORM_GAMES = 5;
/** How many recent games the SR sparkline on /stats spans. */
const SPARKLINE_GAMES = 10;
/** A commander needs this many games before it can be called someone's "best". */
const MIN_GAMES_FOR_BEST_COMMANDER = 3;
/** Sigma above which a player is marked as still settling on the ladder. */
const PROVISIONAL_SIGMA = 6;
export const LEADERBOARD_PAGE_SIZE = 15;

const result = (g: { placement: number | null; draw: number }) => (g.draw ? 'D' : g.placement === 1 ? 'W' : 'L');

/** Build one leaderboard page. Shared by /leaderboard and the ◀ ▶ buttons. */
export async function loadLeaderboardView(db: D1Database, guildId: string, page: number): Promise<LeaderboardView> {
  const total = await getLeaderboardCount(db, guildId);
  const pages = Math.max(1, Math.ceil(total / LEADERBOARD_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  const [rows, recent] = await Promise.all([
    getLeaderboard(db, guildId, LEADERBOARD_PAGE_SIZE, (p - 1) * LEADERBOARD_PAGE_SIZE),
    getRecentResults(db, guildId, RECENT_FORM_GAMES),
  ]);

  // Rank before each player's newest game: rank the whole guild by the SR it
  // held then (everyone else's current SR stands in — the exact answer would
  // need a full replay; this is the movement a player actually experienced).
  const byPlayer = new Map<number, typeof recent>();
  for (const r of recent) {
    const list = byPlayer.get(r.player_id) ?? [];
    list.push(r);
    byPlayer.set(r.player_id, list);
  }
  const currentSr = new Map<number, number>();
  const allRows = total <= LEADERBOARD_PAGE_SIZE ? rows : await getLeaderboard(db, guildId, total, 0);
  for (const r of allRows) currentSr.set(r.id, skillRating(r.ts_mu, r.ts_sigma));
  const previousRank = (playerId: number): number | null => {
    const newest = byPlayer.get(playerId)?.find((r) => r.rn === 1);
    if (!newest || newest.mu_before == null || newest.sigma_before == null) return null;
    const mySr = skillRating(newest.mu_before, newest.sigma_before);
    let above = 0;
    for (const [id, sr] of currentSr) if (id !== playerId && sr > mySr) above++;
    return above + 1;
  };

  const entries: LeaderboardEntry[] = rows.map((r, i) => ({
    rank: (p - 1) * LEADERBOARD_PAGE_SIZE + i + 1,
    previousRank: previousRank(r.id),
    username: r.username,
    sr: skillRating(r.ts_mu, r.ts_sigma),
    provisional: r.ts_sigma > PROVISIONAL_SIGMA,
    wins: r.wins,
    losses: r.games - r.wins - r.draws,
    draws: r.draws,
    form: (byPlayer.get(r.id) ?? [])
      .sort((a, b) => b.rn - a.rn)
      .map(result),
    lastPlayedAt: r.last_played_at,
  }));
  return { entries, page: p, pages, total };
}

export async function handleLeaderboard(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const view = await loadLeaderboardView(env.DB, ctx.guildId, optInteger(i.data?.options ?? [], 'page') ?? 1);
  if (view.total === 0) return infoMessage('The ladder is empty — the first `/game start` opens it.');
  return leaderboardMessage(view);
}

export async function handleStats(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId } = ctx;
  const targetId = optString(i.data?.options ?? [], 'player') ?? invoker(i).id;
  const player = await getPlayerByDiscordId(env.DB, guildId, targetId);
  if (!player) return errorMessage(`No games recorded for <@${targetId}> yet.`);
  const games = await getPlayerGames(env.DB, player.id); // newest first
  if (games.length === 0) return errorMessage(`No completed games for <@${targetId}> yet.`);

  const wins = games.filter((g) => result(g) === 'W').length;
  const draws = games.filter((g) => result(g) === 'D').length;
  const losses = games.length - wins - draws;

  const placementCounts: number[] = [];
  for (const g of games) {
    if (g.draw) continue;
    placementCounts[g.placement - 1] = (placementCounts[g.placement - 1] ?? 0) + 1;
  }
  for (let k = 0; k < placementCounts.length; k++) placementCounts[k] ??= 0;

  const first = result(games[0]);
  let streakLen = 0;
  for (const g of games) {
    if (result(g) === first) streakLen++;
    else break;
  }
  const recent = games.slice(0, RECENT_FORM_GAMES);
  const form = recent.map(result).reverse(); // oldest→newest
  const srTrendRecent = recent.reduce((acc, g) => {
    if (g.mu_after == null || g.sigma_after == null || g.mu_before == null || g.sigma_before == null) return acc;
    return acc + (skillRating(g.mu_after, g.sigma_after) - skillRating(g.mu_before, g.sigma_before));
  }, 0);
  const srSeries = games
    .slice(0, SPARKLINE_GAMES)
    .reverse()
    .map((g) => skillRating(g.mu_after, g.sigma_after));

  const perBracketMap = new Map<string, { games: number; wins: number }>();
  for (const g of games) {
    const b = perBracketMap.get(g.bracket) ?? { games: 0, wins: 0 };
    b.games++;
    if (result(g) === 'W') b.wins++;
    perBracketMap.set(g.bracket, b);
  }
  const perBracket = [...perBracketMap.entries()]
    .map(([bracket, b]) => ({ bracket, ...b }))
    .sort((a, b) => b.games - a.games);

  const byCommander = new Map<string, { games: number; wins: number }>();
  for (const g of games) {
    if (!g.commander) continue;
    const c = byCommander.get(g.commander) ?? { games: 0, wins: 0 };
    c.games++;
    if (result(g) === 'W') c.wins++;
    byCommander.set(g.commander, c);
  }
  let mostPlayed: { name: string; games: number } | undefined;
  let best: StatsView['best'];
  for (const [name, c] of byCommander) {
    if (!mostPlayed || c.games > mostPlayed.games) mostPlayed = { name, games: c.games };
    if (c.games >= MIN_GAMES_FOR_BEST_COMMANDER) {
      const winPct = Math.round((c.wins / c.games) * 100);
      if (!best || winPct > best.winPct) best = { name, winPct, games: c.games };
    }
  }

  // Ladder position, rivals, badges, art: indexed reads plus pure derivation.
  const [board, pods, rivals, art] = await Promise.all([
    getGuildBoard(env.DB, guildId),
    getPodSnapshotsForPlayer(env.DB, player.id),
    getRivals(env.DB, player.id),
    mostPlayed ? getCommanderByName(env.DB, mostPlayed.name.split(' + ')[0]) : Promise.resolve(null),
  ]);
  const tops = new Map(games.map((g) => [g.game_id, g.top_player_id]));
  const ranked = board.map((b) => ({ id: b.playerId, sr: skillRating(b.mu, b.sigma) })).sort((a, b) => b.sr - a.sr);
  const position = ranked.findIndex((r) => r.id === player.id);
  const badges = computeBadges(games, pods, tops, player.id);
  const nemesis = [...rivals].sort((a, b) => b.above_me - a.above_me || a.username.localeCompare(b.username))[0];
  const victim = [...rivals].sort((a, b) => b.below_me - a.below_me || a.username.localeCompare(b.username))[0];

  const targetUser = resolvedUser(i, targetId);
  const view: StatsView = {
    username: targetUser ? displayName(targetUser) : player.username,
    rank: position === -1 ? undefined : { rank: position + 1, of: ranked.length },
    sr: skillRating(player.ts_mu, player.ts_sigma),
    mu: player.ts_mu,
    sigma: player.ts_sigma,
    wins,
    losses,
    draws,
    games: games.length,
    winPct: Math.round((wins / games.length) * 100),
    placementCounts,
    avgDuration: games.reduce((acc, g) => acc + (g.ended_at - g.started_at), 0) / games.length,
    streak: `${first}${streakLen}`,
    form,
    srTrendRecent,
    srSeries,
    perBracket,
    nemesis: nemesis && nemesis.above_me > 0 ? { username: nemesis.username, above: nemesis.above_me, shared: nemesis.shared } : undefined,
    victim: victim && victim.below_me > 0 ? { username: victim.username, below: victim.below_me, shared: victim.shared } : undefined,
    mostPlayed: mostPlayed ? { ...mostPlayed, art: art?.artCrop ?? null } : undefined,
    best,
    badges,
  };
  return statsMessage(view);
}

export async function handleVs(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId } = ctx;
  const aId = optString(i.data?.options ?? [], 'player_a');
  const bId = optString(i.data?.options ?? [], 'player_b');
  if (!aId || !bId) return errorMessage('Pick two players.');
  if (aId === bId) return errorMessage('Pick two *different* players — no shadowboxing.');

  const [a, b] = await Promise.all([
    getPlayerByDiscordId(env.DB, guildId, aId),
    getPlayerByDiscordId(env.DB, guildId, bId),
  ]);
  if (!a) return errorMessage(`No games recorded for <@${aId}> yet.`);
  if (!b) return errorMessage(`No games recorded for <@${bId}> yet.`);

  const rows = await getSharedGames(env.DB, guildId, a.id, b.id);
  if (rows.length === 0) {
    return errorMessage(`${a.username} and ${b.username} haven't shared a pod yet.`);
  }

  const decisive = rows.filter((r) => !r.draw);
  const aAbove = decisive.filter((r) => r.pa < r.pb).length;
  const bAbove = decisive.filter((r) => r.pb < r.pa).length;
  const durations = rows.map((r) => r.ended_at - r.started_at);
  return vsMessage({
    nameA: a.username,
    nameB: b.username,
    shared: rows.length,
    aAbove,
    bAbove,
    even: rows.length - aAbove - bAbove,
    aWins: decisive.filter((r) => r.pa === 1).length,
    bWins: decisive.filter((r) => r.pb === 1).length,
    avgA: decisive.length ? decisive.reduce((s, r) => s + r.pa, 0) / decisive.length : 0,
    avgB: decisive.length ? decisive.reduce((s, r) => s + r.pb, 0) / decisive.length : 0,
    longest: Math.max(...durations),
    fastest: Math.min(...durations),
  });
}
