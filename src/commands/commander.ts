import {
  getActiveGame,
  getLatestCompletedGameInChannel,
  getRoster,
  setCommander,
} from '../db/queries';
import { errorMessage, successMessage } from '../discord/embeds';
import { invoker, opt } from '../discord/options';
import { combineCommanders, resolveCommander } from '../scryfall';
import type { Env, Interaction, MessageData } from '../types';

export async function handleCommander(i: Interaction, env: Env): Promise<MessageData> {
  const guildId = i.guild_id;
  const channelId = i.channel_id;
  if (!guildId || !channelId) return errorMessage('Run this in a server channel.');

  const raw = (opt<string>(i.data?.options ?? [], 'name') ?? '').trim().slice(0, 100);
  if (!raw) return errorMessage('Give me a commander name.');
  const rawPartner = (opt<string>(i.data?.options ?? [], 'partner') ?? '').trim().slice(0, 100);

  // Canonicalize via Scryfall so stats never split across spelling variants.
  const [canonical, canonicalPartner] = await Promise.all([
    resolveCommander(raw),
    rawPartner ? resolveCommander(rawPartner) : Promise.resolve(null),
  ]);
  const unrecognized = !canonical || (!!rawPartner && !canonicalPartner);
  const name = combineCommanders(canonical ?? raw, rawPartner ? (canonicalPartner ?? rawPartner) : null);

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
  const suffix = unrecognized ? ' *(part stored as typed — Scryfall didn\'t recognize it)*' : '';
  return successMessage(`🧙 **${name}** locked in ${note}.${suffix}`);
}
