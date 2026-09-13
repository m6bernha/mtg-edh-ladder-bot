// Populate / refresh the local commander index from Scryfall.
//
//   npm run sync-commanders                 → remote D1 (production)
//   npm run sync-commanders -- --local      → the wrangler dev D1
//   npm run sync-commanders -- --dry-run    → fetch + parse, write nothing
//
// Why a script and not a Worker cron: on the Workers Free plan an invocation
// gets 10 ms of CPU, which cannot even JSON.parse one ~950 KB Scryfall page.
// Run this monthly (new sets) — a stale index only means new commanders are
// missing from autocomplete; everything else keeps working.
//
// Requires `npx wrangler login` (or CLOUDFLARE_API_TOKEN) for the remote target.
// The parser is shared with the Worker: src/commanders/sync.ts is imported
// directly, which needs Node ≥ 22.18 (type stripping) — Node 24 is fine.

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSearchPage, upsertStatementLiteral } from '../src/commanders/sync.ts';
import { ALIASES } from '../src/commanders/aliases.ts';

const DB_NAME = 'edh-ladder';
const START_URL =
  'https://api.scryfall.com/cards/search?' +
  new URLSearchParams({ q: 'is:commander legal:commander', unique: 'cards', order: 'edhrec' });
const HEADERS = { 'User-Agent': 'mtg-edh-ladder-bot/1.0 (sync)', Accept: 'application/json' };
const REQUEST_GAP_MS = 100; // Scryfall asks for 50–100 ms between requests
const ROWS_PER_STATEMENT = 40; // literal SQL, no bind cap; keeps each statement well under 100 KB
const STATEMENTS_PER_FILE = 25; // ~1,000 rows per wrangler invocation

const args = new Set(process.argv.slice(2));
const target = args.has('--local') ? '--local' : '--remote';
const dryRun = args.has('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url, attempt = 0) {
  const res = await fetch(url, { headers: HEADERS });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`Scryfall ${res.status} after ${attempt} retries`);
    const wait = 1000 * 2 ** attempt;
    console.warn(`  Scryfall ${res.status}; retrying in ${wait} ms`);
    await sleep(wait);
    return fetchPage(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`Scryfall ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

let dir = null;
let fileNo = 0;
/**
 * Run SQL through `wrangler d1 execute --file`. The CLI cannot bind parameters,
 * and a --command string would need shell quoting on Windows, so every write
 * goes through a temp file.
 */
function d1(sql) {
  const file = join(dir, `chunk-${++fileNo}.sql`);
  writeFileSync(file, sql.endsWith('\n') ? sql : sql + '\n');
  return execSync(`npx wrangler d1 execute ${DB_NAME} ${target} --file "${file}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

const runStartedAt = Math.floor(Date.now() / 1000);
console.log(`Syncing commanders from Scryfall → D1 ${DB_NAME} (${target})${dryRun ? ' [dry run]' : ''}`);

// 1. Fetch every page.
const records = [];
let url = START_URL;
let page = 0;
while (url) {
  page++;
  const body = await fetchPage(url);
  const recs = parseSearchPage(body);
  records.push(...recs);
  process.stdout.write(`  page ${page}: ${recs.length} cards (total ${records.length}/${body.total_cards ?? '?'})\n`);
  url = body.has_more ? body.next_page : null;
  if (url) await sleep(REQUEST_GAP_MS);
}
if (records.length < 1000) {
  console.error(`Only ${records.length} commanders parsed — refusing to sync (Scryfall query shape changed?).`);
  process.exit(1);
}

// 2. Warn about aliases that no longer point at a real card.
const names = new Set(records.map((r) => r.name));
for (const [alias, canonical] of Object.entries(ALIASES)) {
  if (!names.has(canonical)) console.warn(`  ⚠ alias "${alias}" → "${canonical}" not found in index`);
}

if (dryRun) {
  console.log('Dry run — first 5 records:');
  for (const r of records.slice(0, 5)) {
    console.log('  ', r.name, '|', r.colorIdentity, '|', r.edhrecRank, '| flags', r.partnerFlags);
  }
  process.exit(0);
}

// 3. Upsert in chunks, then drop cards that left the index and record the run.
dir = mkdtempSync(join(tmpdir(), 'edh-sync-'));
try {
  const perFile = ROWS_PER_STATEMENT * STATEMENTS_PER_FILE;
  for (let i = 0; i < records.length; i += perFile) {
    const slice = records.slice(i, i + perFile);
    const statements = [];
    for (let j = 0; j < slice.length; j += ROWS_PER_STATEMENT) {
      statements.push(upsertStatementLiteral(slice.slice(j, j + ROWS_PER_STATEMENT), runStartedAt));
    }
    process.stdout.write(`  writing rows ${i + 1}–${i + slice.length}…\n`);
    d1(statements.join('\n\n'));
  }
  d1(
    `DELETE FROM commanders WHERE updated_at < ${runStartedAt};\n` +
      `INSERT INTO sync_meta (key, value, updated_at) VALUES ` +
      `('commanders.last_synced_at', '${runStartedAt}', ${runStartedAt}), ` +
      `('commanders.count', '${records.length}', ${runStartedAt}) ` +
      `ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`✅ Synced ${records.length} commanders.`);
