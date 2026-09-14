/**
 * 🧙 Set commander — from the card. If the player has decks on record, an
 * ephemeral picker offers them (one click) plus "search by name"; otherwise
 * the search modal opens straight away. Typos land on a "did you mean" select
 * rather than being guessed. Only the player's own seat can be set — same
 * rule as /commander — so an admin is not offered a seat they never sat in.
 */

import { getRecentCommanders, setCommander } from '../db/queries';
import { colorEmoji, getCommanderByName, resolveCommanderIndex } from '../commanders';
import { combineCommanders } from '../scryfall';
import {
  ButtonStyle,
  LIMITS,
  button,
  container,
  label,
  row,
  stringSelect,
  text,
  textInput,
  type ModalData,
  type SelectOption,
} from '../discord/components.ts';
import { encodeId, intArg } from '../discord/custom-id.ts';
import { COLORS } from '../discord/embeds';
import { updateLiveCard } from '../discord/live-card';
import { invoker, modalValue, selectValues } from '../discord/options';
import type { Env, GameRow, Interaction, MessageData, RosterEntry } from '../types';
import { activeGameFor, ephemeral, errorV2, noteV2 } from './shared.ts';
import type { ComponentHandler, ComponentReply } from './types.ts';

const RECENT_DECKS = 5;
const MAX_QUERY = 90; // leaves room for the "as typed" option prefix within 100
const AS_TYPED = '!';

interface Seat {
  game: GameRow;
  roster: RosterEntry[];
  mine: RosterEntry;
}

/** The clicker's own seat in the channel's active game, or a refusal. */
async function mySeat(i: Interaction, env: Env, args: string[]): Promise<{ ok: true; seat: Seat } | { ok: false; reply: ComponentReply }> {
  const found = await activeGameFor(i, env, args);
  if (!found.ok) return found;
  const mine = found.roster.find((r) => r.discord_user_id === invoker(i).id);
  if (!mine) return { ok: false, reply: ephemeral(errorV2("You're not in this game's pod — only players can set their own commander.")) };
  return { ok: true, seat: { game: found.game, roster: found.roster, mine } };
}

function searchModal(gameId: number): ModalData {
  return {
    custom_id: encodeId('cmd', 'modal', gameId),
    title: 'Set your commander',
    components: [
      label('Commander', textInput('q', { placeholder: 'Search by name — typos are fine', required: true, maxLength: MAX_QUERY })),
      label(
        'Partner / Background (optional)',
        textInput('p', { placeholder: 'Second commander, if any', maxLength: MAX_QUERY }),
        'Partner, Background, Friends Forever, Doctor\'s companion',
      ),
    ],
  };
}

async function commit(env: Env, seat: Seat, name: string, art: string | null, note = ''): Promise<MessageData> {
  await setCommander(env.DB, seat.game.id, seat.mine.player_id, name, art);
  const card = await updateLiveCard(env, seat.game);
  return noteV2(`🧙 **${name}** locked in.${note}${card.hint}`, COLORS.success);
}

export const commanderFlow: Record<string, ComponentHandler> = {
  'cmd:open': async (i, env, id) => {
    const found = await mySeat(i, env, id.args);
    if (!found.ok) return found.reply;
    const { seat } = found;
    const recent = await getRecentCommanders(env.DB, seat.mine.player_id, RECENT_DECKS);
    const options: SelectOption[] = recent
      .filter((r) => r.commander.length <= LIMITS.SELECT_LABEL_CHARS)
      .map((r) => ({ label: r.commander, value: r.commander, description: `${r.games} game${r.games === 1 ? '' : 's'}` }));
    if (options.length === 0) return { kind: 'modal', data: searchModal(seat.game.id) };
    return ephemeral({
      components: [
        container(
          COLORS.brand,
          text('## 🧙 Your commander\nPick a deck you have played before, or search for a new one.'),
          row(stringSelect(encodeId('cmd', 'recent', seat.game.id), options, { placeholder: 'Recent decks' })),
          row(button(ButtonStyle.PRIMARY, 'Search by name', encodeId('cmd', 'search', seat.game.id), { emoji: '🔍' })),
        ),
      ],
    });
  },

  'cmd:search': async (i, env, id) => {
    const found = await mySeat(i, env, id.args);
    if (!found.ok) return found.reply;
    return { kind: 'modal', data: searchModal(found.seat.game.id) };
  },

  'cmd:recent': async (i, env, id) => {
    const found = await mySeat(i, env, id.args);
    if (!found.ok) return found.reply;
    const name = selectValues(i)[0];
    if (!name) return ephemeral(errorV2('Pick a deck.'));
    return {
      kind: 'deferUpdate',
      work: async () => {
        const lead = name.split(' + ')[0];
        const row = await getCommanderByName(env.DB, lead);
        return commit(env, found.seat, name, row?.artCrop ?? null);
      },
    };
  },

  'cmd:modal': async (i, env, id) => {
    const found = await mySeat(i, env, id.args);
    if (!found.ok) return found.reply;
    const { seat } = found;
    const raw = (modalValue(i, 'q') ?? '').trim().slice(0, MAX_QUERY);
    const rawPartner = (modalValue(i, 'p') ?? '').trim().slice(0, MAX_QUERY);
    if (!raw) return ephemeral(errorV2('Give me a commander name.'));
    return {
      kind: 'deferReply',
      ephemeral: true,
      work: async () => {
        const primary = await resolveCommanderIndex(env.DB, raw);

        // A typo or a shared short name with no partner: let the player choose.
        if (primary.kind === 'ambiguous' && !rawPartner) {
          const options: SelectOption[] = primary.candidates.map((c) => ({
            label: c.name.slice(0, LIMITS.SELECT_LABEL_CHARS),
            value: c.name.slice(0, LIMITS.SELECT_LABEL_CHARS),
            description: c.colors ? `${colorEmoji(c.colors)} ${c.colors}` : 'colorless',
          }));
          options.push({ label: `Use “${raw}” as typed`.slice(0, LIMITS.SELECT_LABEL_CHARS), value: AS_TYPED + raw });
          return {
            components: [
              container(
                COLORS.brand,
                text(`## Did you mean…\n-# for “${raw}”`),
                row(stringSelect(encodeId('cmd', 'pick', seat.game.id), options, { placeholder: 'Pick your commander' })),
              ),
            ],
          };
        }

        // Otherwise behave exactly like /commander: confident → canonical; ambiguous → top with a note; none → as typed.
        const pickName = (r: typeof primary, typed: string) =>
          r.kind === 'none' ? typed : r.kind === 'exact' ? r.commander.name : r.candidates[0].name;
        const partner = rawPartner ? await resolveCommanderIndex(env.DB, rawPartner) : null;
        const primaryName = pickName(primary, raw);
        const partnerName = partner ? pickName(partner, rawPartner) : null;
        const name = combineCommanders(primaryName, partnerName);
        const lead = name.split(' + ')[0];
        const artRow = await getCommanderByName(env.DB, lead);
        const notes: string[] = [];
        if (primary.kind === 'ambiguous') notes.push(`took **${primaryName}** for “${raw}”`);
        if (primary.kind === 'none') notes.push(`stored “${raw}” as typed`);
        if (partner?.kind === 'ambiguous') notes.push(`took **${partnerName}** for “${rawPartner}”`);
        if (partner?.kind === 'none') notes.push(`stored “${rawPartner}” as typed`);
        const note = notes.length ? `\n-# ${notes.join(' · ')} — re-run to change.` : '';
        return commit(env, seat, name, artRow?.artCrop ?? null, note);
      },
    };
  },

  'cmd:pick': async (i, env, id) => {
    const found = await mySeat(i, env, id.args);
    if (!found.ok) return found.reply;
    const value = selectValues(i)[0];
    if (!value) return ephemeral(errorV2('Pick a commander.'));
    return {
      kind: 'deferUpdate',
      work: async () => {
        if (value.startsWith(AS_TYPED)) return commit(env, found.seat, value.slice(1), null, '\n-# stored as typed');
        const row = await getCommanderByName(env.DB, value);
        return commit(env, found.seat, row?.name ?? value, row?.artCrop ?? null);
      },
    };
  },
};

/** Exposed for tests: the game-id argument position every cmd:* id shares. */
export const gameIdOf = (args: string[]) => intArg(args, 0);
