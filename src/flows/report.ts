/**
 * 🏁 Report result — a guided ephemeral flow: pick who finished 1st, 2nd, …
 * from a select menu, or switch to winner-only / draw, then confirm. The
 * draft lives entirely in the custom_id (mode + roster indices), so there is
 * no table, no TTL and no cross-player collision; every click re-reads the
 * roster (ordered by player id, so indices are stable) and re-checks who may act.
 */

import { followUp } from '../discord/api';
import {
  ButtonStyle,
  button,
  container,
  row,
  sep,
  stringSelect,
  text,
  type ContainerChild,
  type SelectOption,
} from '../discord/components.ts';
import { decodeOrder, encodeId, encodeOrder, intArg } from '../discord/custom-id.ts';
import { COLORS, MEDALS } from '../discord/embeds';
import { renderMatchCard, matchState } from '../discord/card.ts';
import { updateLiveCard } from '../discord/live-card';
import { invoker, selectValues } from '../discord/options';
import { reportGame } from '../services/report.ts';
import { withShoutouts } from '../discord/boards.ts';
import type { MessageData, RosterEntry } from '../types';
import type { PlacementInput } from '../validation';
import { activeGameFor, ephemeral, errorV2, noteV2, podOrAdmin } from './shared.ts';
import type { ComponentHandler, ComponentReply } from './types.ts';

export type ReportMode = 'f' | 'w' | 'd';
export interface ReportDraft {
  mode: ReportMode;
  /** Roster indices in finishing order (1st first). */
  order: number[];
}

const MODE_LABEL: Record<ReportMode, string> = {
  f: 'Full placements',
  w: 'Winner only — everyone else tied',
  d: 'Draw — everyone tied',
};

export function isMode(s: string | undefined): s is ReportMode {
  return s === 'f' || s === 'w' || s === 'd';
}

/** Pure: is the draft complete, and if not, which place is being picked next? */
export function draftStatus(draft: ReportDraft, rosterSize: number): { done: boolean; nextPlace: number } {
  if (draft.mode === 'd') return { done: true, nextPlace: 0 };
  const need = draft.mode === 'w' ? 1 : Math.max(1, rosterSize - 1);
  const done = draft.order.length >= need;
  return { done, nextPlace: done ? 0 : draft.order.length + 1 };
}

/** Pure: a complete draft → the placements /game report would have received. */
export function toPlacements(draft: ReportDraft, roster: RosterEntry[]): PlacementInput[] {
  const out: PlacementInput[] = [];
  const used = new Set<number>();
  draft.order.forEach((idx, i) => {
    used.add(idx);
    out.push({ userId: roster[idx].discord_user_id, place: i + 1 });
  });
  // Everyone not explicitly placed fills the remaining slots in roster order.
  roster.forEach((r, idx) => {
    if (!used.has(idx)) out.push({ userId: r.discord_user_id, place: out.length + 1 });
  });
  return out;
}

function sanitize(draft: ReportDraft, rosterSize: number): ReportDraft {
  const seen = new Set<number>();
  const order = draft.order.filter((i) => i < rosterSize && !seen.has(i) && seen.add(i));
  return { mode: draft.mode, order: draft.mode === 'd' ? [] : order };
}

const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

/** Pure: the ephemeral step message for a draft. */
export function renderReportStep(gameId: number, draft: ReportDraft, roster: RosterEntry[]): MessageData {
  const { done, nextPlace } = draftStatus(draft, roster.length);
  const orderArg = encodeOrder(draft.order);
  const children: ContainerChild[] = [text(`## 🏁 Report the result\n-# ${MODE_LABEL[draft.mode]}`)];

  // Picks so far.
  const picked: string[] = [];
  if (draft.mode === 'd') {
    picked.push(`🤝 ${roster.map((r) => `**${r.username}**`).join(', ')}`);
  } else {
    draft.order.forEach((idx, i) => picked.push(`${MEDALS[i] ?? `${i + 1}.`} **${roster[idx].username}**`));
    if (draft.mode === 'w' && done) {
      const rest = roster.filter((_, idx) => !draft.order.includes(idx)).map((r) => r.username);
      if (rest.length) picked.push(`-# tied: ${rest.join(', ')}`);
    }
    if (draft.mode === 'f' && done) {
      const last = roster.findIndex((_, idx) => !draft.order.includes(idx));
      if (last !== -1) picked.push(`${MEDALS[draft.order.length] ?? `${draft.order.length + 1}.`} **${roster[last].username}**`);
    }
  }
  if (picked.length) children.push(text(picked.join('\n')));

  if (!done) {
    const options: SelectOption[] = roster
      .map((r, idx) => ({ r, idx }))
      .filter(({ idx }) => !draft.order.includes(idx))
      .map(({ r, idx }) => ({
        label: r.username.slice(0, 100),
        value: String(idx),
        description: (r.commander ?? 'no commander logged').slice(0, 100),
      }));
    children.push(
      row(
        stringSelect(encodeId('rep', 'pick', gameId, draft.mode, orderArg), options, {
          placeholder: draft.mode === 'w' ? 'Who won?' : `Who finished ${ordinal(nextPlace)}?`,
        }),
      ),
    );
  }

  children.push(
    sep(1),
    row(
      button(ButtonStyle.SECONDARY, 'Full placements', encodeId('rep', 'mode', gameId, 'f'), { disabled: draft.mode === 'f' }),
      button(ButtonStyle.SECONDARY, 'Winner only', encodeId('rep', 'mode', gameId, 'w'), { disabled: draft.mode === 'w' }),
      button(ButtonStyle.SECONDARY, 'Draw', encodeId('rep', 'mode', gameId, 'd'), { disabled: draft.mode === 'd' }),
    ),
    row(
      button(ButtonStyle.SUCCESS, 'Confirm', encodeId('rep', 'confirm', gameId, draft.mode, orderArg), { emoji: '✅', disabled: !done }),
      button(ButtonStyle.SECONDARY, 'Undo last', encodeId('rep', 'back', gameId, draft.mode, orderArg), { disabled: draft.order.length === 0 }),
      button(ButtonStyle.SECONDARY, 'Dismiss', encodeId('rep', 'dismiss', gameId)),
    ),
  );
  return { components: [container(COLORS.brand, ...children)] };
}

function draftFrom(args: string[]): ReportDraft | null {
  const mode = args[1];
  if (!isMode(mode)) return null;
  return { mode, order: decodeOrder(args[2]) };
}

async function step(i: Parameters<ComponentHandler>[0], env: Parameters<ComponentHandler>[1], args: string[], next: (d: ReportDraft, size: number) => ReportDraft | null): Promise<ComponentReply> {
  const found = await activeGameFor(i, env, args);
  if (!found.ok) return found.reply;
  const denied = podOrAdmin(i, found.roster);
  if (denied) return denied;
  const current = draftFrom(args);
  if (!current) return ephemeral(errorV2('That button is from an older card.'));
  const draft = next(sanitize(current, found.roster.length), found.roster.length);
  if (!draft) return ephemeral(errorV2('That pick is out of date — use the menu again.'));
  return { kind: 'update', data: renderReportStep(found.game.id, sanitize(draft, found.roster.length), found.roster) };
}

export const reportFlow: Record<string, ComponentHandler> = {
  'rep:open': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    return ephemeral(renderReportStep(found.game.id, { mode: 'f', order: [] }, found.roster));
  },

  'rep:pick': (i, env, id) =>
    step(i, env, id.args, (d, size) => {
      const idx = Number.parseInt(selectValues(i)[0] ?? '', 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= size || d.order.includes(idx)) return null;
      return { mode: d.mode, order: [...d.order, idx] };
    }),

  'rep:mode': (i, env, id) =>
    step(i, env, [id.args[0], id.args[1], '-'], (d) => ({ mode: d.mode, order: [] })),

  'rep:back': (i, env, id) => step(i, env, id.args, (d) => ({ mode: d.mode, order: d.order.slice(0, -1) })),

  'rep:dismiss': async () => ({ kind: 'update', data: noteV2('Dismissed — nothing was reported.') }),

  'rep:confirm': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    const draft = draftFrom(id.args);
    if (!draft) return ephemeral(errorV2('That button is from an older card.'));
    const clean = sanitize(draft, found.roster.length);
    if (!draftStatus(clean, found.roster.length).done) {
      return { kind: 'update', data: renderReportStep(found.game.id, clean, found.roster) };
    }
    const { game, roster } = found;
    return {
      kind: 'deferUpdate',
      work: async () => {
        const outcome = await reportGame(env, {
          guildId: game.guild_id,
          channelId: game.channel_id,
          reporterId: invoker(i).id,
          reporterPermissions: i.member?.permissions,
          placements: toPlacements(clean, roster),
          draw: clean.mode === 'd',
          winnerOnly: clean.mode === 'w',
        });
        if (!outcome.ok) return errorV2(outcome.error);

        const card = await updateLiveCard(env, outcome.game);
        // The pod must see the result: shoutouts always, and the whole card when
        // the live one could not be edited. Follow-ups need no channel permission.
        const result = renderMatchCard(matchState(outcome.game, outcome.roster));
        if (!card.ok) await followUp(i.application_id, i.token, withShoutouts(result, outcome.shoutouts));
        else if (outcome.shoutouts.length) await followUp(i.application_id, i.token, withShoutouts({ components: [] }, outcome.shoutouts));
        return noteV2(`✅ Reported. ${card.ok ? 'The card above shows the result.' : ''}${card.hint}`, COLORS.success);
      },
    };
  },
};
