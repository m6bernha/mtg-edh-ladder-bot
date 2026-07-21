/** Scryfall commander autocomplete with a hard timeout (Discord gives us 3s
 * total and autocomplete cannot be deferred) and a small per-isolate cache. */

const CACHE = new Map<string, { at: number; names: string[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

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
  const timer = setTimeout(() => ctrl.abort(), 800);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'edh-ladder-discord-bot/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return []; // 404 = no matches; anything else, fail quiet
    const body = (await res.json()) as { data?: { name: string }[] };
    const names = (body.data ?? []).slice(0, 25).map((c) => c.name.slice(0, 100));
    if (CACHE.size >= CACHE_MAX) {
      const oldest = CACHE.keys().next().value;
      if (oldest !== undefined) CACHE.delete(oldest);
    }
    CACHE.set(q, { at: Date.now(), names });
    return names;
  } catch {
    return []; // timeout or network error — user can still type the full name
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

/**
 * Resolve free-typed input to the canonical card name via Scryfall's fuzzy
 * lookup ("urza lord high" → "Urza, Lord High Artificer"), so commander stats
 * never split across casing/punctuation variants. Null when unrecognized.
 */
export async function resolveCommander(name: string): Promise<string | null> {
  const q = normalizeQuery(name);
  if (q.length < 2) return null;
  const url =
    'https://api.scryfall.com/cards/named?' + new URLSearchParams({ fuzzy: q }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'edh-ladder-discord-bot/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null; // 404 = no/ambiguous match
    const card = (await res.json()) as { name?: string };
    return card.name?.slice(0, 100) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
