import { getActiveGame, getLastPlayedAt, getRoster } from '../db/queries';
import { errorMessage, predictMessage } from '../discord/embeds';
import { requireGuildChannel } from '../discord/options';
import { matchQuality, predictWinProbabilities } from '../ratings/predict.ts';
import { applyRust } from '../ratings/rust.ts';
import { skillRating } from '../ratings/trueskill.ts';
import type { Env, Interaction, MessageData } from '../types';

export interface PredictEntry {
  username: string;
  commander: string | null;
  sr: number;
  winPct: number;
  rusted: boolean;
}

export interface PredictView {
  entries: PredictEntry[]; // sorted by winPct desc
  quality: number;
  startedAt: number;
}

export async function handlePredict(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const active = await getActiveGame(env.DB, ctx.guildId, ctx.channelId);
  if (!active) return errorMessage('No active game in this channel — `/predict` reads the pod in progress.');
  const roster = await getRoster(env.DB, active.id);
  const lastPlayed = await getLastPlayedAt(env.DB, roster.map((r) => r.player_id));
  const now = Math.floor(Date.now() / 1000);

  // Same inputs the report will use: rust-adjusted uncertainty, seeded by game id.
  const rust = roster.map((r) => applyRust(r.ts_sigma, lastPlayed.get(r.player_id) ?? null, now));
  const ratings = roster.map((r, idx) => ({ mu: r.ts_mu, sigma: rust[idx].sigma }));
  const odds = predictWinProbabilities(ratings, active.id);

  const entries: PredictEntry[] = roster
    .map((r, idx) => ({
      username: r.username,
      commander: r.commander,
      sr: skillRating(r.ts_mu, r.ts_sigma),
      winPct: odds[idx],
      rusted: rust[idx].rusted,
    }))
    .sort((a, b) => b.winPct - a.winPct);
  return predictMessage({ entries, quality: matchQuality(ratings), startedAt: active.started_at });
}
