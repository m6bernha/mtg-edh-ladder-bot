import { describe, expect, it } from 'vitest';
import { normalizeQuery } from '../src/scryfall';

describe('normalizeQuery', () => {
  it('lowercases', () => {
    expect(normalizeQuery('ATRAXA')).toBe('atraxa');
  });
  it('strips commas, periods, apostrophes, quotes', () => {
    expect(normalizeQuery("Atraxa, Praetors' Voice")).toBe('atraxa praetors voice');
    expect(normalizeQuery('Urza, Lord High Artificer.')).toBe('urza lord high artificer');
    expect(normalizeQuery('“Kellan, the Fae-Blooded”')).toBe('kellan the fae-blooded');
  });
  it('keeps hyphens', () => {
    expect(normalizeQuery('Lim-Dul')).toBe('lim-dul');
  });
  it('collapses whitespace', () => {
    expect(normalizeQuery('  urza,   lord  ')).toBe('urza lord');
  });
  it('punctuation-only input normalizes to empty', () => {
    expect(normalizeQuery("',.!?")).toBe('');
  });
});
