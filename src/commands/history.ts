import { getPlayerByDiscordId, getRecentGames, getRecentGamesCount, type HistoryRow } from '../db/queries';
import { errorMessage, historyMessage, infoMessage } from '../discord/embeds';
import { displayName, optInteger, optString, requireGuild, resolvedUser } from '../discord/options';
import type { Env, Interaction, MessageData } from '../types';

export const HISTORY_PAGE_SIZE = 6;

export interface HistoryView {
  rows: HistoryRow[];
  page: number;
  pages: number;
  filter: { userId: string; username: string } | null;
}

export async function loadHistoryView(
  db: D1Database,
  guildId: string,
  page: number,
  filter: { userId: string; username: string; playerId: number } | null,
): Promise<HistoryView> {
  const total = await getRecentGamesCount(db, guildId, filter?.playerId);
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  const rows = await getRecentGames(db, guildId, {
    limit: HISTORY_PAGE_SIZE,
    offset: (p - 1) * HISTORY_PAGE_SIZE,
    playerId: filter?.playerId,
  });
  return { rows, page: p, pages, filter: filter ? { userId: filter.userId, username: filter.username } : null };
}

export async function handleHistory(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const opts = i.data?.options ?? [];
  const targetId = optString(opts, 'player');
  let filter: { userId: string; username: string; playerId: number } | null = null;
  if (targetId) {
    const player = await getPlayerByDiscordId(env.DB, ctx.guildId, targetId);
    if (!player) return errorMessage(`No games recorded for <@${targetId}> yet.`);
    const u = resolvedUser(i, targetId);
    filter = { userId: targetId, username: u ? displayName(u) : player.username, playerId: player.id };
  }
  const view = await loadHistoryView(env.DB, ctx.guildId, optInteger(opts, 'page') ?? 1, filter);
  if (view.rows.length === 0) return infoMessage('No completed games yet — the first `/game report` writes history.');
  return historyMessage(view);
}
