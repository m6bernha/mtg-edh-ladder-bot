/** Scryfall commander autocomplete with a hard timeout (Discord gives us 3s
 * total and autocomplete cannot be deferred) and a small per-isolate cache. */

const CACHE = new Map<string, { at: number; names: string[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

// Autocomplete cannot be deferred: Discord closes the interaction after 3s, so
// this budget must leave room for our own response. Resolving a name happens
// inside an already-deferred command, so it can afford to wait longer.
const AUTOCOMPLETE_TIMEOUT_MS = 800;
const RESOLVE_TIMEOUT_MS = 1500;

/** Discord rejects autocomplete responses with more than 25 choices. */
const MAX_AUTOCOMPLETE_CHOICES = 25;

/** Discord's per-choice label limit; also what we store as a deck identity. */
const MAX_NAME_CHARS = 100;

/**
 * Forgiving query normalization: case-insensitive and punctuation-insensitive,
 * so "Atraxa, Praetors'" ≡ "atraxa praetors". Hyphens stay (Lim-Dûl etc.);
 * Scryfall itself handles diacritics.
 */
export function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"“”‘’.,:;!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchCommanders(query: string): Promise<string[]> {
  const q = normalizeQuery(query);
  if (q.length < 2) return [];

  const hit = CACHE.get(q);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.names;

  const url =
    'https://api.scryfall.com/cards/search?' +
    new URLSearchParams({
      q: `is:commander ${q}`,
      order: 'edhrec',
      unique: 'cards',
    }).toString();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUTOCOMPLETE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'mtg-edh-ladder-bot/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return []; // 404 = no matches; anything else, fail quiet
    const body = (await res.json()) as { data?: { name: string }[] };
    const names = (body.data ?? [])
      .slice(0, MAX_AUTOCOMPLETE_CHOICES)
      .map((c) => c.name.slice(0, MAX_NAME_CHARS));
    if (CACHE.size >= CACHE_MAX) {
      const oldest = CACHE.keys().next().value;
      if (oldest !== undefined) CACHE.delete(oldest);
    }
    CACHE.set(q, { at: Date.now(), names });
    return names;
  } catch (e) {
    // Timeout or network error — user can still type the full name. Logged so a
    // persistent Scryfall outage is visible in `wrangler tail` rather than just
    // looking like an empty autocomplete.
    console.warn(`scryfall search failed for ${JSON.stringify(q)}:`, e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Combine a commander (and optional partner) into one canonical deck identity.
 * Alphabetical order so "Thrasios + Tymna" ≡ "Tymna + Thrasios" in stats.
 */
export function combineCommanders(a: string, b?: string | null): string {
  if (!b || normalizeQuery(a) === normalizeQuery(b)) return a;
  return [a, b].sort((x, y) => x.localeCompare(y)).join(' + ');
}

interface ScryfallImageUris {
  art_crop?: string;
  small?: string;
}
interface ScryfallCard {
  name?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: { image_uris?: ScryfallImageUris }[];
}

/**
 * Pull an art URL from a Scryfall card payload. Prefers `art_crop` (framed art,
 * ideal as an embed thumbnail); for double-faced commanders the top-level
 * `image_uris` is absent, so fall back to the front face; then to `small`.
 * Null when the payload carries no usable image — art is decorative and must
 * never block logging a deck.
 */
export function extractArt(card: unknown): string | null {
  if (typeof card !== 'object' || card === null) return null;
  const c = card as ScryfallCard;
  const face = c.image_uris ?? c.card_faces?.[0]?.image_uris;
  return face?.art_crop ?? face?.small ?? null;
}

export interface ResolvedCommander {
  name: string;
  art: string | null;
}

/**
 * Resolve free-typed input to the canonical card name (and art) via Scryfall's
 * fuzzy lookup ("urza lord high" → "Urza, Lord High Artificer"), so commander
 * stats never split across casing/punctuation variants. Null when unrecognized.
 */
export async function resolveCommander(name: string): Promise<ResolvedCommander | null> {
  const q = normalizeQuery(name);
  if (q.length < 2) return null;
  const url =
    'https://api.scryfall.com/cards/named?' + new URLSearchParams({ fuzzy: q }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'mtg-edh-ladder-bot/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null; // 404 = no/ambiguous match
    const card = (await res.json()) as ScryfallCard;
    if (!card.name) return null;
    return { name: card.name.slice(0, MAX_NAME_CHARS), art: extractArt(card) };
  } catch (e) {
    // Falls back to storing the name exactly as typed, so a Scryfall outage
    // never blocks logging a deck.
    console.warn(`scryfall resolve failed for ${JSON.stringify(q)}:`, e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
