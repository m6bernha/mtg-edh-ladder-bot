// Re-link historical commander names to the synced index.
//
//   npm run backfill-commanders              → report only (remote D1)
//   npm run backfill-commanders -- --apply   → apply the confident re-links
//   add --local to target the wrangler dev D1
//
// Every game_players.commander value was canonicalised through Scryfall's fuzzy
// lookup at the time, so most already match the index exactly. This script finds
// the rest: a confident index match (exact, alias, or a unique prefix/substring
// hit) is queued as an UPDATE; a typo or an ambiguous short name is REPORTED with
// its top candidates and never guessed. Partner pairs ("A + B") are split, each
// half resolved, then re-joined alphabetically like combineCommanders does.
//
// Take a backup first: npx wrangler d1 export edh-ladder --remote --output=backups/pre-backfill.sql

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, isConfident, searchIndex } from '../src/commanders/search.ts';
import { sqlLiteral } from '../src/commanders/sync.ts';

const DB_NAME = 'edh-ladder';
const NL = String.fromCharCode(10);
const args = new Set(process.argv.slice(2));
const target = args.has('--local') ? '--local' : '--remote';
const apply = args.has('--apply');

const dir = mkdtempSync(join(tmpdir(), 'edh-backfill-'));
let fileNo = 0;
/**
 * Reads go through --command: against a remote database, --file runs as an
 * import and returns only statistics, not rows. The SQL here is fixed text
 * (no user input) and contains no double quotes, so it is shell-safe as is.
 */
function query(sql) {
  if (sql.includes('"')) throw new Error('read queries must not contain double quotes');
  const out = execSync(`npx wrangler d1 execute ${DB_NAME} ${target} --json --command "${sql.replace(/\s+/g, ' ').trim()}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

/** Writes go through --file (no shell quoting, any size). */
function d1(sql) {
  const file = join(dir, `q-${++fileNo}.sql`);
  writeFileSync(file, sql + NL);
  execSync(`npx wrangler d1 execute ${DB_NAME} ${target} --file "${file}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

const indexRows = query(
  'SELECT name, norm_name, short_name, norm_short, front_name, color_identity, edhrec_rank, partner_flags FROM commanders',
);
if (indexRows.length === 0) {
  console.error('The commander index is empty — run `npm run sync-commanders` first.');
  process.exit(1);
}
const idx = buildIndex(
  indexRows.map((r) => ({
    name: r.name,
    normName: r.norm_name,
    shortName: r.short_name,
    normShort: r.norm_short,
    frontName: r.front_name,
    colors: r.color_identity,
    rank: r.edhrec_rank,
    partnerFlags: r.partner_flags,
  })),
);
const artByName = new Map(query('SELECT name, art_crop FROM commanders').map((r) => [r.name, r.art_crop]));

const stored = query(
  'SELECT commander, COUNT(*) AS seats FROM game_players WHERE commander IS NOT NULL GROUP BY commander ORDER BY seats DESC',
);
console.log(`${stored.length} distinct stored commander value(s) across ${stored.reduce((a, r) => a + r.seats, 0)} seats\n`);

const updates = [];
const ambiguous = [];
let exact = 0;
for (const { commander, seats } of stored) {
  const parts = commander.split(' + ');
  const resolved = [];
  let confident = true;
  const notes = [];
  for (const part of parts) {
    if (idx.byName.has(part)) {
      resolved.push(part);
      continue;
    }
    const m = searchIndex(idx, part, 5);
    if (m.length > 0 && isConfident(m)) {
      resolved.push(m[0].name);
      notes.push(`"${part}" → ${m[0].name} (tier ${m[0].tier})`);
    } else {
      confident = false;
      notes.push(
        `"${part}" ?? ${m.length ? m.map((c) => `${c.name} [t${c.tier}]`).join(' | ') : 'no candidates'}`,
      );
    }
  }
  const canonical = resolved.length === parts.length && parts.length > 1
    ? [...resolved].sort((x, y) => x.localeCompare(y)).join(' + ')
    : resolved[0];
  if (confident && canonical === commander) {
    exact++;
    continue;
  }
  if (confident) {
    updates.push({ from: commander, to: canonical, seats, notes });
  } else {
    ambiguous.push({ from: commander, seats, notes });
  }
}

console.log(`✔ ${exact} already canonical`);
if (updates.length) {
  console.log(`\n→ ${updates.length} confident re-link(s):`);
  for (const u of updates) console.log(`   ${u.seats}× "${u.from}" → "${u.to}"   ${u.notes.join('; ')}`);
}
if (ambiguous.length) {
  console.log(`\n? ${ambiguous.length} ambiguous — left untouched, fix by hand with /commander or SQL:`);
  for (const a of ambiguous) console.log(`   ${a.seats}× "${a.from}"   ${a.notes.join('; ')}`);
}

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
if (!apply) {
  if (updates.length) console.log('\nRe-run with --apply to write the confident re-links.');
  process.exit(0);
}
if (updates.length === 0) {
  console.log('\nNothing to apply.');
  process.exit(0);
}

const sql = updates
  .map((u) => {
    // Art follows the name that leads the (alphabetised) identity, as /commander does.
    const lead = u.to.split(' + ')[0];
    const art = artByName.get(lead) ?? null;
    return (
      `UPDATE game_players SET commander = ${sqlLiteral(u.to)}, ` +
      `commander_image = COALESCE(${sqlLiteral(art)}, commander_image) ` +
      `WHERE commander = ${sqlLiteral(u.from)};`
    );
  })
  .join(NL);
d1(sql);
console.log(`${NL}✅ Applied ${updates.length} re-link(s).`);
