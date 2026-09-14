/**
 * ⚙️ Pod settings — fix things mid-game without leaving the card: change the
 * bracket, or set/overwrite any seat's commander (for when a player logged the
 * wrong deck, or a bug left a seat wrong). Same rule as /game bracket: anyone
 * in the pod or a server admin.
 */

import { getCommanderByName, resolveCommanderIndex } from '../commanders';
import { setBracket, setCommander } from '../db/queries';
import { combineCommanders } from '../scryfall';
import {
  container,
  label,
  row,
  sep,
  stringSelect,
  text,
  textInput,
  type ModalData,
  type SelectOption,
} from '../discord/components.ts';
import { encodeId, intArg } from '../discord/custom-id.ts';
import { COLORS, bracketLabel } from '../discord/embeds';
import { updateLiveCard } from '../discord/live-card';
import { modalValue, selectValues } from '../discord/options';
import type { RosterEntry } from '../types';
import { activeGameFor, ephemeral, errorV2, noteV2, podOrAdmin } from './shared.ts';
import type { ComponentHandler } from './types.ts';

const BRACKETS: SelectOption[] = [
  { label: 'Open', value: 'open' },
  { label: 'Bracket 1 — Exhibition', value: '1' },
  { label: 'Bracket 2 — Core', value: '2' },
  { label: 'Bracket 3 — Upgraded', value: '3' },
  { label: 'Bracket 4 — Optimized', value: '4' },
  { label: 'Bracket 5 — cEDH', value: '5' },
];
const MAX_QUERY = 90;

function seatModal(gameId: number, idx: number, seat: RosterEntry): ModalData {
  return {
    custom_id: encodeId('set', 'modal', gameId, idx),
    title: `Commander for ${seat.username}`.slice(0, 45),
    components: [
      label('Commander', textInput('q', { placeholder: 'Search by name — typos are fine', required: true, maxLength: MAX_QUERY })),
      label('Partner / Background (optional)', textInput('p', { placeholder: 'Second commander, if any', maxLength: MAX_QUERY })),
    ],
  };
}

export const settingsFlow: Record<string, ComponentHandler> = {
  'set:open': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    const { game, roster } = found;
    const seats: SelectOption[] = roster.map((r, idx) => ({
      label: r.username.slice(0, 100),
      value: String(idx),
      description: (r.commander ?? 'no commander logged').slice(0, 100),
    }));
    return ephemeral({
      components: [
        container(
          COLORS.brand,
          text(`## ⚙️ Pod settings\n-# Bracket: **${bracketLabel(game.bracket)}**`),
          row(stringSelect(encodeId('set', 'bracket', game.id), BRACKETS.map((b) => ({ ...b, default: b.value === game.bracket })), { placeholder: 'Change the bracket' })),
          sep(1),
          text("**Fix a player's commander**\n-# Pick the seat, then search — overwrites whatever is logged."),
          row(stringSelect(encodeId('set', 'seat', game.id), seats, { placeholder: 'Whose commander?' })),
        ),
      ],
    });
  },

  'set:bracket': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    const bracket = selectValues(i)[0];
    if (!bracket || !BRACKETS.some((b) => b.value === bracket)) return ephemeral(errorV2('Pick a bracket.'));
    const { game } = found;
    return {
      kind: 'deferUpdate',
      work: async () => {
        await setBracket(env.DB, game.id, bracket);
        const card = await updateLiveCard(env, { ...game, bracket });
        return noteV2(`🎚️ Bracket **${bracketLabel(game.bracket)}** → **${bracketLabel(bracket)}**.${card.hint}`, COLORS.success);
      },
    };
  },

  'set:seat': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    const idx = Number.parseInt(selectValues(i)[0] ?? '', 10);
    const seat = found.roster[idx];
    if (!seat) return ephemeral(errorV2('Pick a seat.'));
    return { kind: 'modal', data: seatModal(found.game.id, idx, seat) };
  },

  'set:modal': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    const idx = intArg(id.args, 1);
    const seat = idx !== null ? found.roster[idx] : undefined;
    if (!seat) return ephemeral(errorV2('That seat is gone — open ⚙️ again.'));
    const raw = (modalValue(i, 'q') ?? '').trim().slice(0, MAX_QUERY);
    const rawPartner = (modalValue(i, 'p') ?? '').trim().slice(0, MAX_QUERY);
    if (!raw) return ephemeral(errorV2('Give me a commander name.'));
    const { game } = found;
    return {
      kind: 'deferReply',
      ephemeral: true,
      work: async () => {
        // Like /commander: confident → canonical; ambiguous → most-played, noted; none → as typed.
        const [primary, partner] = await Promise.all([
          resolveCommanderIndex(env.DB, raw),
          rawPartner ? resolveCommanderIndex(env.DB, rawPartner) : Promise.resolve(null),
        ]);
        const pickName = (r: typeof primary, typed: string) =>
          r.kind === 'none' ? typed : r.kind === 'exact' ? r.commander.name : r.candidates[0].name;
        const name = combineCommanders(pickName(primary, raw), partner ? pickName(partner, rawPartner) : null);
        const artRow = await getCommanderByName(env.DB, name.split(' + ')[0]);
        const notes: string[] = [];
        if (primary.kind !== 'exact') notes.push(primary.kind === 'none' ? `stored “${raw}” as typed` : `took the most-played match for “${raw}”`);
        if (partner && partner.kind !== 'exact') notes.push(partner.kind === 'none' ? `stored “${rawPartner}” as typed` : `took the most-played match for “${rawPartner}”`);
        await setCommander(env.DB, game.id, seat.player_id, name, artRow?.artCrop ?? null);
        const card = await updateLiveCard(env, game);
        return noteV2(
          `🧙 **${seat.username}** → **${name}**.${notes.length ? `\n-# ${notes.join(' · ')}` : ''}${card.hint}`,
          COLORS.success,
        );
      },
    };
  },
};
