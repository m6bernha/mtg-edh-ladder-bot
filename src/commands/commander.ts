import { getActiveOrLatestGame, getRoster, setCommander } from '../db/queries';
import { errorMessage, successMessage } from '../discord/embeds';
import { CARD_PERM_HINT, updateLiveCard } from '../discord/live-card';
import { invoker, optString, requireGuildChannel } from '../discord/options';
import { combineCommanders, resolveCommander } from '../scryfall';
import type { Env, Interaction, MessageData } from '../types';

export async function handleCommander(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId, channelId } = ctx;

  const raw = (optString(i.data?.options ?? [], 'name') ?? '').trim().slice(0, 100);
  if (!raw) return errorMessage('Give me a commander name.');
  const rawPartner = (optString(i.data?.options ?? [], 'partner') ?? '').trim().slice(0, 100);

  // Canonicalize via Scryfall so stats never split across spelling variants.
  const [canonical, canonicalPartner] = await Promise.all([
    resolveCommander(raw),
    rawPartner ? resolveCommander(rawPartner) : Promise.resolve(null),
  ]);
  const unrecognized = !canonical || (!!rawPartner && !canonicalPartner);
  const primaryName = canonical?.name ?? raw;
  const partnerName = rawPartner ? (canonicalPartner?.name ?? rawPartner) : null;
  const name = combineCommanders(primaryName, partnerName);

  // Show the art of whichever card's name leads the combined identity, so the
  // thumbnail matches the name displayed first.
  const leadIsPrimary = !partnerName || name.startsWith(primaryName);
  const art = (leadIsPrimary ? canonical?.art : canonicalPartner?.art) ?? canonical?.art ?? null;

  const found = await getActiveOrLatestGame(env.DB, guildId, channelId);
  if (!found) return errorMessage('No game found in this channel — start one with `/game start`.');
  const { game, note } = found;

  // Deliberately not isPlayerOrAdmin: we need the caller's own roster row to
  // write against, and an admin has no player_id in a game they did not play.
  const roster = await getRoster(env.DB, game.id);
  const mine = roster.find((r) => r.discord_user_id === invoker(i).id);
  if (!mine) return errorMessage("You're not in that game's pod.");

  await setCommander(env.DB, game.id, mine.player_id, name, art);
  const shown = await updateLiveCard(env, game);
  const suffix = unrecognized ? ' *(stored as typed — Scryfall didn\'t recognize it)*' : '';
  return successMessage(`🧙 **${name}** locked in ${note}.${suffix}${shown ? '' : CARD_PERM_HINT}`);
}
