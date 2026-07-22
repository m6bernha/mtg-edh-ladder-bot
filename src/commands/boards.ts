import { getLeaderboard, getPlayerByDiscordId, getPlayerGames, getSharedGames } from '../db/queries';
import { skillRating } from '../ratings/trueskill';
import {
  errorMessage,
  infoMessage,
  leaderboardMessage,
  statsMessage,
  vsMessage,
  type StatsView,
} from '../discord/embeds';
import { displayName, invoker, optString, requireGuild, resolvedUser } from '../discord/options';
import type { Env, Interaction, MessageData } from '../types';

/** How many recent games feed the form string and the SR trend on /stats. */
const RECENT_FORM_GAMES = 5;

/** A commander needs this many games before it can be called someone's "best". */
const MIN_GAMES_FOR_BEST_COMMANDER = 3;

export async function handleLeaderboard(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const rows = await getLeaderboard(env.DB, ctx.guildId);
  if (rows.length === 0) {
    return infoMessage('The ladder is empty — the first `/game start` opens it.');
  }
  return leaderboardMessage(rows);
}

export async function handleStats(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId } = ctx;
  const targetId = optString(i.data?.options ?? [], 'player') ?? invoker(i).id;
  const player = await getPlayerByDiscordId(env.DB, guildId, targetId);
  if (!player) return errorMessage(`No games recorded for <@${targetId}> yet.`);
  const games = await getPlayerGames(env.DB, player.id);
  if (games.length === 0) return errorMessage(`No completed games for <@${targetId}> yet.`);

  // newest first
  const result = (g: { placement: number; draw: number }) =>
    g.draw ? 'D' : g.placement === 1 ? 'W' : 'L';
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
    if (g.mu_after == null || g.sigma_after == null || g.mu_before == null || g.sigma_before == null) {
      return acc;
    }
    return acc + (skillRating(g.mu_after, g.sigma_after) - skillRating(g.mu_before, g.sigma_before));
  }, 0);

  const byCommander = new Map<string, { games: number; wins: number }>();
  for (const g of games) {
    if (!g.commander) continue;
    const c = byCommander.get(g.commander) ?? { games: 0, wins: 0 };
    c.games++;
    if (result(g) === 'W') c.wins++;
    byCommander.set(g.commander, c);
  }
  let mostPlayed: StatsView['mostPlayed'];
  let best: StatsView['best'];
  for (const [name, c] of byCommander) {
    if (!mostPlayed || c.games > mostPlayed.games) mostPlayed = { name, games: c.games };
    if (c.games >= MIN_GAMES_FOR_BEST_COMMANDER) {
      const winPct = Math.round((c.wins / c.games) * 100);
      if (!best || winPct > best.winPct) best = { name, winPct, games: c.games };
    }
  }

  const targetUser = resolvedUser(i, targetId);
  const view: StatsView = {
    username: targetUser ? displayName(targetUser) : player.username,
    sr: skillRating(player.ts_mu, player.ts_sigma),
    mu: player.ts_mu,
    sigma: player.ts_sigma,
    wins,
    losses,
    draws,
    games: games.length,
    winPct: Math.round((wins / games.length) * 100),
    placementCounts,
    avgDuration:
      games.reduce((acc, g) => acc + (g.ended_at - g.started_at), 0) / games.length,
    streak: `${first}${streakLen}`,
    form,
    srTrendRecent,
    mostPlayed,
    best,
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
