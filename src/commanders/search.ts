/**
 * Pure, in-memory commander name search. No D1, no fetch — everything here is a
 * function of a pre-built index and a query string, so it is unit-testable and
 * cheap enough to run on every autocomplete keystroke inside the Worker's CPU
 * budget (the Free plan allows 10 ms per invocation).
 *
 * Matching is tiered: an exact hit beats a prefix, a prefix beats a substring, and
 * a typo-tolerant fuzzy pass only runs when the cheaper tiers under-fill the
 * result list. Within a tier, EDHREC popularity breaks ties.
 */

import { ALIASES } from './aliases.ts';

/** The columns the index needs — a subset of the `commanders` table. */
export interface IndexRow {
  name: string;
  shortName: string;
  frontName: string | null;
  colors: string;
  rank: number | null;
  partnerFlags: number;
  /** Precomputed normalizeName(name) — the D1 table stores it, and normalizing
   *  3,400 names at load costs ~25 ms of CPU, more than a Free-plan invocation has. */
  normName?: string;
  normShort?: string;
}

export interface IndexEntry extends IndexRow {
  /** normalizeName(name) */
  norm: string;
  /** norm without spaces — lets "urdragon" find "the ur dragon". */
  normJoined: string;
  tokens: string[];
  normShort: string;
  normFront: string | null;
  /** First character of every token, concatenated — a cheap fuzzy prefilter. */
  initials: string;
  /** rank with NULL mapped last, so sorting never touches null. */
  sortRank: number;
}

export interface SearchIndex {
  entries: IndexEntry[];
  byName: Map<string, IndexEntry>;
  aliasMap: Map<string, IndexEntry>;
}

export const Tier = {
  EXACT: 0,
  SHORT_EXACT: 1,
  ALIAS: 2,
  PREFIX: 3,
  WORD_PREFIX: 4,
  TOKEN_SET: 5,
  SUBSTRING: 6,
  FUZZY: 7,
} as const;
export type TierValue = (typeof Tier)[keyof typeof Tier];

export interface CommanderMatch {
  name: string;
  shortName: string;
  colors: string;
  rank: number | null;
  partnerFlags: number;
  tier: TierValue;
  /** Fuzzy edit cost (0 for every non-fuzzy tier). */
  cost: number;
}

const UNRANKED = 99_999;
const MIN_QUERY_CHARS = 2;

/**
 * Forgiving normalization: case-, punctuation- and diacritic-insensitive.
 * "Atraxa, Praetors' Voice" → "atraxa praetors voice"; "Lim-Dûl" → "lim dul";
 * "Æther" → "aether". Apostrophes are deleted (not spaced) so "K'rrik" → "krrik".
 */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l')
    .replace(/ß/g, 'ss')
    .replace(/['"“”‘’`´]/g, '')
    .replace(/[,.:;!?()[\]{}/\\\-—–_+&|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everything before the first comma — "Atraxa" from "Atraxa, Praetors' Voice". */
export function shortNameOf(name: string): string {
  const front = name.split(' // ')[0];
  const comma = front.indexOf(',');
  return (comma === -1 ? front : front.slice(0, comma)).trim();
}

export function buildIndex(rows: IndexRow[]): SearchIndex {
  const entries: IndexEntry[] = rows.map((r) => {
    const norm = r.normName ?? normalizeName(r.name);
    const tokens = norm.length ? norm.split(' ') : [];
    let initials = '';
    for (const t of tokens) initials += t[0];
    return {
      name: r.name,
      shortName: r.shortName,
      frontName: r.frontName,
      colors: r.colors,
      rank: r.rank,
      partnerFlags: r.partnerFlags,
      norm,
      normJoined: tokens.join(''),
      tokens,
      normShort: r.normShort ?? normalizeName(r.shortName),
      normFront: r.frontName ? normalizeName(r.frontName) : null,
      initials,
      sortRank: r.rank ?? UNRANKED,
    };
  });
  const byName = new Map<string, IndexEntry>();
  for (const e of entries) byName.set(e.name, e);
  const aliasMap = new Map<string, IndexEntry>();
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const target = byName.get(canonical);
    if (target) aliasMap.set(normalizeName(alias), target);
  }
  return { entries, byName, aliasMap };
}

/** Every query token is a prefix of a distinct name token, in any order. */
function tokenSetMatch(nameTokens: string[], queryTokens: string[]): boolean {
  if (queryTokens.length > nameTokens.length) return false;
  let used = 0; // bitmask — names have far fewer than 31 tokens
  for (const qt of queryTokens) {
    let found = false;
    for (let j = 0; j < nameTokens.length; j++) {
      if ((used & (1 << j)) === 0 && nameTokens[j].startsWith(qt)) {
        used |= 1 << j;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function tierOf(e: IndexEntry, q: string, qTokens: string[], qJoined: string): TierValue | null {
  if (e.norm === q) return Tier.EXACT;
  if (e.normShort === q || e.normFront === q) return Tier.SHORT_EXACT;
  if (e.norm.startsWith(q)) return Tier.PREFIX;
  if (e.norm.indexOf(' ' + q) !== -1) return Tier.WORD_PREFIX;
  if (qTokens.length > 1 && tokenSetMatch(e.tokens, qTokens)) return Tier.TOKEN_SET;
  if (e.norm.indexOf(q) !== -1) return Tier.SUBSTRING;
  if (qJoined.length >= 4 && e.normJoined.indexOf(qJoined) !== -1) return Tier.SUBSTRING;
  return null;
}

// ---- Fuzzy tier: bounded Damerau-Levenshtein (optimal string alignment) ----

const ROW = 64;
const SCRATCH = new Int32Array(3 * ROW);

/**
 * Edit distance between `a` and `b`, or `budget + 1` as soon as it is known to
 * exceed `budget`. Three rolling rows in a shared scratch buffer, no allocation.
 */
function boundedDistance(a: string, b: string, budget: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > budget) return budget + 1;
  if (la >= ROW - 1 || lb >= ROW - 1) return budget + 1;
  let prev2 = 0;
  let prev = ROW;
  let cur = 2 * ROW;
  for (let j = 0; j <= lb; j++) SCRATCH[prev + j] = j;
  for (let i = 1; i <= la; i++) {
    SCRATCH[cur] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1);
      const sub = ca === cb ? 0 : 1;
      let v = Math.min(SCRATCH[prev + j] + 1, SCRATCH[cur + j - 1] + 1, SCRATCH[prev + j - 1] + sub);
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
        v = Math.min(v, SCRATCH[prev2 + j - 2] + 1);
      }
      SCRATCH[cur + j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > budget) return budget + 1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return SCRATCH[prev + lb];
}

function tokenBudget(len: number): number {
  return len >= 7 ? 2 : len >= 4 ? 1 : 0;
}

/**
 * Fuzzy cost of matching every query token against some name token, allowing
 * typos proportional to token length and treating a query token as a prefix of
 * a longer name token ("preat" → "praetors"). Null when any token misses.
 */
function fuzzyCost(e: IndexEntry, qTokens: string[]): number | null {
  let total = 0;
  for (const qt of qTokens) {
    const budget = tokenBudget(qt.length);
    let best = budget + 1;
    for (const nt of e.tokens) {
      if (nt.startsWith(qt)) {
        best = 0;
        break;
      }
      if (budget === 0) continue;
      let d = boundedDistance(qt, nt, budget);
      if (d > 0 && nt.length > qt.length) {
        // Typo inside a partially typed token: compare against the same-length head.
        d = Math.min(d, boundedDistance(qt, nt.slice(0, qt.length), budget));
      }
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > budget) return null;
    total += best;
  }
  return total;
}

/** Cheap gate before the fuzzy matrix: every query token shares its first or second character with some name token's initial. */
function fuzzyPrefilter(e: IndexEntry, qTokens: string[]): boolean {
  for (const qt of qTokens) {
    if (e.initials.indexOf(qt[0]) === -1 && (qt.length < 2 || e.initials.indexOf(qt[1]) === -1)) {
      return false;
    }
  }
  return true;
}

interface Scored {
  e: IndexEntry;
  tier: TierValue;
  cost: number;
}

function toMatch(s: Scored): CommanderMatch {
  return {
    name: s.e.name,
    shortName: s.e.shortName,
    colors: s.e.colors,
    rank: s.e.rank,
    partnerFlags: s.e.partnerFlags,
    tier: s.tier,
    cost: s.cost,
  };
}

function compareScored(a: Scored, b: Scored): number {
  return (
    a.tier - b.tier ||
    a.cost - b.cost ||
    a.e.sortRank - b.e.sortRank ||
    a.e.norm.length - b.e.norm.length ||
    a.e.name.localeCompare(b.e.name)
  );
}

export function searchIndex(idx: SearchIndex, query: string, limit = 25): CommanderMatch[] {
  const q = normalizeName(query);
  if (q.length < MIN_QUERY_CHARS) return [];

  const hits: Scored[] = [];
  const matched = new Uint8Array(idx.entries.length);

  // A nickname hit is added up front; the scan below still runs on the user's
  // literal text so a real card that happens to match it is never hidden.
  const alias = idx.aliasMap.get(q);
  if (alias) {
    hits.push({ e: alias, tier: Tier.ALIAS, cost: 0 });
    matched[idx.entries.indexOf(alias)] = 1;
  }

  const qTokens = q.split(' ');
  const qJoined = q.replace(/ /g, '');

  for (let i = 0; i < idx.entries.length; i++) {
    if (matched[i]) continue;
    const t = tierOf(idx.entries[i], q, qTokens, qJoined);
    if (t !== null) {
      hits.push({ e: idx.entries[i], tier: t, cost: 0 });
      matched[i] = 1;
    }
  }

  // The fuzzy pass is the expensive one: only when the cheap tiers under-fill
  // the list, and never after a confident nickname hit.
  if (!alias && hits.length < limit) {
    for (let i = 0; i < idx.entries.length; i++) {
      if (matched[i]) continue;
      const e = idx.entries[i];
      if (!fuzzyPrefilter(e, qTokens)) continue;
      const cost = fuzzyCost(e, qTokens);
      if (cost !== null) hits.push({ e, tier: Tier.FUZZY, cost });
    }
  }

  hits.sort(compareScored);
  return hits.slice(0, limit).map(toMatch);
}

/**
 * True when the top match can be committed without asking. An exact hit always
 * can; a short-name/alias/prefix/substring hit can when nothing else sits at the
 * same tier; a fuzzy hit never can — a typo is exactly the case where the user
 * should see what we picked.
 */
export function isConfident(matches: CommanderMatch[]): boolean {
  const m0 = matches[0];
  if (!m0) return false;
  if (m0.tier === Tier.EXACT) return true;
  if (m0.tier === Tier.FUZZY) return false;
  const m1 = matches[1];
  return m1 === undefined || m1.tier > m0.tier;
}
