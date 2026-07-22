-- 0002_drop_elo: TrueSkill SR is the only rating now; classic pairwise Elo is gone.
--
-- None of these columns are indexed, part of a primary key, or referenced by a CHECK
-- constraint, so SQLite (D1 is 3.35+) drops them cleanly. If a future D1 rejects
-- DROP COLUMN, rebuild instead: CREATE TABLE …_new, INSERT … SELECT, DROP, RENAME,
-- then recreate indexes.
--
-- IRREVERSIBLE: exports the pre-drop state is worth taking first —
--   wrangler d1 export edh-ladder --remote --output=backup.sql
--
-- Apply: wrangler d1 execute edh-ladder --file migrations/0002_drop_elo.sql [--local|--remote]
ALTER TABLE players      DROP COLUMN elo;
ALTER TABLE game_players DROP COLUMN elo_before;
ALTER TABLE game_players DROP COLUMN elo_after;
