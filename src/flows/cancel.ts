import { cancelGame } from '../db/queries';
import { ButtonStyle, button, container, row, text } from '../discord/components.ts';
import { encodeId } from '../discord/custom-id.ts';
import { COLORS } from '../discord/embeds';
import { updateLiveCard } from '../discord/live-card';
import { activeGameFor, ephemeral, noteV2, podOrAdmin } from './shared.ts';
import type { ComponentHandler } from './types.ts';

/**
 * 🗑️ Cancel game → an ephemeral "are you sure" → cancel. Both steps re-check
 * that the game is still the channel's active one and that the clicker may act.
 */
export const cancelFlow: Record<string, ComponentHandler> = {
  'cxl:ask': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    return ephemeral({
      components: [
        container(
          COLORS.error,
          text('## 🗑️ Cancel this game?\nNothing will be recorded — no placements, no rating changes.'),
          row(
            button(ButtonStyle.DANGER, 'Yes, cancel it', encodeId('cxl', 'yes', found.game.id)),
            button(ButtonStyle.SECONDARY, 'Keep playing', encodeId('cxl', 'no', found.game.id)),
          ),
        ),
      ],
    });
  },

  'cxl:yes': async (i, env, id) => {
    const found = await activeGameFor(i, env, id.args);
    if (!found.ok) return found.reply;
    const denied = podOrAdmin(i, found.roster);
    if (denied) return denied;
    const { game } = found;
    return {
      kind: 'deferUpdate',
      work: async () => {
        const cancelled = await cancelGame(env.DB, game.id);
        if (!cancelled) return noteV2('That game was already reported or cancelled — nothing to do.', COLORS.error);
        const card = await updateLiveCard(env, { ...game, status: 'cancelled', ended_at: Math.floor(Date.now() / 1000) });
        return noteV2(`🗑️ Game cancelled. Nothing counts — start fresh with \`/game start\`.${card.hint}`);
      },
    };
  },

  'cxl:no': async () => ({ kind: 'update', data: noteV2('👍 Kept running — play on.') }),
};
