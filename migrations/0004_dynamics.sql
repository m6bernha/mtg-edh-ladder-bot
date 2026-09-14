-- 0004_dynamics: rating dynamics (rust) bookkeeping, the pre-game #1 for the
-- Kingslayer badge, a commander index for /meta, and per-guild settings for the
-- weekly digest.
--
-- sigma_before keeps its meaning (the player's stored sigma before the report —
-- what /undo restores). sigma_rusted is the inflated value actually fed to the
-- engine when the player had been idle; NULL means no rust was applied.
--
-- Apply: wrangler d1 execute edh-ladder --file migrations/0004_dynamics.sql [--local|--remote]
-- Then:  npm run recompute-ratings   (replays history under the new dynamics)

ALTER TABLE game_players ADD COLUMN sigma_rusted REAL;
ALTER TABLE game_players ADD COLUMN rust_days INTEGER;
ALTER TABLE games ADD COLUMN top_player_id INTEGER REFERENCES players (id);
CREATE INDEX IF NOT EXISTS idx_gp_commander ON game_players (commander);

CREATE TABLE IF NOT EXISTS settings (
  guild_id          TEXT PRIMARY KEY,
  digest_channel_id TEXT,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT NOT NULL
);
