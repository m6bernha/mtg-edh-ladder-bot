import { describe, expect, it } from 'vitest';
import { combineCommanders, normalizeQuery } from '../src/scryfall';

describe('combineCommanders', () => {
  it('single commander passes through', () => {
    expect(combineCommanders('Atraxa, Praetors\' Voice')).toBe('Atraxa, Praetors\' Voice');
    expect(combineCommanders('Atraxa, Praetors\' Voice', null)).toBe('Atraxa, Praetors\' Voice');
  });
  it('pairs are order-independent (alphabetical)', () => {
    expect(combineCommanders('Tymna the Weaver', 'Thrasios, Triton Hero')).toBe(
      'Thrasios, Triton Hero + Tymna the Weaver',
    );
    expect(combineCommanders('Thrasios, Triton Hero', 'Tymna the Weaver')).toBe(
      'Thrasios, Triton Hero + Tymna the Weaver',
    );
  });
  it('duplicate partner collapses to one', () => {
    expect(combineCommanders('Tymna the Weaver', 'tymna, the weaver')).toBe('Tymna the Weaver');
  });
});

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
