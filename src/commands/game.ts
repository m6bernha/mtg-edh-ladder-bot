import { computeElo } from '../ratings/elo';
import { computeTrueSkill, skillRating } from '../ratings/trueskill';
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
import {
  bracketLabel,
  errorMessage,
  gameStartMessage,
  reportMessage,
  successMessage,
} from '../discord/embeds';
import {
  collectUsers,
  displayName,
  getSub,
  invoker,
  opt,
  requireGuildChannel,
  resolvedUser,
} from '../discord/options';
import {
  isPlayerOrAdmin,
  validateReport,
  validateStart,
  type PlacementInput,
} from '../validation';
import type { Env, Interaction, MessageData } from '../types';

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

  const bracket = opt<string>(sub.options, 'bracket') ?? 'open';
  const users = ids.map((id) => {
    const u = resolvedUser(i, id);
    return { id, username: u ? displayName(u) : id };
  });
  const players = await upsertPlayers(env.DB, guildId, users);
  const { startedAt } = await createGame(
    env.DB,
    guildId,
    channelId,
    bracket,
    invoker(i).id,
    ids.map((id) => players.get(id)!.id),
  );
  return gameStartMessage(ids, bracket, startedAt);
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
    const v = opt<string>(sub.options, name);
    if (v) placements.push({ userId: v, place: idx + 1 });
  });
  const draw = opt<boolean>(sub.options, 'draw') ?? false;
  const winnerOnly = opt<boolean>(sub.options, 'winner_only') ?? false;
  const val = validateReport(rosterIds, placements, { draw, winnerOnly });
  if (!val.ok) return errorMessage(val.error);

  const byId = new Map(roster.map((r) => [r.discord_user_id, r]));
  const ordered = [...placements].sort((a, b) => a.place - b.place).map((p) => byId.get(p.userId)!);
  const places = ordered.map((_, idx) => idx + 1);
  const newElos = computeElo(
    ordered.map((r) => r.elo),
    places,
    { draw, winnerOnly },
  );
  const newTs = computeTrueSkill(
    ordered.map((r) => ({ mu: r.ts_mu, sigma: r.ts_sigma })),
    places,
    { draw, winnerOnly },
  );

  const entries: CompletionEntry[] = ordered.map((r, idx) => ({
    playerId: r.player_id,
    placement: draw ? 1 : idx + 1, // a draw is everyone tied for 1st
    eloBefore: r.elo,
    eloAfter: newElos[idx],
    muBefore: r.ts_mu,
    muAfter: newTs[idx].mu,
    sigmaBefore: r.ts_sigma,
    sigmaAfter: newTs[idx].sigma,
  }));
  const endedAt = await completeGame(env.DB, active.id, { winnerOnly, draw }, me.id, entries);

  return reportMessage(
    ordered.map((r, idx) => ({
      userId: r.discord_user_id,
      username: r.username,
      placement: idx + 1,
      eloBefore: r.elo,
      eloAfter: newElos[idx],
      srBefore: skillRating(r.ts_mu, r.ts_sigma),
      srAfter: skillRating(newTs[idx].mu, newTs[idx].sigma),
      commander: r.commander,
    })),
    { duration: endedAt - active.started_at, bracket: active.bracket, draw, winnerOnly },
  );
}

export async function handleGameBracket(i: Interaction, env: Env): Promise<MessageData> {
  const ctx = requireGuildChannel(i);
  if (!ctx.ok) return errorMessage(ctx.error);
  const { guildId, channelId } = ctx;
  const sub = getSub(i);
  const bracket = sub ? opt<string>(sub.options, 'bracket') : undefined;
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
  return successMessage(
    `🗑️ Game cancelled (was running <t:${active.started_at}:R>). Nothing counts — start fresh with \`/game start\`.`,
  );
}
