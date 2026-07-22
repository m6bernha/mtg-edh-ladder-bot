-- 0001_live_card: one live-updating match card per game.
--
-- games.message_id     — the Discord message the /game start card posted, so every
--                        later command can EDIT it (via bot token) instead of posting anew.
-- game_players.commander_image — Scryfall art URL, cached at /commander time so the card
--                        re-renders on every command without another Scryfall round trip.
--
-- Apply: wrangler d1 execute edh-ladder --file migrations/0001_live_card.sql [--local|--remote]
ALTER TABLE games        ADD COLUMN message_id      TEXT;
ALTER TABLE game_players ADD COLUMN commander_image TEXT;
