import { getCommanderColors } from '../commanders';
import { getCommanderMeta, getCommanderMetaCount, type CommanderMetaRow } from '../db/queries';
import { errorMessage, infoMessage, metaMessage } from '../discord/embeds';
import { optInteger, requireGuild } from '../discord/options';
import type { Env, Interaction, MessageData } from '../types';

/** A commander needs this many logged games before it appears in the meta. */
export const MIN_GAMES_FOR_META = 3;
export const META_PAGE_SIZE = 10;

export interface MetaView {
  rows: (CommanderMetaRow & { colors: string })[];
  page: number;
  pages: number;
  minGames: number;
}

export async function loadMetaView(db: D1Database, guildId: string, page: number): Promise<MetaView> {
  const total = await getCommanderMetaCount(db, guildId, MIN_GAMES_FOR_META);
  const pages = Math.max(1, Math.ceil(total / META_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  const rows = await getCommanderMeta(db, guildId, {
    minGames: MIN_GAMES_FOR_META,
    limit: META_PAGE_SIZE,
    offset: (p - 1) * META_PAGE_SIZE,
  });
  const colors = await getCommanderColors(db, rows.map((r) => r.commander));
  return {
    rows: rows.map((r) => ({ ...r, colors: colors.get(r.commander) ?? '' })),
    page: p,
    pages,
    minGames: MIN_GAMES_FOR_META,
  };
}

export async function handleMeta(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const view = await loadMetaView(env.DB, ctx.guildId, optInteger(i.data?.options ?? [], 'page') ?? 1);
  if (view.rows.length === 0) {
    return infoMessage(
      `No commander has ${MIN_GAMES_FOR_META}+ logged games yet — use \`/commander\` during games and the meta fills in.`,
    );
  }
  return metaMessage(view);
}
