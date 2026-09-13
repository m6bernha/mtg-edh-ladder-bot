import { describe, expect, it } from 'vitest';
import { ALIASES } from '../src/commanders/aliases';
import {
  buildIndex,
  isConfident,
  normalizeName,
  searchIndex,
  shortNameOf,
  Tier,
  type IndexRow,
  type SearchIndex,
} from '../src/commanders/search';
import { parseSearchPage } from '../src/commanders/sync';
import page from './fixtures/scryfall-commanders.json';

/** 39 real Scryfall cards (see test/fixtures) — enough to exercise every tier. */
function fixtureIndex(): SearchIndex {
  const rows: IndexRow[] = parseSearchPage(page).map((r) => ({
    name: r.name,
    normName: r.normName,
    shortName: r.shortName,
    normShort: r.normShort,
    frontName: r.frontName,
    colors: r.colorIdentity,
    rank: r.edhrecRank,
    partnerFlags: r.partnerFlags,
  }));
  return buildIndex(rows);
}
const idx = fixtureIndex();
const names = (q: string, limit?: number) => searchIndex(idx, q, limit).map((m) => m.name);
const top = (q: string) => searchIndex(idx, q)[0];

describe('normalizeName', () => {
  it.each([
    ['ATRAXA', 'atraxa'],
    ["Atraxa, Praetors' Voice", 'atraxa praetors voice'],
    ['Atraxa, Praetors’ Voice', 'atraxa praetors voice'], // curly apostrophe
    ['Lim-Dûl the Necromancer', 'lim dul the necromancer'],
    ['lim dul', 'lim dul'],
    ["K'rrik, Son of Yawgmoth", 'krrik son of yawgmoth'],
    ['Æther Vial', 'aether vial'],
    ['Birgi, God of Storytelling // Harnfel, Horn of Bounty', 'birgi god of storytelling harnfel horn of bounty'],
    ['  urza,   lord  ', 'urza lord'],
    ["',.!?", ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('shortNameOf', () => {
  it('takes the text before the first comma', () => {
    expect(shortNameOf("Atraxa, Praetors' Voice")).toBe('Atraxa');
    expect(shortNameOf('Tymna the Weaver')).toBe('Tymna the Weaver');
  });
  it('uses the front face of a double-faced card', () => {
    expect(shortNameOf('Birgi, God of Storytelling // Harnfel, Horn of Bounty')).toBe('Birgi');
  });
});

describe('searchIndex — tiers', () => {
  it('exact normalized name is tier 0 and confident', () => {
    const m = searchIndex(idx, "atraxa praetors' voice");
    expect(m[0]).toMatchObject({ name: "Atraxa, Praetors' Voice", tier: Tier.EXACT });
    expect(isConfident(m)).toBe(true);
  });

  it('short name hits every card sharing it, most popular first, and is not confident', () => {
    const m = searchIndex(idx, 'atraxa');
    expect(m.map((x) => x.name)).toEqual(["Atraxa, Praetors' Voice", 'Atraxa, Grand Unifier']);
    expect(m.every((x) => x.tier === Tier.SHORT_EXACT)).toBe(true);
    expect(isConfident(m)).toBe(false);
  });

  it('short name of a double-faced card matches its front face', () => {
    expect(top('birgi')).toMatchObject({ name: 'Birgi, God of Storytelling // Harnfel, Horn of Bounty', tier: Tier.SHORT_EXACT });
    expect(top('tergrid').tier).toBe(Tier.SHORT_EXACT);
  });

  it('alias nicknames resolve and are confident', () => {
    expect(top('urdragon')).toMatchObject({ name: 'The Ur-Dragon', tier: Tier.ALIAS });
    expect(top('gitrog')).toMatchObject({ name: 'The Gitrog Monster', tier: Tier.ALIAS });
    expect(top('krrik').name).toBe("K'rrik, Son of Yawgmoth");
    expect(isConfident(searchIndex(idx, 'urdragon'))).toBe(true);
  });

  it('prefix of the full name', () => {
    expect(top('urza lord high')).toMatchObject({ name: 'Urza, Lord High Artificer', tier: Tier.PREFIX });
    expect(top('edgar')).toMatchObject({ name: 'Edgar Markov', tier: Tier.PREFIX });
  });

  it('prefix of an inner word', () => {
    expect(top('praetors')).toMatchObject({ name: "Atraxa, Praetors' Voice", tier: Tier.WORD_PREFIX });
    expect(top('harnfel').name).toContain('Harnfel');
  });

  it('token set: every query word is a word-prefix, any order', () => {
    expect(top('weaver tymna')).toMatchObject({ name: 'Tymna the Weaver', tier: Tier.TOKEN_SET });
    expect(top('king fae')).toMatchObject({ name: 'Korvold, Fae-Cursed King' });
  });

  it('substring, including with spaces removed', () => {
    expect(top('zegana')).toMatchObject({ name: 'Prime Speaker Zegana' });
    expect(top('enchanter')).toMatchObject({ name: 'Zur the Enchanter' });
  });

  it('fuzzy: one typo per word is tolerated but never confident', () => {
    for (const [q, expected] of [
      ['atraxa preators', "Atraxa, Praetors' Voice"],
      ['tymna the waever', 'Tymna the Weaver'],
      ['edgr markov', 'Edgar Markov'],
      ['korvld', 'Korvold, Fae-Cursed King'],
      ['ragvan', 'Ragavan, Nimble Pilferer'],
    ] as const) {
      const m = searchIndex(idx, q);
      expect(m[0], q).toMatchObject({ name: expected, tier: Tier.FUZZY });
      expect(isConfident(m), q).toBe(false);
    }
  });

  it('short words get no typo budget', () => {
    expect(names('zxr')).toEqual([]);
  });
});

describe('searchIndex — normalization in queries', () => {
  it('case, punctuation and diacritics are irrelevant', () => {
    expect(top('LIM-DÛL').name).toBe('Lim-Dûl the Necromancer');
    expect(top('lim dul').name).toBe('Lim-Dûl the Necromancer');
    expect(top("k'rrik son").name).toBe("K'rrik, Son of Yawgmoth");
    expect(top('Kaalia Of The Vast').tier).toBe(Tier.EXACT);
  });
});

describe('searchIndex — ranking and limits', () => {
  it('within a tier, EDHREC rank breaks ties', () => {
    // Three Urzas share the short name; Lord High Artificer is by far the most played.
    expect(names('urza')).toEqual([
      'Urza, Lord High Artificer',
      'Urza, Chief Artificer',
      'Urza, Powerstone Prodigy',
    ]);
  });

  it('unranked (banned) cards sort last within a tier', () => {
    const tiny = buildIndex([
      { name: 'Golos, Tireless Pilgrim', shortName: 'Golos', frontName: null, colors: 'WUBRG', rank: null, partnerFlags: 0 },
      { name: 'Gonti, Lord of Luxury', shortName: 'Gonti', frontName: null, colors: 'B', rank: 900, partnerFlags: 0 },
      { name: 'Gorm the Great', shortName: 'Gorm the Great', frontName: null, colors: 'W', rank: 8000, partnerFlags: 0 },
    ]);
    expect(searchIndex(tiny, 'go').map((m) => m.name)).toEqual([
      'Gonti, Lord of Luxury',
      'Gorm the Great',
      'Golos, Tireless Pilgrim',
    ]);
  });

  it('respects the limit', () => {
    expect(searchIndex(idx, 'a', 25)).toEqual([]); // 1 char
    expect(searchIndex(idx, 'the', 3)).toHaveLength(3);
  });

  it('empty, one-character and punctuation-only queries return nothing', () => {
    expect(names('')).toEqual([]);
    expect(names('x')).toEqual([]);
    expect(names("',.!?")).toEqual([]);
  });

  it('nonsense returns nothing', () => {
    expect(names('zzzzqq')).toEqual([]);
  });

  it('stays fast: 300 queries over a 3,400-entry index in well under a second', () => {
    const rows: IndexRow[] = [];
    const idxRows = [...idx.entries];
    for (let i = 0; i < 3400; i++) {
      const e = idxRows[i % idxRows.length];
      rows.push({ ...e, name: `${e.name} ${i}`, shortName: e.shortName, rank: i });
    }
    const big = buildIndex(rows);
    const queries = ['atraxa preators', 'urza', 'the', 'tymna the waever', 'zzq', 'kaalia of the vast'];
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) searchIndex(big, queries[i % queries.length]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('isConfident', () => {
  it('is false for no matches', () => {
    expect(isConfident([])).toBe(false);
  });
  it('is true for a unique prefix/substring hit', () => {
    expect(isConfident(searchIndex(idx, 'urza lord high'))).toBe(true);
    expect(isConfident(searchIndex(idx, 'zegana'))).toBe(true);
  });
  it('is false when two candidates share the top tier', () => {
    expect(isConfident(searchIndex(idx, 'god of'))).toBe(false);
  });
});

describe('ALIASES', () => {
  it('keys are already normalized and targets look like exact card names', () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
      expect(normalizeName(alias), alias).toBe(alias);
      expect(target.trim(), alias).toBe(target);
      expect(target.length, alias).toBeGreaterThan(2);
    }
  });
  it('an alias whose target is absent from the index is ignored, not thrown', () => {
    const tiny = buildIndex([{ name: 'Edgar Markov', shortName: 'Edgar Markov', frontName: null, colors: 'BRW', rank: 1, partnerFlags: 0 }]);
    expect(tiny.aliasMap.size).toBe(0);
    expect(searchIndex(tiny, 'urdragon')).toEqual([]);
  });
});
