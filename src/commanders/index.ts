/**
 * Commander lookup service: the local D1 index first, the live Scryfall API only
 * while the index is empty (fresh install, sync never run). The index is loaded
 * once per isolate — ~3,400 rows of name/rank/colour columns, ~250 KB — and
 * searched in memory, so autocomplete never waits on a network call.
 */

import { resolveCommander, searchCommanders } from '../scryfall';
import {
  buildIndex,
  isConfident,
  normalizeName,
  searchIndex,
  type CommanderMatch,
  type SearchIndex,
} from './search';

export type { CommanderMatch } from './search';

export interface CommanderRow {
  oracleId: string;
  name: string;
  shortName: string;
  colors: string;
  typeLine: string | null;
  rank: number | null;
  artCrop: string | null;
  imageNormal: string | null;
  partnerFlags: number;
}

interface SnapshotRow {
  name: string;
  norm_name: string;
  short_name: string;
  norm_short: string;
  front_name: string | null;
  color_identity: string;
  edhrec_rank: number | null;
  partner_flags: number;
}

interface FullRow extends SnapshotRow {
  oracle_id: string;
  type_line: string | null;
  art_crop: string | null;
  image_normal: string | null;
}

const SNAPSHOT_SQL =
  'SELECT name, norm_name, short_name, norm_short, front_name, color_identity, edhrec_rank, partner_flags FROM commanders';
const FULL_COLUMNS =
  'oracle_id, name, norm_name, short_name, norm_short, front_name, color_identity, type_line, edhrec_rank, art_crop, image_normal, partner_flags';

/** How many candidates a "did you mean" prompt shows. */
const AMBIGUOUS_LIMIT = 5;

// Per-isolate memo. Workers recycle isolates freely, so this is a cache, not state.
let INDEX: SearchIndex | null = null;
let LOADING: Promise<SearchIndex | null> | null = null;
let LOADING_SINCE = 0;
/** A load older than this is presumed killed (CPU limit) and is restarted rather than awaited. */
const LOAD_STALE_MS = 5000;

function toRow(r: FullRow): CommanderRow {
  return {
    oracleId: r.oracle_id,
    name: r.name,
    shortName: r.short_name,
    colors: r.color_identity,
    typeLine: r.type_line,
    rank: r.edhrec_rank,
    artCrop: r.art_crop,
    imageNormal: r.image_normal,
    partnerFlags: r.partner_flags,
  };
}

/**
 * Load (or return the memoised) index. Null when the table is empty or missing —
 * both mean "fall back to Scryfall". Concurrent callers share one load.
 */
export async function loadIndex(db: D1Database): Promise<SearchIndex | null> {
  if (INDEX) return INDEX;
  if (LOADING && Date.now() - LOADING_SINCE < LOAD_STALE_MS) return LOADING;
  LOADING_SINCE = Date.now();
  LOADING = (async () => {
    try {
      const { results } = await db.prepare(SNAPSHOT_SQL).all<SnapshotRow>();
      if (results.length === 0) return null;
      INDEX = buildIndex(
        results.map((r) => ({
          name: r.name,
          normName: r.norm_name,
          shortName: r.short_name,
          normShort: r.norm_short,
          frontName: r.front_name,
          colors: r.color_identity,
          rank: r.edhrec_rank,
          partnerFlags: r.partner_flags,
        })),
      );
      return INDEX;
    } catch (e) {
      // A missing table (migration not applied) must not take autocomplete down.
      console.warn('commander index unavailable, falling back to Scryfall:', e);
      return null;
    } finally {
      LOADING = null;
    }
  })();
  return LOADING;
}

/** Test seam: drop the memoised index so the next call reloads. */
export function resetIndexCache(): void {
  INDEX = null;
  LOADING = null;
  LOADING_SINCE = 0;
}

export async function getIndexStatus(
  db: D1Database,
): Promise<{ count: number; lastSyncedAt: number | null }> {
  try {
    const [count, meta] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS n FROM commanders').first<{ n: number }>(),
      db
        .prepare("SELECT value FROM sync_meta WHERE key = 'commanders.last_synced_at'")
        .first<{ value: string }>(),
    ]);
    return { count: count?.n ?? 0, lastSyncedAt: meta ? Number(meta.value) : null };
  } catch {
    return { count: 0, lastSyncedAt: null };
  }
}

/**
 * Autocomplete: ranked matches from the index, or Scryfall's list when the index
 * is empty. While a cold isolate is still building the index, answer from a
 * cheap prefix query so the first keystroke is never slow; `ctx` lets the load
 * finish in the background.
 */
export async function suggestCommanders(
  db: D1Database,
  query: string,
  ctx?: ExecutionContext,
  limit = 25,
): Promise<CommanderMatch[]> {
  if (INDEX) return searchIndex(INDEX, query, limit);
  if (ctx) {
    ctx.waitUntil(loadIndex(db));
    const prefix = await prefixQuery(db, query, limit);
    if (prefix !== null) return prefix;
  } else {
    const idx = await loadIndex(db);
    if (idx) return searchIndex(idx, query, limit);
  }
  const names = await searchCommanders(query);
  return names.map((name) => ({
    name,
    shortName: name,
    colors: '',
    rank: null,
    partnerFlags: 0,
    tier: 3,
    cost: 0,
  }));
}

/** Cold-path autocomplete: one indexed LIKE query. Null when the table is empty/missing. */
async function prefixQuery(db: D1Database, query: string, limit: number): Promise<CommanderMatch[] | null> {
  const q = normalizeName(query);
  if (q.length < 2) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT ${FULL_COLUMNS} FROM commanders
         WHERE norm_name LIKE ?1 OR norm_short LIKE ?1 OR norm_name LIKE ?2
         ORDER BY CASE WHEN norm_name LIKE ?1 THEN 0 ELSE 1 END, edhrec_rank IS NULL, edhrec_rank
         LIMIT ?3`,
      )
      .bind(`${q}%`, `% ${q}%`, limit)
      .all<FullRow>();
    if (results.length === 0) {
      const status = await getIndexStatus(db);
      if (status.count === 0) return null;
    }
    return results.map((r) => ({
      name: r.name,
      shortName: r.short_name,
      colors: r.color_identity,
      rank: r.edhrec_rank,
      partnerFlags: r.partner_flags,
      tier: 3,
      cost: 0,
    }));
  } catch {
    return null;
  }
}

export async function getCommanderByName(db: D1Database, exact: string): Promise<CommanderRow | null> {
  try {
    const row = await db
      .prepare(`SELECT ${FULL_COLUMNS} FROM commanders WHERE name = ?`)
      .bind(exact)
      .first<FullRow>();
    return row ? toRow(row) : null;
  } catch {
    return null;
  }
}

export type CommanderResolution =
  | { kind: 'exact'; commander: CommanderRow }
  | { kind: 'ambiguous'; candidates: CommanderMatch[] }
  | { kind: 'none'; raw: string };

/**
 * Resolve free-typed input to one canonical commander. Confident matches (exact,
 * or unique at their tier) come back as `exact`; a typo or a shared short name
 * ("atraxa") comes back `ambiguous` with the top candidates so the caller can ask.
 * With an empty index this delegates to Scryfall's fuzzy lookup.
 */
export async function resolveCommanderIndex(db: D1Database, raw: string): Promise<CommanderResolution> {
  const idx = await loadIndex(db);
  if (!idx) {
    const hit = await resolveCommander(raw);
    if (!hit) return { kind: 'none', raw };
    return {
      kind: 'exact',
      commander: {
        oracleId: '',
        name: hit.name,
        shortName: hit.name,
        colors: '',
        typeLine: null,
        rank: null,
        artCrop: hit.art,
        imageNormal: null,
        partnerFlags: 0,
      },
    };
  }
  const matches = searchIndex(idx, raw, AMBIGUOUS_LIMIT);
  if (matches.length === 0) return { kind: 'none', raw };
  if (isConfident(matches)) {
    const row = await getCommanderByName(db, matches[0].name);
    if (row) return { kind: 'exact', commander: row };
  }
  return { kind: 'ambiguous', candidates: matches };
}

/**
 * Colour identity per stored deck identity. Partner pairs ("A + B") are split and
 * their identities unioned. Names the index does not know map to ''.
 */
export async function getCommanderColors(db: D1Database, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const parts = new Set<string>();
  for (const n of names) for (const p of n.split(' + ')) parts.add(p);
  if (parts.size === 0) return out;
  const lookup = new Map<string, string>();
  try {
    const list = [...parts];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const { results } = await db
        .prepare(
          `SELECT name, color_identity FROM commanders WHERE name IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(...chunk)
        .all<{ name: string; color_identity: string }>();
      for (const r of results) lookup.set(r.name, r.color_identity);
    }
  } catch {
    return out;
  }
  const WUBRG = ['W', 'U', 'B', 'R', 'G'];
  for (const n of names) {
    const set = new Set<string>();
    for (const p of n.split(' + ')) for (const c of lookup.get(p) ?? '') set.add(c);
    out.set(n, WUBRG.filter((c) => set.has(c)).join(''));
  }
  return out;
}

/** WUBRG letters → mana emoji, for autocomplete labels. */
export function colorEmoji(colors: string): string {
  if (!colors) return '◇';
  const map: Record<string, string> = { W: '⚪', U: '🔵', B: '⚫', R: '🔴', G: '🟢' };
  return [...colors].map((c) => map[c] ?? '').join('');
}
