import { getSettings, setDigestChannel } from '../db/queries';
import { errorMessage, infoMessage, successMessage } from '../discord/embeds';
import { getSub, invoker, optString, requireGuild } from '../discord/options';
import { isAdmin } from '../validation';
import type { Env, Interaction, MessageData } from '../types';

/**
 * /config digest-channel [#channel] — where the weekly digest posts. Admin only
 * (registered with default_member_permissions, and re-checked here because
 * that gate is a server setting an admin can loosen).
 */
export async function handleConfig(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuild(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  if (!isAdmin(i.member?.permissions)) return errorMessage('Only server admins can change bot settings.');
  const sub = getSub(i);
  if (!sub) return errorMessage('Missing subcommand.');

  if (sub.name === 'digest-channel') {
    const channelId = optString(sub.options, 'channel');
    if (!channelId) {
      const current = await getSettings(env.DB, ctx.guildId);
      return infoMessage(
        current?.digest_channel_id
          ? `📬 The weekly digest posts to <#${current.digest_channel_id}> every Monday.`
          : '📬 No digest channel set — `/config digest-channel #channel` turns it on.',
      );
    }
    await setDigestChannel(env.DB, ctx.guildId, channelId, invoker(i).id);
    return successMessage(
      `📬 Weekly digest will post to <#${channelId}> every Monday. ` +
        'Make sure I can **View Channel** and **Send Messages** there. `/config digest-off` stops it.',
    );
  }
  if (sub.name === 'digest-off') {
    await setDigestChannel(env.DB, ctx.guildId, null, invoker(i).id);
    return successMessage('📭 Weekly digest turned off.');
  }
  return errorMessage(`Unknown setting: ${sub.name}`);
}
