/**
 * Turns Scryfall search pages into `commanders` rows. Pure functions only, so the
 * sync script (scripts/sync-commanders.mjs) and the tests share one parser and
 * there is exactly one place that decides what a commander record looks like.
 */

import { normalizeName, shortNameOf } from './search.ts';

/** Bitmask stored in commanders.partner_flags. */
export const PartnerFlag = {
  PARTNER: 1, // plain "Partner"
  PARTNER_WITH: 2, // "Partner with <name>"
  FRIENDS_FOREVER: 4,
  CHOOSE_BACKGROUND: 8, // "Choose a Background"
  DOCTORS_COMPANION: 16,
  IS_BACKGROUND: 32, // the Background card itself
  IS_DOCTOR: 64, // a Time Lord Doctor
} as const;

export interface CommanderRecord {
  oracleId: string;
  scryfallId: string;
  name: string;
  normName: string;
  shortName: string;
  normShort: string;
  frontName: string | null;
  colorIdentity: string;
  typeLine: string | null;
  edhrecRank: number | null;
  artCrop: string | null;
  imageNormal: string | null;
  partnerFlags: number;
  digest: string;
}

interface ScryfallImageUris {
  art_crop?: string;
  normal?: string;
  small?: string;
}
interface ScryfallFace {
  name?: string;
  oracle_text?: string;
  type_line?: string;
  image_uris?: ScryfallImageUris;
}
export interface ScryfallCard {
  id?: string;
  oracle_id?: string;
  name?: string;
  type_line?: string;
  oracle_text?: string;
  keywords?: string[];
  color_identity?: string[];
  edhrec_rank?: number | null;
  image_uris?: ScryfallImageUris;
  card_faces?: ScryfallFace[];
}
export interface ScryfallSearchPage {
  object?: string;
  total_cards?: number;
  has_more?: boolean;
  next_page?: string;
  data?: ScryfallCard[];
}

const WUBRG = ['W', 'U', 'B', 'R', 'G'];

/** Scryfall returns colour identity as an array; store it in canonical WUBRG order. */
export function colorIdentityOf(card: ScryfallCard): string {
  const set = new Set(card.color_identity ?? []);
  return WUBRG.filter((c) => set.has(c)).join('');
}

export function partnerFlags(card: ScryfallCard): number {
  const text = [card.oracle_text ?? '', ...(card.card_faces ?? []).map((f) => f.oracle_text ?? '')].join('\n');
  const type = card.type_line ?? '';
  const keywords = new Set((card.keywords ?? []).map((k) => k.toLowerCase()));
  let flags = 0;
  if (/\bPartner with\b/.test(text)) flags |= PartnerFlag.PARTNER_WITH;
  else if (keywords.has('partner') || /(^|\n)Partner(\s*\(|\s*$)/m.test(text)) flags |= PartnerFlag.PARTNER;
  if (/\bFriends forever\b/.test(text)) flags |= PartnerFlag.FRIENDS_FOREVER;
  if (/\bChoose a Background\b/i.test(text)) flags |= PartnerFlag.CHOOSE_BACKGROUND;
  if (/\bDoctor's companion\b/i.test(text)) flags |= PartnerFlag.DOCTORS_COMPANION;
  if (/\bBackground\b/.test(type)) flags |= PartnerFlag.IS_BACKGROUND;
  if (/\bTime Lord Doctor\b/.test(type)) flags |= PartnerFlag.IS_DOCTOR;
  // "Friends forever" is reported by Scryfall as the Partner keyword; keep it distinct.
  if (flags & PartnerFlag.FRIENDS_FOREVER) flags &= ~PartnerFlag.PARTNER;
  return flags;
}

function images(card: ScryfallCard): { artCrop: string | null; imageNormal: string | null } {
  const face = card.image_uris ?? card.card_faces?.[0]?.image_uris;
  return { artCrop: face?.art_crop ?? face?.small ?? null, imageNormal: face?.normal ?? null };
}

/** Small, stable, dependency-free hash (FNV-1a) of the fields we persist. */
export function digestOf(fields: Omit<CommanderRecord, 'digest'>): string {
  const s = JSON.stringify([
    fields.scryfallId,
    fields.name,
    fields.colorIdentity,
    fields.typeLine,
    fields.edhrecRank,
    fields.artCrop,
    fields.imageNormal,
    fields.partnerFlags,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function toRecord(card: ScryfallCard): CommanderRecord | null {
  if (!card.oracle_id || !card.id || !card.name) return null;
  const name = card.name;
  const isDfc = name.includes(' // ');
  const frontName = isDfc ? name.split(' // ')[0].trim() : null;
  const shortName = shortNameOf(name);
  const { artCrop, imageNormal } = images(card);
  const fields: Omit<CommanderRecord, 'digest'> = {
    oracleId: card.oracle_id,
    scryfallId: card.id,
    name,
    normName: normalizeName(name),
    shortName,
    normShort: normalizeName(shortName),
    frontName,
    colorIdentity: colorIdentityOf(card),
    typeLine: card.type_line ?? null,
    edhrecRank: typeof card.edhrec_rank === 'number' ? card.edhrec_rank : null,
    artCrop,
    imageNormal,
    partnerFlags: partnerFlags(card),
  };
  return { ...fields, digest: digestOf(fields) };
}

export function parseSearchPage(page: ScryfallSearchPage): CommanderRecord[] {
  const out: CommanderRecord[] = [];
  for (const card of page.data ?? []) {
    const rec = toRecord(card);
    if (rec) out.push(rec);
  }
  return out;
}

// ---- SQL generation ----

/** D1 caps bound parameters at 100 per statement; 15 columns × 6 rows = 90. */
export const COLUMNS = [
  'oracle_id',
  'scryfall_id',
  'name',
  'norm_name',
  'short_name',
  'norm_short',
  'front_name',
  'color_identity',
  'type_line',
  'edhrec_rank',
  'art_crop',
  'image_normal',
  'partner_flags',
  'digest',
  'updated_at',
] as const;
export const ROWS_PER_STATEMENT = 6; // 15 columns × 6 = 90 bound parameters

export function recordValues(r: CommanderRecord, updatedAt: number): (string | number | null)[] {
  return [
    r.oracleId,
    r.scryfallId,
    r.name,
    r.normName,
    r.shortName,
    r.normShort,
    r.frontName,
    r.colorIdentity,
    r.typeLine,
    r.edhrecRank,
    r.artCrop,
    r.imageNormal,
    r.partnerFlags,
    r.digest,
    updatedAt,
  ];
}

/**
 * Multi-row upsert. Unchanged rows (same digest) only bump updated_at, which the
 * end-of-sync stale-row delete relies on; changed rows are rewritten in full.
 */
export function upsertSql(rowCount: number): string {
  const tuple = `(${COLUMNS.map(() => '?').join(', ')})`;
  const tuples = new Array(rowCount).fill(tuple).join(',\n  ');
  const updates = COLUMNS.filter((c) => c !== 'oracle_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return (
    `INSERT INTO commanders (${COLUMNS.join(', ')}) VALUES\n  ${tuples}\n` +
    `ON CONFLICT (oracle_id) DO UPDATE SET ${updates}`
  );
}

/** SQL-literal rendering for the script path (wrangler d1 execute --file takes no bindings). */
export function sqlLiteral(v: string | number | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

export function upsertStatementLiteral(records: CommanderRecord[], updatedAt: number): string {
  const tuples = records
    .map((r) => `(${recordValues(r, updatedAt).map(sqlLiteral).join(', ')})`)
    .join(',\n  ');
  const updates = COLUMNS.filter((c) => c !== 'oracle_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return (
    `INSERT INTO commanders (${COLUMNS.join(', ')}) VALUES\n  ${tuples}\n` +
    `ON CONFLICT (oracle_id) DO UPDATE SET ${updates};`
  );
}
