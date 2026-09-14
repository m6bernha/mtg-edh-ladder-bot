/**
 * ◀ ▶ paging for the leaderboard, meta and history readouts. Stateless: the
 * page number (and the history filter) ride in the custom_id; the message is
 * re-rendered in place with UPDATE_MESSAGE.
 */

import { getPlayerByDiscordId } from '../db/queries';
import { historyMessage, leaderboardMessage, metaMessage } from '../discord/boards.ts';
import { intArg } from '../discord/custom-id.ts';
import { loadHistoryView } from '../commands/history';
import { loadMetaView } from '../commands/meta';
import { loadLeaderboardView } from '../commands/boards';
import { ephemeral, errorV2, noteV2 } from './shared.ts';
import type { ComponentHandler } from './types.ts';

const noGuild = ephemeral(errorV2('Run this in a server.'));

export const pageFlow: Record<string, ComponentHandler> = {
  'lb:page': async (i, env, id) => {
    if (!i.guild_id) return noGuild;
    const view = await loadLeaderboardView(env.DB, i.guild_id, intArg(id.args, 0) ?? 1);
    if (view.total === 0) return { kind: 'update', data: noteV2('The ladder is empty — the first `/game start` opens it.') };
    return { kind: 'update', data: leaderboardMessage(view) };
  },

  'meta:page': async (i, env, id) => {
    if (!i.guild_id) return noGuild;
    const view = await loadMetaView(env.DB, i.guild_id, intArg(id.args, 0) ?? 1);
    if (view.rows.length === 0) return { kind: 'update', data: noteV2('Nothing in the meta any more.') };
    return { kind: 'update', data: metaMessage(view) };
  },

  'hist:page': async (i, env, id) => {
    if (!i.guild_id) return noGuild;
    const userId = id.args[1] && id.args[1] !== '-' ? id.args[1] : null;
    let filter = null;
    if (userId) {
      const player = await getPlayerByDiscordId(env.DB, i.guild_id, userId);
      if (player) filter = { userId, username: player.username, playerId: player.id };
    }
    const view = await loadHistoryView(env.DB, i.guild_id, intArg(id.args, 0) ?? 1, filter);
    if (view.rows.length === 0) return { kind: 'update', data: noteV2('No games here any more.') };
    return { kind: 'update', data: historyMessage(view) };
  },
};
