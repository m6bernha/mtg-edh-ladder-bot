/**
 * Cron entry point: build and post the weekly digest for every guild that
 * configured a channel. Errors are per guild — one deleted channel must not
 * stop the others — and a 403/404 clears that guild's setting so we stop
 * knocking on a door that is gone.
 */

import { getAllDigestTargets, getGuildBoard, getSeatsInWindow, setDigestChannel } from '../db/queries';
import { createMessage } from '../discord/api';
import { digestMessage } from '../discord/embeds';
import { skillRating } from '../ratings/trueskill.ts';
import type { Env } from '../types';
import { buildDigest } from './digest.ts';

const WEEK_SECONDS = 7 * 86_400;
const MISSING_ACCESS = 50001;
const UNKNOWN_CHANNEL = 10003;

export async function postWeeklyDigests(env: Env, nowTs: number): Promise<void> {
  const targets = await getAllDigestTargets(env.DB);
  for (const t of targets) {
    if (!t.digest_channel_id) continue;
    try {
      const since = nowTs - WEEK_SECONDS;
      const [seats, board] = await Promise.all([
        getSeatsInWindow(env.DB, t.guild_id, since, nowTs),
        getGuildBoard(env.DB, t.guild_id),
      ]);
      const ranked = board
        .map((b) => ({ username: b.username, sr: skillRating(b.mu, b.sigma) }))
        .sort((a, b) => b.sr - a.sr);
      const view = buildDigest(seats, ranked);
      if (!view) continue; // quiet week — say nothing

      const res = await createMessage(env.DISCORD_BOT_TOKEN, t.digest_channel_id, digestMessage(view, since));
      if (!res.ok) {
        console.error(`digest for guild ${t.guild_id} failed: ${res.status} ${res.code ?? ''} ${res.message ?? ''}`);
        if (res.status === 404 || (res.status === 403 && res.code === MISSING_ACCESS) || res.code === UNKNOWN_CHANNEL) {
          await setDigestChannel(env.DB, t.guild_id, null, 'cron');
        }
      }
    } catch (e) {
      console.error(`digest for guild ${t.guild_id} threw:`, e);
    }
  }
}
