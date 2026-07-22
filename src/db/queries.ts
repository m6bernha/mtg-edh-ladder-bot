import type { GameRow, PlayerRow, RosterEntry } from '../types';
import type { PlayerRatingUpdate } from './snapshots';

const now = () => Math.floor(Date.now() / 1000);

/**
 * D1 reports failures on the result object rather than by throwing, so an
 * unchecked write fails silently and the bot cheerfully reports success.
 */
function assertWrote(result: D1Result, what: string): void {
  if (!result.success) throw new Error(`${what} failed`);
}

/**
 * Get the active game in this channel, or the most recent completed one.
 * `/game bracket` and `/commander` both accept a game that has just been
 * reported, so players can correct it without restarting the pod. The note is
 * the human phrasing for whichever game we landed on.
 */
export async function getActiveOrLatestGame(
  db: D1Database,
  guildId: string,
  channelId: string,
): Promise<{ game: GameRow; note: string } | null> {
  const active = await getActiveGame(db, guildId, channelId);
  if (active) return { game: active, note: 'for the game in progress' };

  const latest = await getLatestCompletedGameInChannel(db, guildId, channelId);
  if (latest) return { game: latest, note: `for the game that ended <t:${latest.ended_at}:R>` };

  return null;
}

export async function upsertPlayers(
  db: D1Database,
  guildId: string,
  users: { id: string; username: string }[],
): Promise<Map<string, PlayerRow>> {
  const ts = now();
  await db.batch(
    users.map((u) =>
      db
        .prepare(
          `INSERT INTO players (guild_id, discord_user_id, username, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET username = excluded.username`,
        )
        .bind(guildId, u.id, u.username, ts),
    ),
  );
  const placeholders = users.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT id, guild_id, discord_user_id, username, ts_mu, ts_sigma
       FROM players WHERE guild_id = ? AND discord_user_id IN (${placeholders})`,
    )
    .bind(guildId, ...users.map((u) => u.id))
    .all<PlayerRow>();
  return new Map(results.map((r) => [r.discord_user_id, r]));
}

export async function getPlayerByDiscordId(
  db: D1Database,
  guildId: string,
  discordUserId: string,
): Promise<PlayerRow | null> {
  return db
    .prepare('SELECT * FROM players WHERE guild_id = ? AND discord_user_id = ?')
    .bind(guildId, discordUserId)
    .first<PlayerRow>();
}

export async function getActiveGame(
  db: D1Database,
  guildId: string,
  channelId: string,
): Promise<GameRow | null> {
  return db
    .prepare(`SELECT * FROM games WHERE guild_id = ? AND channel_id = ? AND status = 'active' LIMIT 1`)
    .bind(guildId, channelId)
    .first<GameRow>();
}

export async function getLatestCompletedGameInChannel(
  db: D1Database,
  guildId: string,
  channelId: string,
): Promise<GameRow | null> {
  return db
    .prepare(
      `SELECT * FROM games WHERE guild_id = ? AND channel_id = ? AND status = 'completed'
       ORDER BY ended_at DESC, id DESC LIMIT 1`,
    )
    .bind(guildId, channelId)
    .first<GameRow>();
}

export async function getLatestCompletedGame(
  db: D1Database,
  guildId: string,
): Promise<GameRow | null> {
  return db
    .prepare(
      `SELECT * FROM games WHERE guild_id = ? AND status = 'completed'
       ORDER BY ended_at DESC, id DESC LIMIT 1`,
    )
    .bind(guildId)
    .first<GameRow>();
}

export async function getRoster(db: D1Database, gameId: number): Promise<RosterEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT gp.*, p.discord_user_id, p.username, p.ts_mu, p.ts_sigma
       FROM game_players gp JOIN players p ON p.id = gp.player_id
       WHERE gp.game_id = ?`,
    )
    .bind(gameId)
    .all<RosterEntry>();
  return results;
}

export async function createGame(
  db: D1Database,
  guildId: string,
  channelId: string,
  bracket: string,
  createdBy: string,
  playerIds: number[],
): Promise<{ gameId: number; startedAt: number }> {
  const startedAt = now();
  const res = await db
    .prepare(
      `INSERT INTO games (guild_id, channel_id, bracket, started_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(guildId, channelId, bracket, startedAt, createdBy)
    .run();
  assertWrote(res, 'creating the game');
  const gameId = res.meta.last_row_id as number;
  await db.batch(
    playerIds.map((pid) =>
      db.prepare('INSERT INTO game_players (game_id, player_id) VALUES (?, ?)').bind(gameId, pid),
    ),
  );
  return { gameId, startedAt };
}

export interface CompletionEntry {
  playerId: number;
  placement: number;
  muBefore: number;
  muAfter: number;
  sigmaBefore: number;
  sigmaAfter: number;
}

/** Atomically complete a game: game row + snapshots + player ratings. */
export async function completeGame(
  db: D1Database,
  gameId: number,
  flags: { winnerOnly: boolean; draw: boolean },
  reportedBy: string,
  entries: CompletionEntry[],
): Promise<number> {
  const endedAt = now();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE games SET status = 'completed', ended_at = ?, winner_only = ?, draw = ?, reported_by = ?
         WHERE id = ? AND status = 'active'`,
      )
      .bind(endedAt, flags.winnerOnly ? 1 : 0, flags.draw ? 1 : 0, reportedBy, gameId),
  ];
  for (const e of entries) {
    stmts.push(
      db
        .prepare(
          `UPDATE game_players SET placement = ?,
             mu_before = ?, mu_after = ?, sigma_before = ?, sigma_after = ?
           WHERE game_id = ? AND player_id = ?`,
        )
        .bind(
          e.placement,
          e.muBefore,
          e.muAfter,
          e.sigmaBefore,
          e.sigmaAfter,
          gameId,
          e.playerId,
        ),
      db
        .prepare('UPDATE players SET ts_mu = ?, ts_sigma = ? WHERE id = ?')
        .bind(e.muAfter, e.sigmaAfter, e.playerId),
    );
  }
  await db.batch(stmts);
  return endedAt;
}

/**
 * Returns false if the game was no longer active — i.e. somebody reported or
 * cancelled it between our read and this write. The `status = 'active'` guard
 * makes that a no-op rather than a corruption, but the caller still needs to
 * know so it does not claim success.
 */
export async function cancelGame(db: D1Database, gameId: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE games SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'active'`)
    .bind(now(), gameId)
    .run();
  assertWrote(res, 'cancelling the game');
  return res.meta.changes > 0;
}

/** Atomically mark a game undone and restore every player's pre-game ratings. */
export async function undoGame(
  db: D1Database,
  gameId: number,
  restores: PlayerRatingUpdate[],
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE games SET status = 'undone' WHERE id = ? AND status = 'completed'`).bind(gameId),
  ];
  for (const r of restores) {
    stmts.push(
      db
        .prepare('UPDATE players SET ts_mu = ?, ts_sigma = ? WHERE id = ?')
        .bind(r.mu, r.sigma, r.playerId),
    );
  }
  await db.batch(stmts);
}

export async function setBracket(db: D1Database, gameId: number, bracket: string): Promise<void> {
  const res = await db
    .prepare('UPDATE games SET bracket = ? WHERE id = ?')
    .bind(bracket, gameId)
    .run();
  assertWrote(res, 'setting the bracket');
}

/** Stamp the live card's message id, learned after /game start posts it. */
export async function setGameMessageId(
  db: D1Database,
  gameId: number,
  messageId: string,
): Promise<void> {
  const res = await db
    .prepare('UPDATE games SET message_id = ? WHERE id = ?')
    .bind(messageId, gameId)
    .run();
  assertWrote(res, 'storing the card message id');
}

export async function setCommander(
  db: D1Database,
  gameId: number,
  playerId: number,
  commander: string,
  image: string | null,
): Promise<void> {
  const res = await db
    .prepare(
      'UPDATE game_players SET commander = ?, commander_image = ? WHERE game_id = ? AND player_id = ?',
    )
    .bind(commander, image, gameId, playerId)
    .run();
  assertWrote(res, 'setting the commander');
}

export interface LeaderboardRow extends PlayerRow {
  games: number;
  wins: number;
  draws: number;
}

export async function getLeaderboard(db: D1Database, guildId: string): Promise<LeaderboardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*,
         COUNT(gp.game_id) AS games,
         SUM(CASE WHEN gp.placement = 1 AND g.draw = 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN g.draw = 1 THEN 1 ELSE 0 END) AS draws
       FROM players p
       JOIN game_players gp ON gp.player_id = p.id
       JOIN games g ON g.id = gp.game_id AND g.status = 'completed'
       WHERE p.guild_id = ?
       GROUP BY p.id
       ORDER BY (p.ts_mu - 3 * p.ts_sigma) DESC
       LIMIT 20`,
    )
    .bind(guildId)
    .all<LeaderboardRow>();
  return results;
}

export interface PlayerGameRow {
  game_id: number;
  started_at: number;
  ended_at: number;
  draw: number;
  winner_only: number;
  bracket: string;
  placement: number;
  commander: string | null;
  mu_before: number;
  mu_after: number;
  sigma_before: number;
  sigma_after: number;
}

/** Every completed game for one player, newest first — feeds all of /stats. */
export async function getPlayerGames(db: D1Database, playerId: number): Promise<PlayerGameRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id AS game_id, g.started_at, g.ended_at, g.draw, g.winner_only, g.bracket,
              gp.placement, gp.commander,
              gp.mu_before, gp.mu_after, gp.sigma_before, gp.sigma_after
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE gp.player_id = ? AND g.status = 'completed'
       ORDER BY g.ended_at DESC, g.id DESC`,
    )
    .bind(playerId)
    .all<PlayerGameRow>();
  return results;
}

export interface VsRow {
  game_id: number;
  started_at: number;
  ended_at: number;
  draw: number;
  pa: number;
  pb: number;
}

export async function getSharedGames(
  db: D1Database,
  guildId: string,
  playerAId: number,
  playerBId: number,
): Promise<VsRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id AS game_id, g.started_at, g.ended_at, g.draw,
              a.placement AS pa, b.placement AS pb
       FROM games g
       JOIN game_players a ON a.game_id = g.id AND a.player_id = ?
       JOIN game_players b ON b.game_id = g.id AND b.player_id = ?
       WHERE g.guild_id = ? AND g.status = 'completed'
       ORDER BY g.ended_at DESC, g.id DESC`,
    )
    .bind(playerAId, playerBId, guildId)
    .all<VsRow>();
  return results;
}
