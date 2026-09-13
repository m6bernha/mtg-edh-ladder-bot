import { getRoster, setGameMessageId } from '../db/queries';
import { createMessage, editMessage, type BotCallResult } from './api';
import { matchState, renderMatchCard } from './card';
import type { Env, GameRow } from '../types';

/** Result of a live-card refresh: either the channel shows an up-to-date card, or a hint saying why not. */
export type LiveCardResult = { ok: true; hint: '' } | { ok: false; hint: string };

// Discord JSON error codes — https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
const MISSING_ACCESS = 50001; // bot can't see the channel, or isn't a member of the server at all
const MISSING_PERMISSIONS = 50013; // bot sees the channel but lacks a permission there

/**
 * Turn a failed bot-token call into a hint the caller can append to its reply.
 * Surfaced so a failure doesn't read as success (the write itself still landed
 * in the database) — and so it names the real cause: a rejected token is not a
 * channel-permission problem, and telling the admin to re-grant permissions
 * that are already there just wastes a night (see ARCHITECTURE.md).
 */
export function cardFailureHint(r: BotCallResult): string {
  const detail = r.message ? ` (Discord said: “${r.message}”)` : '';
  switch (r.status) {
    case 401:
      return (
        "\n\n⚠️ I couldn't update the pod card: Discord **rejected my bot token** (401)" +
        `${detail}. The \`DISCORD_BOT_TOKEN\` secret is stale or corrupted — an admin must ` +
        're-push it to the Worker (see README → Self-hosting).'
      );
    case 403:
      if (r.code === MISSING_ACCESS) {
        return (
          "\n\n⚠️ I couldn't update the pod card: Discord says I have **no access to this channel**" +
          `${detail}. Either grant me **View Channel** here, or — if I'm not in the server's member ` +
          'list at all — re-invite me with the `bot` scope.'
        );
      }
      if (r.code === MISSING_PERMISSIONS) {
        return (
          "\n\n⚠️ I couldn't update the pod card: I can see this channel but lack a permission" +
          `${detail}. Grant me **Send Messages** (and **Embed Links**) here.`
        );
      }
      return (
        "\n\n⚠️ I couldn't update the pod card: Discord returned 403" +
        (r.message
          ? `${detail}.`
          : ' with no error body — that is Discord\'s WAF, not a permission problem; check the ' +
            'Worker\'s User-Agent header.')
      );
    case 404:
      return "\n\n⚠️ I couldn't update the pod card: Discord can't find this channel (404)" + detail + '.';
    case 429:
      return "\n\n⚠️ I couldn't update the pod card: Discord is rate-limiting me — run the command again in a moment.";
    case 0:
      return "\n\n⚠️ I couldn't update the pod card: couldn't reach Discord's API" + detail + '. Try again.';
    default:
      return `\n\n⚠️ I couldn't update the pod card: Discord returned ${r.status}${detail}.`;
  }
}

/**
 * Push a game's current state to its live card in the channel. Edits the existing
 * card when we have its id; if the card was never posted or has been deleted,
 * reposts one and relinks it so the game self-heals. Never re-pings the pod on an
 * update. Returns `ok: true` if the channel now shows an up-to-date card, else a
 * hint explaining the failure for the caller to append to its reply.
 */
export async function updateLiveCard(env: Env, game: GameRow): Promise<LiveCardResult> {
  const roster = await getRoster(env.DB, game.id);
  const card = renderMatchCard(matchState(game, roster));
  card.allowed_mentions = { parse: [] }; // an edit must never re-notify the pod

  if (game.message_id) {
    const edited = await editMessage(env.DISCORD_BOT_TOKEN, game.channel_id, game.message_id, card);
    if (edited.ok) return { ok: true, hint: '' };
  }
  // No card yet (a fast command beat the id capture) or the edit failed (card
  // deleted / lost access) — repost and relink so later commands edit the new one.
  // The repost's failure is the one we report: it is the cleaner probe, since a
  // POST to the channel needs no message id and fails for exactly one reason.
  const posted = await createMessage(env.DISCORD_BOT_TOKEN, game.channel_id, card);
  if (!posted.ok || !posted.id) return { ok: false, hint: cardFailureHint(posted) };
  await setGameMessageId(env.DB, game.id, posted.id);
  return { ok: true, hint: '' };
}
