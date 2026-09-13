import { getActiveOrLatestGame, getRoster, setCommander } from '../db/queries';
import { errorMessage, successMessage } from '../discord/embeds';
import { updateLiveCard } from '../discord/live-card';
import { invoker, optString, requireGuildChannel } from '../discord/options';
import { combineCommanders } from '../scryfall';
import { colorEmoji, getCommanderByName, resolveCommanderIndex, type CommanderResolution } from '../commanders';
import type { Env, Interaction, MessageData } from '../types';

/** One resolved input: what to store, its art, and whether we had to guess. */
interface Resolved {
  name: string;
  art: string | null;
  note: string;
}

/**
 * Turn a resolution into the deck-identity text to store. Confident matches are
 * canonical names; an ambiguous match stores the top candidate but says so, and
 * lists the alternatives so the player can re-run the command with the exact
 * name (autocomplete offers them). Nothing ever blocks logging a deck.
 */
async function pick(db: D1Database, raw: string, r: CommanderResolution): Promise<Resolved> {
  if (r.kind === 'exact') return { name: r.commander.name, art: r.commander.artCrop, note: '' };
  if (r.kind === 'ambiguous') {
    const top = r.candidates[0];
    const others = r.candidates
      .slice(1, 4)
      .map((c) => `${colorEmoji(c.colors)} ${c.name}`)
      .join(' · ');
    const row = await getCommanderByName(db, top.name);
    return {
      name: top.name,
      art: row?.artCrop ?? null,
      note:
        `\n-# Took **${top.name}** for “${raw}”.` +
        (others ? ` Not it? Also matched: ${others} — re-run \`/commander\` and pick from the list.` : ''),
    };
  }
  return { name: raw, art: null, note: `\n-# Stored “${raw}” as typed — no commander matched.` };
}

export async function handleCommander(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId, channelId } = ctx;

  const raw = (optString(i.data?.options ?? [], 'name') ?? '').trim().slice(0, 100);
  if (!raw) return errorMessage('Give me a commander name.');
  const rawPartner = (optString(i.data?.options ?? [], 'partner') ?? '').trim().slice(0, 100);

  // Canonicalize so stats never split across spelling variants. The index is
  // typo-tolerant; a Scryfall fuzzy lookup is the fallback while it is empty.
  const [primary, partner] = await Promise.all([
    resolveCommanderIndex(env.DB, raw).then((r) => pick(env.DB, raw, r)),
    rawPartner
      ? resolveCommanderIndex(env.DB, rawPartner).then((r) => pick(env.DB, rawPartner, r))
      : Promise.resolve<Resolved | null>(null),
  ]);
  const name = combineCommanders(primary.name, partner?.name ?? null);

  // Art follows whichever card's name leads the combined identity, so the
  // thumbnail matches the name displayed first.
  const leadIsPrimary = !partner || name.startsWith(primary.name);
  const art = (leadIsPrimary ? primary.art : partner?.art) ?? primary.art ?? partner?.art ?? null;

  const found = await getActiveOrLatestGame(env.DB, guildId, channelId);
  if (!found) return errorMessage('No game found in this channel — start one with `/game start`.');
  const { game, note } = found;

  // Deliberately not isPlayerOrAdmin: we need the caller's own roster row to
  // write against, and an admin has no player_id in a game they did not play.
  const roster = await getRoster(env.DB, game.id);
  const mine = roster.find((r) => r.discord_user_id === invoker(i).id);
  if (!mine) return errorMessage("You're not in that game's pod.");

  await setCommander(env.DB, game.id, mine.player_id, name, art);
  const card = await updateLiveCard(env, game);
  return successMessage(`🧙 **${name}** locked in ${note}.${primary.note}${partner?.note ?? ''}${card.hint}`);
}
