-- mtg-edh-ladder-bot D1 schema
-- Ratings on players are the *current* values; everything else (W/L, win%,
-- placements, streaks) is derived from game history so nothing can drift.
--
-- This is the post-migration shape — a fresh install applies this file and skips
-- migrations/ entirely. Existing deployments apply migrations/ in order instead.

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
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
  reported_by TEXT,
  -- The Discord message id of this game's live card, so later commands edit it
  -- (via bot token) rather than posting a new message. Null until the card posts.
  message_id TEXT
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
  -- Scryfall art URL, cached at /commander time so the card re-renders cheaply.
  commander_image TEXT,
  mu_before REAL,
  mu_after REAL,
  sigma_before REAL,
  sigma_after REAL,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_gp_player ON game_players (player_id);

-- Local commander index (see migrations/0003_commander_index.sql for rationale).
CREATE TABLE IF NOT EXISTS commanders (
  oracle_id      TEXT PRIMARY KEY,
  scryfall_id    TEXT NOT NULL,
  name           TEXT NOT NULL,            -- exact Scryfall name, incl. "Front // Back"
  norm_name      TEXT NOT NULL,            -- normalizeName(name)
  short_name     TEXT NOT NULL,            -- text before the first comma ("Atraxa")
  norm_short     TEXT NOT NULL,
  front_name     TEXT,                     -- front face of a DFC, else NULL
  color_identity TEXT NOT NULL DEFAULT '', -- WUBRG-ordered letters, '' = colorless
  type_line      TEXT,
  edhrec_rank    INTEGER,                  -- lower = more popular; NULL = unranked
  art_crop       TEXT,
  image_normal   TEXT,
  partner_flags  INTEGER NOT NULL DEFAULT 0, -- bitmask, see src/commanders/sync.ts
  digest         TEXT NOT NULL,            -- hash of the synced fields; unchanged rows skip the write
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commanders_name ON commanders (name);
CREATE INDEX IF NOT EXISTS idx_commanders_norm ON commanders (norm_name);
CREATE INDEX IF NOT EXISTS idx_commanders_rank ON commanders (edhrec_rank);

-- Key/value bookkeeping for sync runs: commanders.last_synced_at, commanders.count.
CREATE TABLE IF NOT EXISTS sync_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
