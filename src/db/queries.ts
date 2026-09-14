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
       WHERE gp.game_id = ?
       ORDER BY gp.player_id`,
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
  /** The stored sigma before the report — what /undo restores. */
  sigmaBefore: number;
  sigmaAfter: number;
  /** Rust-inflated sigma fed to the engine, or null when none applied. */
  sigmaRusted: number | null;
  rustDays: number | null;
}

/**
 * Atomically complete a game: game row + snapshots + player ratings.
 * `endedAt` may be supplied (the recompute replay passes the historical value);
 * live reports use the current time.
 */
export async function completeGame(
  db: D1Database,
  gameId: number,
  flags: { winnerOnly: boolean; draw: boolean; topPlayerId?: number | null },
  reportedBy: string,
  entries: CompletionEntry[],
  endedAt: number = now(),
): Promise<number> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE games SET status = 'completed', ended_at = ?, winner_only = ?, draw = ?, reported_by = ?,
           top_player_id = ?
         WHERE id = ? AND status = 'active'`,
      )
      .bind(endedAt, flags.winnerOnly ? 1 : 0, flags.draw ? 1 : 0, reportedBy, flags.topPlayerId ?? null, gameId),
  ];
  for (const e of entries) {
    stmts.push(
      db
        .prepare(
          `UPDATE game_players SET placement = ?,
             mu_before = ?, mu_after = ?, sigma_before = ?, sigma_after = ?,
             sigma_rusted = ?, rust_days = ?
           WHERE game_id = ? AND player_id = ?`,
        )
        .bind(
          e.placement,
          e.muBefore,
          e.muAfter,
          e.sigmaBefore,
          e.sigmaAfter,
          e.sigmaRusted,
          e.rustDays,
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
  last_played_at: number;
}

export async function getLeaderboard(
  db: D1Database,
  guildId: string,
  limit = 20,
  offset = 0,
): Promise<LeaderboardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*,
         COUNT(gp.game_id) AS games,
         SUM(CASE WHEN gp.placement = 1 AND g.draw = 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN g.draw = 1 THEN 1 ELSE 0 END) AS draws,
         MAX(g.ended_at) AS last_played_at
       FROM players p
       JOIN game_players gp ON gp.player_id = p.id
       JOIN games g ON g.id = gp.game_id AND g.status = 'completed'
       WHERE p.guild_id = ?
       GROUP BY p.id
       ORDER BY (p.ts_mu - 3 * p.ts_sigma) DESC, p.username
       LIMIT ? OFFSET ?`,
    )
    .bind(guildId, limit, offset)
    .all<LeaderboardRow>();
  return results;
}

export async function getLeaderboardCount(db: D1Database, guildId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT p.id) AS n FROM players p
       JOIN game_players gp ON gp.player_id = p.id
       JOIN games g ON g.id = gp.game_id AND g.status = 'completed'
       WHERE p.guild_id = ?`,
    )
    .bind(guildId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface RecentResultRow {
  player_id: number;
  rn: number; // 1 = newest
  placement: number | null;
  draw: number;
  mu_before: number | null;
  sigma_before: number | null;
}

/**
 * Each rated player's last `n` results (newest first), plus the rating they
 * held before their newest game — enough for the form string and the
 * rank-movement arrow on the leaderboard in one query.
 */
export async function getRecentResults(db: D1Database, guildId: string, n: number): Promise<RecentResultRow[]> {
  const { results } = await db
    .prepare(
      `SELECT player_id, rn, placement, draw, mu_before, sigma_before FROM (
         SELECT gp.player_id, gp.placement, g.draw, gp.mu_before, gp.sigma_before,
                ROW_NUMBER() OVER (PARTITION BY gp.player_id ORDER BY g.ended_at DESC, g.id DESC) AS rn
         FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE g.guild_id = ? AND g.status = 'completed')
       WHERE rn <= ?`,
    )
    .bind(guildId, n)
    .all<RecentResultRow>();
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
  /** Ladder leader before this game (Kingslayer); null pre-migration. */
  top_player_id: number | null;
}

/** Every completed game for one player, newest first — feeds all of /stats. */
export async function getPlayerGames(db: D1Database, playerId: number): Promise<PlayerGameRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id AS game_id, g.started_at, g.ended_at, g.draw, g.winner_only, g.bracket, g.top_player_id,
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

export interface PlayerGameRowWithId extends PlayerGameRow {
  player_id: number;
}

/** getPlayerGames for several players at once (newest first), one query — feeds report shoutouts. */
export async function getGamesForPlayers(db: D1Database, playerIds: number[]): Promise<PlayerGameRowWithId[]> {
  if (playerIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT gp.player_id, g.id AS game_id, g.started_at, g.ended_at, g.draw, g.winner_only, g.bracket, g.top_player_id,
              gp.placement, gp.commander,
              gp.mu_before, gp.mu_after, gp.sigma_before, gp.sigma_after
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE gp.player_id IN (${playerIds.map(() => '?').join(',')}) AND g.status = 'completed'
       ORDER BY g.ended_at DESC, g.id DESC`,
    )
    .bind(...playerIds)
    .all<PlayerGameRowWithId>();
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

// ---- Rating dynamics ----

/** When each player last finished a completed game (seconds), for rust. Absent = never. */
export async function getLastPlayedAt(db: D1Database, playerIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (playerIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT gp.player_id, MAX(g.ended_at) AS last_at
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE g.status = 'completed' AND gp.player_id IN (${playerIds.map(() => '?').join(',')})
       GROUP BY gp.player_id`,
    )
    .bind(...playerIds)
    .all<{ player_id: number; last_at: number | null }>();
  for (const r of results) if (r.last_at != null) out.set(r.player_id, r.last_at);
  return out;
}

export interface BoardEntry {
  playerId: number;
  username: string;
  mu: number;
  sigma: number;
  games: number;
}

/** Every rated player in the guild (has ≥1 completed game), unsorted — callers rank by SR. */
export async function getGuildBoard(db: D1Database, guildId: string): Promise<BoardEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS playerId, p.username, p.ts_mu AS mu, p.ts_sigma AS sigma, COUNT(gp.game_id) AS games
       FROM players p
       JOIN game_players gp ON gp.player_id = p.id
       JOIN games g ON g.id = gp.game_id AND g.status = 'completed'
       WHERE p.guild_id = ?
       GROUP BY p.id`,
    )
    .bind(guildId)
    .all<BoardEntry>();
  return results;
}

// ---- Meta / history ----

export interface CommanderMetaRow {
  commander: string;
  games: number;
  wins: number;
  draws: number;
  avg_placement: number | null;
  pilots: number;
}

export async function getCommanderMeta(
  db: D1Database,
  guildId: string,
  opts: { minGames: number; limit: number; offset: number },
): Promise<CommanderMetaRow[]> {
  const { results } = await db
    .prepare(
      `SELECT gp.commander,
              COUNT(*) AS games,
              SUM(CASE WHEN gp.placement = 1 AND g.draw = 0 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN g.draw = 1 THEN 1 ELSE 0 END) AS draws,
              AVG(CASE WHEN g.draw = 0 AND (g.winner_only = 0 OR gp.placement = 1) THEN gp.placement END) AS avg_placement,
              COUNT(DISTINCT gp.player_id) AS pilots
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE g.guild_id = ? AND g.status = 'completed' AND gp.commander IS NOT NULL
       GROUP BY gp.commander
       HAVING games >= ?
       ORDER BY games DESC, wins DESC, gp.commander
       LIMIT ? OFFSET ?`,
    )
    .bind(guildId, opts.minGames, opts.limit, opts.offset)
    .all<CommanderMetaRow>();
  return results;
}

export async function getCommanderMetaCount(db: D1Database, guildId: string, minGames: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT gp.commander FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE g.guild_id = ? AND g.status = 'completed' AND gp.commander IS NOT NULL
         GROUP BY gp.commander HAVING COUNT(*) >= ?)`,
    )
    .bind(guildId, minGames)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface HistoryRow {
  game_id: number;
  started_at: number;
  ended_at: number;
  draw: number;
  winner_only: number;
  bracket: string;
  pod_size: number;
  winner_name: string | null;
  winner_commander: string | null;
}

const PLAYER_IN_GAME = 'AND EXISTS (SELECT 1 FROM game_players f WHERE f.game_id = g.id AND f.player_id = ?)';

/** Recent completed games, newest first, optionally only those a player sat in. */
export async function getRecentGames(
  db: D1Database,
  guildId: string,
  opts: { limit: number; offset: number; playerId?: number },
): Promise<HistoryRow[]> {
  const filter = opts.playerId != null ? PLAYER_IN_GAME : '';
  const binds: (string | number)[] = [guildId];
  if (opts.playerId != null) binds.push(opts.playerId);
  binds.push(opts.limit, opts.offset);
  const { results } = await db
    .prepare(
      `SELECT g.id AS game_id, g.started_at, g.ended_at, g.draw, g.winner_only, g.bracket,
              (SELECT COUNT(*) FROM game_players c WHERE c.game_id = g.id) AS pod_size,
              w.username AS winner_name, wp.commander AS winner_commander
       FROM games g
       LEFT JOIN game_players wp ON wp.game_id = g.id AND wp.placement = 1 AND g.draw = 0
       LEFT JOIN players w ON w.id = wp.player_id
       WHERE g.guild_id = ? AND g.status = 'completed' ${filter}
       GROUP BY g.id
       ORDER BY g.ended_at DESC, g.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds)
    .all<HistoryRow>();
  return results;
}

export async function getRecentGamesCount(db: D1Database, guildId: string, playerId?: number): Promise<number> {
  const filter = playerId != null ? PLAYER_IN_GAME : '';
  const binds: (string | number)[] = playerId != null ? [guildId, playerId] : [guildId];
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM games g WHERE g.guild_id = ? AND g.status = 'completed' ${filter}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface PodSnapshotRow {
  game_id: number;
  player_id: number;
  placement: number | null;
  mu_before: number | null;
  sigma_before: number | null;
  sigma_rusted: number | null;
}

/** Every seat's pre-game snapshot for every completed game one player sat in — one query, any history size. */
export async function getPodSnapshotsForPlayer(db: D1Database, playerId: number): Promise<Map<number, PodSnapshotRow[]>> {
  const out = new Map<number, PodSnapshotRow[]>();
  const { results } = await db
    .prepare(
      `SELECT o.game_id, o.player_id, o.placement, o.mu_before, o.sigma_before, o.sigma_rusted
       FROM game_players me
       JOIN game_players o ON o.game_id = me.game_id
       JOIN games g ON g.id = me.game_id AND g.status = 'completed'
       WHERE me.player_id = ?`,
    )
    .bind(playerId)
    .all<PodSnapshotRow>();
  for (const r of results) {
    const list = out.get(r.game_id) ?? [];
    list.push(r);
    out.set(r.game_id, list);
  }
  return out;
}

// ---- Settings / digest ----

export interface SettingsRow {
  guild_id: string;
  digest_channel_id: string | null;
}

export async function getSettings(db: D1Database, guildId: string): Promise<SettingsRow | null> {
  return db
    .prepare('SELECT guild_id, digest_channel_id FROM settings WHERE guild_id = ?')
    .bind(guildId)
    .first<SettingsRow>();
}

export async function getAllDigestTargets(db: D1Database): Promise<SettingsRow[]> {
  const { results } = await db
    .prepare('SELECT guild_id, digest_channel_id FROM settings WHERE digest_channel_id IS NOT NULL')
    .all<SettingsRow>();
  return results;
}

export async function setDigestChannel(
  db: D1Database,
  guildId: string,
  channelId: string | null,
  byUserId: string,
): Promise<void> {
  const res = await db
    .prepare(
      `INSERT INTO settings (guild_id, digest_channel_id, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET digest_channel_id = excluded.digest_channel_id,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(guildId, channelId, now(), byUserId)
    .run();
  assertWrote(res, 'saving settings');
}

export interface DigestSeatRow {
  game_id: number;
  started_at: number;
  ended_at: number;
  draw: number;
  player_id: number;
  username: string;
  placement: number | null;
  commander: string | null;
  mu_before: number | null;
  sigma_before: number | null;
  mu_after: number | null;
  sigma_after: number | null;
}

/** Every seat of every completed game in a time window — the digest derives everything from this. */
export async function getSeatsInWindow(
  db: D1Database,
  guildId: string,
  sinceTs: number,
  untilTs: number,
): Promise<DigestSeatRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id AS game_id, g.started_at, g.ended_at, g.draw, gp.player_id, p.username, gp.placement,
              gp.commander, gp.mu_before, gp.sigma_before, gp.mu_after, gp.sigma_after
       FROM games g
       JOIN game_players gp ON gp.game_id = g.id
       JOIN players p ON p.id = gp.player_id
       WHERE g.guild_id = ? AND g.status = 'completed' AND g.ended_at > ? AND g.ended_at <= ?
       ORDER BY g.ended_at, g.id`,
    )
    .bind(guildId, sinceTs, untilTs)
    .all<DigestSeatRow>();
  return results;
}

// ---- Card flows / profile extras ----

export interface RecentCommanderRow {
  commander: string;
  games: number;
  last_at: number;
}

/** A player's distinct decks, most recently played first — the card's quick-pick. */
export async function getRecentCommanders(db: D1Database, playerId: number, limit: number): Promise<RecentCommanderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT gp.commander, COUNT(*) AS games, MAX(g.ended_at) AS last_at
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE gp.player_id = ? AND g.status = 'completed' AND gp.commander IS NOT NULL
       GROUP BY gp.commander
       ORDER BY last_at DESC
       LIMIT ?`,
    )
    .bind(playerId, limit)
    .all<RecentCommanderRow>();
  return results;
}

export interface RivalRow {
  opponent_id: number;
  username: string;
  shared: number;
  /** Games where the opponent finished above me (non-draw). */
  above_me: number;
  /** Games where I finished above the opponent (non-draw). */
  below_me: number;
}

/** Everyone a player has shared a pod with, and who finished above whom. */
export async function getRivals(db: D1Database, playerId: number): Promise<RivalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT o.player_id AS opponent_id, p.username, COUNT(*) AS shared,
              SUM(CASE WHEN g.draw = 0 AND o.placement < me.placement THEN 1 ELSE 0 END) AS above_me,
              SUM(CASE WHEN g.draw = 0 AND me.placement < o.placement THEN 1 ELSE 0 END) AS below_me
       FROM game_players me
       JOIN game_players o ON o.game_id = me.game_id AND o.player_id <> me.player_id
       JOIN games g ON g.id = me.game_id AND g.status = 'completed'
       JOIN players p ON p.id = o.player_id
       WHERE me.player_id = ?
       GROUP BY o.player_id`,
    )
    .bind(playerId)
    .all<RivalRow>();
  return results;
}
