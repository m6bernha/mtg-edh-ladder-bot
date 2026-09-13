import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  colorEmoji,
  getCommanderColors,
  getIndexStatus,
  resetIndexCache,
  resolveCommanderIndex,
  suggestCommanders,
} from '../src/commanders';
import { fakeD1 } from './helpers/fake-d1';

const SNAPSHOT = 'FROM commanders';
const rows = [
  { name: "Atraxa, Praetors' Voice", norm_name: 'atraxa praetors voice', short_name: 'Atraxa', norm_short: 'atraxa', front_name: null, color_identity: 'WUBG', edhrec_rank: 2480, partner_flags: 0 },
  { name: 'Atraxa, Grand Unifier', norm_name: 'atraxa grand unifier', short_name: 'Atraxa', norm_short: 'atraxa', front_name: null, color_identity: 'WUBG', edhrec_rank: 3540, partner_flags: 0 },
  { name: 'Edgar Markov', norm_name: 'edgar markov', short_name: 'Edgar Markov', norm_short: 'edgar markov', front_name: null, color_identity: 'WBR', edhrec_rank: 3157, partner_flags: 0 },
];
const fullEdgar = {
  oracle_id: 'o1',
  name: 'Edgar Markov',
  norm_name: 'edgar markov',
  short_name: 'Edgar Markov',
  norm_short: 'edgar markov',
  front_name: null,
  color_identity: 'WBR',
  type_line: 'Legendary Creature — Vampire Knight',
  edhrec_rank: 3157,
  art_crop: 'https://img/edgar',
  image_normal: 'https://img/edgar-normal',
  partner_flags: 0,
};

const fetchSpy = vi.fn();
beforeEach(() => {
  resetIndexCache();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function scryfallResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe('with a populated index', () => {
  const db = () =>
    fakeD1([
      { match: 'SELECT name, norm_name, short_name, norm_short, front_name, color_identity, edhrec_rank, partner_flags FROM commanders', rows },
      { match: 'WHERE name = ?', first: fullEdgar },
      { match: 'COUNT(*)', first: { n: rows.length } },
      { match: 'sync_meta', first: { value: '1700000000' } },
    ]);

  it('autocomplete never touches the network', async () => {
    fetchSpy.mockImplementation(() => {
      throw new Error('network must not be used');
    });
    const m = await suggestCommanders(db(), 'atrax');
    expect(m.map((x) => x.name)).toEqual(["Atraxa, Praetors' Voice", 'Atraxa, Grand Unifier']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a second call reuses the memoised index (one snapshot query)', async () => {
    const d = db();
    await suggestCommanders(d, 'edgar');
    await suggestCommanders(d, 'atraxa');
    expect(d.log.filter((s) => s.includes(SNAPSHOT))).toHaveLength(1);
  });

  it('resolves a unique match to the full row', async () => {
    const r = await resolveCommanderIndex(db(), 'edgr markov'.replace('edgr', 'edgar'));
    expect(r.kind).toBe('exact');
    if (r.kind === 'exact') expect(r.commander.artCrop).toBe('https://img/edgar');
  });

  it('reports a shared short name as ambiguous with both candidates', async () => {
    const r = await resolveCommanderIndex(db(), 'atraxa');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.name)).toHaveLength(2);
  });

  it('reports a typo as ambiguous, never silently committing a fuzzy guess', async () => {
    const r = await resolveCommanderIndex(db(), 'edgr markov');
    expect(r.kind).toBe('ambiguous');
  });

  it('returns none for nonsense', async () => {
    expect((await resolveCommanderIndex(db(), 'qqqzzz')).kind).toBe('none');
  });

  it('getIndexStatus reads count and last sync', async () => {
    expect(await getIndexStatus(db())).toEqual({ count: 3, lastSyncedAt: 1700000000 });
  });
});

describe('cold isolate with ctx', () => {
  it('answers from the prefix query while the index loads in the background', async () => {
    const d = fakeD1([
      { match: 'SELECT name, norm_name, short_name, norm_short, front_name, color_identity, edhrec_rank, partner_flags FROM commanders', rows },
      { match: 'LIKE ?1', rows: [fullEdgar] },
    ]);
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const m = await suggestCommanders(d, 'edg', ctx);
    expect(m.map((x) => x.name)).toEqual(['Edgar Markov']);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    // Now warm: the in-memory index answers, no LIKE query.
    const before = d.log.length;
    await suggestCommanders(d, 'atraxa', ctx);
    expect(d.log.length).toBe(before);
  });
});

describe('with an empty or missing index', () => {
  const empty = () =>
    fakeD1([
      { match: 'SELECT name, norm_name, short_name, norm_short, front_name, color_identity, edhrec_rank, partner_flags FROM commanders', rows: [] },
      { match: 'LIKE ?1', rows: [] },
      { match: 'COUNT(*)', first: { n: 0 } },
      { match: 'sync_meta', first: null },
    ]);
  const missing = () => fakeD1([{ match: 'commanders', error: 'no such table: commanders' }]);

  it('autocomplete falls back to Scryfall search', async () => {
    fetchSpy.mockImplementation(() => scryfallResponse({ data: [{ name: 'Edgar Markov' }] }));
    const m = await suggestCommanders(empty(), 'edgar');
    expect(m.map((x) => x.name)).toEqual(['Edgar Markov']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('api.scryfall.com/cards/search');
  });

  it('resolution falls back to Scryfall fuzzy lookup', async () => {
    fetchSpy.mockImplementation(() =>
      scryfallResponse({ name: 'Edgar Markov', image_uris: { art_crop: 'https://img/e' } }),
    );
    const r = await resolveCommanderIndex(empty(), 'edgar markov');
    expect(r).toMatchObject({ kind: 'exact', commander: { name: 'Edgar Markov', artCrop: 'https://img/e' } });
  });

  it('a missing table degrades the same way instead of throwing', async () => {
    // A query no earlier test cached in scryfall.ts's per-isolate map.
    fetchSpy.mockImplementation(() => scryfallResponse({ data: [] }));
    expect(await suggestCommanders(missing(), 'kaalia')).toEqual([]);
    expect(await getIndexStatus(missing())).toEqual({ count: 0, lastSyncedAt: null });
    fetchSpy.mockImplementation(() => Promise.resolve(new Response('', { status: 404 })));
    expect((await resolveCommanderIndex(missing(), 'edgar')).kind).toBe('none');
  });
});

describe('getCommanderColors', () => {
  it('unions partner pairs and returns empty for unknown names', async () => {
    const d = fakeD1([
      {
        match: 'SELECT name, color_identity FROM commanders WHERE name IN',
        rows: [
          { name: 'Tymna the Weaver', color_identity: 'WB' },
          { name: 'Thrasios, Triton Hero', color_identity: 'UG' },
        ],
      },
    ]);
    const m = await getCommanderColors(d, ['Thrasios, Triton Hero + Tymna the Weaver', 'Nobody']);
    expect(m.get('Thrasios, Triton Hero + Tymna the Weaver')).toBe('WUBG');
    expect(m.get('Nobody')).toBe('');
  });
});

describe('colorEmoji', () => {
  it('maps WUBRG and marks colorless', () => {
    expect(colorEmoji('WUBG')).toBe('⚪🔵⚫🟢');
    expect(colorEmoji('')).toBe('◇');
  });
});
