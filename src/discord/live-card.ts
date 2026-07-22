import { getRoster, setGameMessageId } from '../db/queries';
import { createMessage, editMessage } from './api';
import { matchState, renderMatchCard } from './card';
import type { Env, GameRow } from '../types';

/**
 * Push a game's current state to its live card in the channel. Edits the existing
 * card when we have its id; if the card was never posted or has been deleted,
 * reposts one and relinks it so the game self-heals. Never re-pings the pod on an
 * update. Returns true if the channel now shows an up-to-date card.
 */
export async function updateLiveCard(env: Env, game: GameRow): Promise<boolean> {
  const roster = await getRoster(env.DB, game.id);
  const card = renderMatchCard(matchState(game, roster));
  card.allowed_mentions = { parse: [] }; // an edit must never re-notify the pod

  if (game.message_id) {
    const ok = await editMessage(env.DISCORD_BOT_TOKEN, game.channel_id, game.message_id, card);
    if (ok) return true;
  }
  // No card yet (a fast command beat the id capture) or the edit failed (card
  // deleted / lost access) — repost and relink so later commands edit the new one.
  const newId = await createMessage(env.DISCORD_BOT_TOKEN, game.channel_id, card);
  if (!newId) return false;
  await setGameMessageId(env.DB, game.id, newId);
  return true;
}
