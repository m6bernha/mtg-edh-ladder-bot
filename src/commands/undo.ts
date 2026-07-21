import { getLatestCompletedGame, getRoster, undoGame } from '../db/queries';
import { restoreFromSnapshots } from '../db/snapshots';
import { errorMessage, successMessage } from '../discord/embeds';
import { invoker } from '../discord/options';
import { isAdmin } from '../validation';
import type { Env, Interaction, MessageData } from '../types';

export async function handleUndo(i: Interaction, env: Env): Promise<MessageData> {
  const guildId = i.guild_id;
  if (!guildId) return errorMessage('Run this in a server.');

  // Only the newest completed game may ever be undone — undoing an older one
  // would invalidate every snapshot taken after it.
  const game = await getLatestCompletedGame(env.DB, guildId);
  if (!game) return errorMessage('Nothing to undo — no completed games.');

  const roster = await getRoster(env.DB, game.id);
  const me = invoker(i);
  if (!roster.some((r) => r.discord_user_id === me.id) && !isAdmin(i.member?.permissions)) {
    return errorMessage('Only players from that game (or admins) can undo it.');
  }

  const restores = restoreFromSnapshots(roster);
  await undoGame(env.DB, game.id, restores);

  const headline = game.draw
    ? 'a draw'
    : `🏆 ${roster.find((r) => r.placement === 1)?.username ?? 'unknown'}`;
  return successMessage(
    `↩️ Undid the last game (${headline}, ended <t:${game.ended_at}:R>). ` +
      `Ratings restored for ${roster.length} players.`,
  );
}
