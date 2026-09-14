import { getActiveGame, getRoster } from '../db/queries';
import { COLORS } from '../discord/embeds';
import { container, text } from '../discord/components.ts';
import { intArg } from '../discord/custom-id.ts';
import { invoker } from '../discord/options';
import { isPlayerOrAdmin } from '../validation';
import type { Env, GameRow, Interaction, MessageData, RosterEntry } from '../types';
import type { ComponentReply } from './types.ts';

/** A one-line Components V2 message — flows use it for confirmations and errors. */
export function noteV2(content: string, accent: number = COLORS.brand): MessageData {
  return { components: [container(accent, text(content))] };
}

export const errorV2 = (msg: string): MessageData => noteV2(`❌ ${msg}`, COLORS.error);

export const ephemeral = (data: MessageData): ComponentReply => ({ kind: 'reply', data, ephemeral: true });

/**
 * Resolve the game a card button refers to. The button carries a game id; the
 * game must still be the channel's active one — a click on a stale card (the
 * game was reported, cancelled, or a new one started) is refused, not acted on.
 */
export async function activeGameFor(
  i: Interaction,
  env: Env,
  args: string[],
): Promise<{ ok: true; game: GameRow; roster: RosterEntry[] } | { ok: false; reply: ComponentReply }> {
  const gameId = intArg(args, 0);
  if (!i.guild_id || !i.channel_id || gameId === null) {
    return { ok: false, reply: ephemeral(errorV2('That button is from an older card.')) };
  }
  const game = await getActiveGame(env.DB, i.guild_id, i.channel_id);
  if (!game || game.id !== gameId) {
    return { ok: false, reply: ephemeral(errorV2('That game is no longer in progress — this card is out of date.')) };
  }
  const roster = await getRoster(env.DB, game.id);
  return { ok: true, game, roster };
}

/** Same rule as the slash commands: pod members and server admins. */
export function podOrAdmin(i: Interaction, roster: RosterEntry[]): ComponentReply | null {
  if (isPlayerOrAdmin(roster, invoker(i).id, i.member?.permissions)) return null;
  return ephemeral(errorV2('Only players in this game (or admins) can do that.'));
}
