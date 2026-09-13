-- 0003_commander_index: a local copy of every commander-legal card, so autocomplete
-- and name resolution are instant, typo-tolerant and independent of Scryfall uptime.
-- Populated by `npm run sync-commanders` (Scryfall paginated search); the live
-- Scryfall API stays as the fallback while this table is empty.
--
-- Apply: wrangler d1 execute edh-ladder --file migrations/0003_commander_index.sql [--local|--remote]

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
