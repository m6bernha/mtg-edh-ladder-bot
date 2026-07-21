import { getLatestCompletedGame, getRoster, undoGame } from '../db/queries';
import { restoreFromSnapshots } from '../db/snapshots';
import { errorMessage, successMessage } from '../discord/embeds';
import { invoker, requireGuild } from '../discord/options';
import { isPlayerOrAdmin } from '../validation';
import type { Env, Interaction, MessageData } from '../types';

export async function handleUndo(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId } = ctx;

  // Only the newest completed game may ever be undone — undoing an older one
  // would invalidate every snapshot taken after it.
  const game = await getLatestCompletedGame(env.DB, guildId);
  if (!game) return errorMessage('Nothing to undo — no completed games.');

  const roster = await getRoster(env.DB, game.id);
  const me = invoker(i);
  if (!isPlayerOrAdmin(roster, me.id, i.member?.permissions)) {
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
