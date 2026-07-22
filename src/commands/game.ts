import { computeTrueSkill } from '../ratings/trueskill';
import {
  cancelGame,
  completeGame,
  createGame,
  getActiveGame,
  getActiveOrLatestGame,
  getRoster,
  setBracket,
  upsertPlayers,
  type CompletionEntry,
} from '../db/queries';
import { bracketLabel, errorMessage, successMessage } from '../discord/embeds';
import { matchState, renderMatchCard } from '../discord/card';
import { updateLiveCard } from '../discord/live-card';
import {
  collectUsers,
  displayName,
  getSub,
  invoker,
  optBoolean,
  optString,
  requireGuildChannel,
  resolvedUser,
} from '../discord/options';
import {
  isPlayerOrAdmin,
  validateReport,
  validateStart,
  type PlacementInput,
} from '../validation';
import type { Env, GameRow, Interaction, MessageData, RosterEntry } from '../types';

const PLAYER_SLOTS = ['player1', 'player2', 'player3', 'player4', 'player5', 'player6'];
const PLACE_SLOTS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];

export async function handleGameStart(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId, channelId } = ctx;
  const sub = getSub(i);
  if (!sub) return errorMessage('Missing subcommand.');

  const ids = collectUsers(sub.options, PLAYER_SLOTS);
  const v = validateStart(ids);
  if (!v.ok) return errorMessage(v.error);
  for (const id of ids) {
    if (resolvedUser(i, id)?.bot) return errorMessage(`<@${id}> is a bot — pods are for humans.`);
  }

  const active = await getActiveGame(env.DB, guildId, channelId);
  if (active) {
    return errorMessage(
      `There's already an active game in this channel (started <t:${active.started_at}:R>). ` +
        'Finish it with `/game report` or `/game cancel` first.',
    );
  }

  const bracket = optString(sub.options, 'bracket') ?? 'open';
  const users = ids.map((id) => {
    const u = resolvedUser(i, id);
    return { id, username: u ? displayName(u) : id };
  });
  const players = await upsertPlayers(env.DB, guildId, users);
  const { gameId, startedAt } = await createGame(
    env.DB,
    guildId,
    channelId,
    bracket,
    invoker(i).id,
    ids.map((id) => players.get(id)!.id),
  );

  // Build the opening card from what we already have — no extra round trip. The
  // active phase renders content pings + allowed_mentions, so the initial post
  // notifies the pod. The router's after-hook captures this message's id.
  const game: GameRow = {
    id: gameId,
    guild_id: guildId,
    channel_id: channelId,
    status: 'active',
    bracket,
    winner_only: 0,
    draw: 0,
    started_at: startedAt,
    ended_at: null,
    created_by: invoker(i).id,
    reported_by: null,
    message_id: null,
  };
  const roster: RosterEntry[] = ids.map((id) => {
    const p = players.get(id)!;
    return {
      game_id: gameId,
      player_id: p.id,
      placement: null,
      commander: null,
      commander_image: null,
      mu_before: null,
      mu_after: null,
      sigma_before: null,
      sigma_after: null,
      discord_user_id: id,
      username: p.username,
      ts_mu: p.ts_mu,
      ts_sigma: p.ts_sigma,
    };
  });
  return renderMatchCard(matchState(game, roster));
}

export async function handleGameReport(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId, channelId } = ctx;
  const sub = getSub(i);
  if (!sub) return errorMessage('Missing subcommand.');

  const active = await getActiveGame(env.DB, guildId, channelId);
  if (!active) {
    return errorMessage('No active game in this channel. Start one with `/game start`.');
  }
  const roster = await getRoster(env.DB, active.id);
  const rosterIds = roster.map((r) => r.discord_user_id);
  const me = invoker(i);
  if (!isPlayerOrAdmin(roster, me.id, i.member?.permissions)) {
    return errorMessage('Only players in this game (or admins) can report it.');
  }

  const placements: PlacementInput[] = [];
  PLACE_SLOTS.forEach((name, idx) => {
    const v = optString(sub.options, name);
    if (v) placements.push({ userId: v, place: idx + 1 });
  });
  const draw = optBoolean(sub.options, 'draw') ?? false;
  const winnerOnly = optBoolean(sub.options, 'winner_only') ?? false;
  const val = validateReport(rosterIds, placements, { draw, winnerOnly });
  if (!val.ok) return errorMessage(val.error);

  const byId = new Map(roster.map((r) => [r.discord_user_id, r]));
  const ordered = [...placements].sort((a, b) => a.place - b.place).map((p) => byId.get(p.userId)!);
  const places = ordered.map((_, idx) => idx + 1);
  const newTs = computeTrueSkill(
    ordered.map((r) => ({ mu: r.ts_mu, sigma: r.ts_sigma })),
    places,
    { draw, winnerOnly },
  );

  const entries: CompletionEntry[] = ordered.map((r, idx) => ({
    playerId: r.player_id,
    placement: draw ? 1 : idx + 1, // a draw is everyone tied for 1st
    muBefore: r.ts_mu,
    muAfter: newTs[idx].mu,
    sigmaBefore: r.ts_sigma,
    sigmaAfter: newTs[idx].sigma,
  }));
  const endedAt = await completeGame(env.DB, active.id, { winnerOnly, draw }, me.id, entries);

  // The completed roster (placements + rating snapshots) now lives in D1, so the
  // card renders itself from a fresh read. Update it in place and confirm quietly.
  const game: GameRow = {
    ...active,
    status: 'completed',
    ended_at: endedAt,
    winner_only: winnerOnly ? 1 : 0,
    draw: draw ? 1 : 0,
  };
  const shown = await updateLiveCard(env, game);
  return shown
    ? successMessage('🏆 Result recorded — the pod card is updated.')
    : renderMatchCard(matchState(game, await getRoster(env.DB, game.id)));
}

export async function handleGameBracket(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId, channelId } = ctx;
  const sub = getSub(i);
  const bracket = sub ? optString(sub.options, 'bracket') : undefined;
  if (!bracket) return errorMessage('Pick a bracket.');

  const found = await getActiveOrLatestGame(env.DB, guildId, channelId);
  if (!found) return errorMessage('No game found in this channel — start one with `/game start`.');
  const { game, note } = found;

  const roster = await getRoster(env.DB, game.id);
  const me = invoker(i);
  if (!isPlayerOrAdmin(roster, me.id, i.member?.permissions)) {
    return errorMessage('Only players in that game (or admins) can set its bracket.');
  }

  const old = game.bracket;
  await setBracket(env.DB, game.id, bracket);
  await updateLiveCard(env, { ...game, bracket });
  const change =
    old === bracket ? `stays **${bracketLabel(bracket)}**` : `**${bracketLabel(old)}** → **${bracketLabel(bracket)}**`;
  return successMessage(`🎚️ Bracket ${change} ${note}.`);
}

export async function handleGameCancel(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId, channelId } = ctx;

  const active = await getActiveGame(env.DB, guildId, channelId);
  if (!active) return errorMessage('No active game in this channel.');
  const roster = await getRoster(env.DB, active.id);
  const me = invoker(i);
  if (!isPlayerOrAdmin(roster, me.id, i.member?.permissions)) {
    return errorMessage('Only players in this game (or admins) can cancel it.');
  }
  const cancelled = await cancelGame(env.DB, active.id);
  if (!cancelled) {
    return errorMessage('That game was already reported or cancelled — nothing to do.');
  }
  await updateLiveCard(env, { ...active, status: 'cancelled', ended_at: Math.floor(Date.now() / 1000) });
  return successMessage(
    `🗑️ Game cancelled (was running <t:${active.started_at}:R>). Nothing counts — start fresh with \`/game start\`.`,
  );
}
