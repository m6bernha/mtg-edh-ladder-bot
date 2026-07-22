import { describe, expect, it } from 'vitest';
import { combineCommanders, extractArt, normalizeQuery } from '../src/scryfall';

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

describe('extractArt', () => {
  it('prefers art_crop from a single-faced card', () => {
    const card = {
      name: 'Atraxa, Praetors\' Voice',
      image_uris: { art_crop: 'https://img/atraxa-crop', small: 'https://img/atraxa-small' },
    };
    expect(extractArt(card)).toBe('https://img/atraxa-crop');
  });

  it('falls back to the front face for double-faced commanders', () => {
    const dfc = {
      name: 'Kellan, the Fae-Blooded // Birthright Boon',
      card_faces: [
        { image_uris: { art_crop: 'https://img/kellan-front-crop' } },
        { image_uris: { art_crop: 'https://img/kellan-back-crop' } },
      ],
    };
    expect(extractArt(dfc)).toBe('https://img/kellan-front-crop');
  });

  it('falls back to small when art_crop is absent', () => {
    expect(extractArt({ image_uris: { small: 'https://img/small-only' } })).toBe(
      'https://img/small-only',
    );
  });

  it('returns null for art-less or malformed payloads', () => {
    expect(extractArt({ name: 'No Images' })).toBeNull();
    expect(extractArt(null)).toBeNull();
    expect(extractArt('not a card')).toBeNull();
    expect(extractArt({ card_faces: [] })).toBeNull();
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
