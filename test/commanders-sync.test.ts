import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  PartnerFlag,
  ROWS_PER_STATEMENT,
  digestOf,
  parseSearchPage,
  sqlLiteral,
  toRecord,
  upsertSql,
  upsertStatementLiteral,
  type ScryfallSearchPage,
} from '../src/commanders/sync';

import fixture from './fixtures/scryfall-commanders.json';

const page = fixture as ScryfallSearchPage;
const records = parseSearchPage(page);
const byName = new Map(records.map((r) => [r.name, r]));

describe('parseSearchPage', () => {
  it('yields one record per card with canonical fields', () => {
    expect(records).toHaveLength(page.data!.length);
    const atraxa = byName.get("Atraxa, Praetors' Voice")!;
    expect(atraxa).toMatchObject({
      shortName: 'Atraxa',
      normName: 'atraxa praetors voice',
      normShort: 'atraxa',
      frontName: null,
      colorIdentity: 'WUBG', // WUBRG order, not Scryfall's alphabetical
      edhrecRank: expect.any(Number),
      partnerFlags: 0,
    });
    expect(atraxa.artCrop).toMatch(/^https:\/\//);
    expect(atraxa.imageNormal).toMatch(/^https:\/\//);
    expect(atraxa.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('double-faced card: front name, front-face art', () => {
    const birgi = byName.get('Birgi, God of Storytelling // Harnfel, Horn of Bounty')!;
    expect(birgi.frontName).toBe('Birgi, God of Storytelling');
    expect(birgi.shortName).toBe('Birgi');
    expect(birgi.artCrop).toContain('scryfall');
  });

  it('a banned card has a null rank', () => {
    expect(byName.get('Golos, Tireless Pilgrim')!.edhrecRank).toBeNull();
  });

  it('skips malformed cards', () => {
    expect(toRecord({ name: 'No ids' })).toBeNull();
    expect(parseSearchPage({})).toEqual([]);
  });
});

describe('partner flags', () => {
  it.each([
    ['Tymna the Weaver', PartnerFlag.PARTNER],
    ['Alisaie Leveilleur', PartnerFlag.PARTNER_WITH],
    ["Wernog, Rider's Chaplain", PartnerFlag.FRIENDS_FOREVER],
    ['Jaheira, Friend of the Forest', PartnerFlag.CHOOSE_BACKGROUND],
    ['Passionate Archaeologist', PartnerFlag.IS_BACKGROUND],
    ['K-9, Mark I', PartnerFlag.DOCTORS_COMPANION],
    ['The Second Doctor', PartnerFlag.IS_DOCTOR],
    ['Edgar Markov', 0],
  ])('%s → %i', (name, flags) => {
    expect(byName.get(name)!.partnerFlags).toBe(flags);
  });
});

describe('digest', () => {
  it('is stable for identical fields and changes when a persisted field changes', () => {
    const r = byName.get('Edgar Markov')!;
    const { digest, ...fields } = r;
    expect(digestOf(fields)).toBe(digest);
    expect(digestOf({ ...fields, edhrecRank: (fields.edhrecRank ?? 0) + 1 })).not.toBe(digest);
  });
});

describe('SQL generation', () => {
  it('bound upsert never exceeds 100 parameters per statement', () => {
    expect(COLUMNS.length * ROWS_PER_STATEMENT).toBeLessThanOrEqual(100);
    const sql = upsertSql(ROWS_PER_STATEMENT);
    expect(sql.split('?').length - 1).toBe(COLUMNS.length * ROWS_PER_STATEMENT);
    expect(sql).toContain('ON CONFLICT (oracle_id) DO UPDATE');
  });

  it('literal upsert escapes quotes and renders NULL', () => {
    expect(sqlLiteral("K'rrik")).toBe("'K''rrik'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(42)).toBe('42');
    const sql = upsertStatementLiteral([byName.get("K'rrik, Son of Yawgmoth")!, byName.get('Golos, Tireless Pilgrim')!], 1700000000);
    expect(sql).toContain("'K''rrik, Son of Yawgmoth'");
    expect(sql).toMatch(/NULL, 'https/); // Golos: NULL rank before its art URL
    expect(sql.trim().endsWith(';')).toBe(true);
  });
});
