import {
  getActiveGame,
  getLatestCompletedGameInChannel,
  getRoster,
  setCommander,
} from '../db/queries';
import { errorMessage, successMessage } from '../discord/embeds';
import { invoker, opt } from '../discord/options';
import { resolveCommander } from '../scryfall';
import type { Env, Interaction, MessageData } from '../types';

export async function handleCommander(i: Interaction, env: Env): Promise<MessageData> {
  const guildId = i.guild_id;
  const channelId = i.channel_id;
  if (!guildId || !channelId) return errorMessage('Run this in a server channel.');

  const raw = (opt<string>(i.data?.options ?? [], 'name') ?? '').trim().slice(0, 100);
  if (!raw) return errorMessage('Give me a commander name.');
  // Canonicalize via Scryfall so stats never split across spelling variants.
  const canonical = await resolveCommander(raw);
  const name = canonical ?? raw;

  let game = await getActiveGame(env.DB, guildId, channelId);
  let note = 'for the game in progress';
  if (!game) {
    game = await getLatestCompletedGameInChannel(env.DB, guildId, channelId);
    if (game) note = `for the game that ended <t:${game.ended_at}:R>`;
  }
  if (!game) return errorMessage('No game found in this channel — start one with `/game start`.');

  const roster = await getRoster(env.DB, game.id);
  const mine = roster.find((r) => r.discord_user_id === invoker(i).id);
  if (!mine) return errorMessage("You're not in that game's pod.");

  await setCommander(env.DB, game.id, mine.player_id, name);
  const suffix = canonical ? '' : ' *(as typed — Scryfall didn\'t recognize it)*';
  return successMessage(`🧙 **${name}** locked in ${note}.${suffix}`);
}
