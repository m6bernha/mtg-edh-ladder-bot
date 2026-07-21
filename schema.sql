-- mtg-edh-ladder-bot D1 schema
-- Ratings on players are the *current* values; everything else (W/L, win%,
-- placements, streaks) is derived from game history so nothing can drift.

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  elo REAL NOT NULL DEFAULT 1000,
  ts_mu REAL NOT NULL DEFAULT 25,
  ts_sigma REAL NOT NULL DEFAULT 8.333333333333334,
  created_at INTEGER NOT NULL,
  UNIQUE (guild_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled', 'undone')),
  bracket TEXT NOT NULL DEFAULT 'open',
  winner_only INTEGER NOT NULL DEFAULT 0,
  draw INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_by TEXT NOT NULL,
  reported_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_games_channel_status
  ON games (guild_id, channel_id, status);
CREATE INDEX IF NOT EXISTS idx_games_guild_ended
  ON games (guild_id, status, ended_at DESC);

-- One row per player per game. The *_before/_after columns are rating
-- snapshots taken at report time; /undo restores the _before values.
CREATE TABLE IF NOT EXISTS game_players (
  game_id INTEGER NOT NULL REFERENCES games (id),
  player_id INTEGER NOT NULL REFERENCES players (id),
  placement INTEGER,
  commander TEXT,
  elo_before REAL,
  elo_after REAL,
  mu_before REAL,
  mu_after REAL,
  sigma_before REAL,
  sigma_after REAL,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_gp_player ON game_players (player_id);
