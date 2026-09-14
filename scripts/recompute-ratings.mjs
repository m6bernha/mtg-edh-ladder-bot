// Replay every completed game, in order, through the current rating engine
// (src/ratings/*.ts — the exact code the Worker runs) and rewrite the stored
// snapshots and current ratings to match. Run this after changing anything in
// src/ratings/config.ts so history adopts the new dynamics instead of only
// future games.
//
//   npm run recompute-ratings              → dry run: prints the per-player diff, writes nothing
//   npm run recompute-ratings -- --apply   → takes a D1 export into backups/, then writes
//   add --local to target the wrangler dev D1
//
// Refuses to run while any game is active (a mid-flight game would be rated
// against pre-replay numbers). The result is a pure function of the game
// history and the constants, so a half-finished run is repaired by re-running.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RATING } from '../src/ratings/config.ts';
import { applyRust } from '../src/ratings/rust.ts';
import { computeTrueSkill, skillRating } from '../src/ratings/trueskill.ts';

const DB_NAME = 'edh-ladder';
const NL = String.fromCharCode(10);
const args = new Set(process.argv.slice(2));
const target = args.has('--local') ? '--local' : '--remote';
const apply = args.has('--apply');

const dir = mkdtempSync(join(tmpdir(), 'edh-recompute-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
function d1(sql) {
  const file = join(dir, `q-${++fileNo}.sql`);
  writeFileSync(file, sql + NL);
  const out = execSync(`npx wrangler d1 execute ${DB_NAME} ${target} --json --file "${file}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

// ---- Read ----
const active = d1("SELECT COUNT(*) AS n FROM games WHERE status = 'active'")[0].n;
if (active > 0) {
  console.error(`${active} game(s) are active — finish or cancel them first, then re-run.`);
  process.exit(1);
}
const games = d1(
  "SELECT id, ended_at, draw, winner_only FROM games WHERE status = 'completed' ORDER BY ended_at, id",
);
const seats = d1(
  `SELECT gp.game_id, gp.player_id, gp.placement, gp.mu_after, gp.sigma_after, p.username, p.guild_id
   FROM game_players gp JOIN players p ON p.id = gp.player_id
   JOIN games g ON g.id = gp.game_id WHERE g.status = 'completed'`,
);
const players = d1('SELECT id, username, ts_mu, ts_sigma FROM players');
console.log(`Replaying ${games.length} completed games, ${seats.length} seats, ${players.length} players (${target})${apply ? '' : ' [dry run]'}`);

// ---- Replay ----
const seatsByGame = new Map();
for (const s of seats) {
  const list = seatsByGame.get(s.game_id) ?? [];
  list.push(s);
  seatsByGame.set(s.game_id, list);
}
const state = new Map(); // playerId → { mu, sigma, lastPlayedAt, username }
const rating = (id, username) => {
  let r = state.get(id);
  if (!r) {
    r = { mu: RATING.MU0, sigma: RATING.SIGMA0, lastPlayedAt: null, username };
    state.set(id, r);
  }
  return r;
};
const seatUpdates = []; // { gameId, playerId, values }
const gameUpdates = []; // { gameId, topPlayerId }
let changedSeats = 0;

for (const g of games) {
  const pod = seatsByGame.get(g.id) ?? [];
  if (pod.length === 0) continue;
  // Top player before this game: highest conservative estimate among rated players.
  let top = null;
  for (const [id, r] of state) {
    const sr = skillRating(r.mu, r.sigma);
    if (top === null || sr > top.sr || (sr === top.sr && r.username.localeCompare(top.username) < 0)) top = { id, sr, username: r.username };
  }
  const ordered = [...pod].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99) || a.player_id - b.player_id);
  const before = ordered.map((s) => rating(s.player_id, s.username));
  const rust = before.map((r) => applyRust(r.sigma, r.lastPlayedAt, g.ended_at));
  const places = ordered.map((_, i) => i + 1);
  const out = computeTrueSkill(
    before.map((r, i) => ({ mu: r.mu, sigma: rust[i].sigma })),
    places,
    { draw: g.draw === 1, winnerOnly: g.winner_only === 1 },
  );
  ordered.forEach((s, i) => {
    const r = before[i];
    const values = {
      placement: g.draw ? 1 : i + 1,
      mu_before: r.mu,
      sigma_before: r.sigma,
      sigma_rusted: rust[i].rusted ? rust[i].sigma : null,
      rust_days: rust[i].daysIdle,
      mu_after: out[i].mu,
      sigma_after: out[i].sigma,
    };
    if (Math.abs((s.mu_after ?? NaN) - values.mu_after) > 1e-9 || Math.abs((s.sigma_after ?? NaN) - values.sigma_after) > 1e-9) changedSeats++;
    seatUpdates.push({ gameId: g.id, playerId: s.player_id, values });
    r.mu = out[i].mu;
    r.sigma = out[i].sigma;
    r.lastPlayedAt = g.ended_at;
  });
  gameUpdates.push({ gameId: g.id, topPlayerId: top?.id ?? null });
}

// ---- Diff ----
console.log(`${NL}${'Player'.padEnd(22)} ${'SR now'.padStart(7)} ${'SR new'.padStart(7)} ${'Δ'.padStart(6)}   σ now → new`);
const rows = [];
for (const p of players) {
  const r = state.get(p.id);
  if (!r) continue;
  const srNow = skillRating(p.ts_mu, p.ts_sigma);
  const srNew = skillRating(r.mu, r.sigma);
  rows.push({ p, r, srNow, srNew });
}
rows.sort((a, b) => b.srNew - a.srNew);
for (const { p, r, srNow, srNew } of rows) {
  const d = srNew - srNow;
  console.log(
    `${p.username.slice(0, 22).padEnd(22)} ${String(srNow).padStart(7)} ${String(srNew).padStart(7)} ${(d >= 0 ? '+' : '') + d}`.padEnd(48) +
      `${p.ts_sigma.toFixed(2)} → ${r.sigma.toFixed(2)}`,
  );
}
console.log(`${NL}${changedSeats}/${seatUpdates.length} snapshot rows change.`);
if (!apply) {
  console.log('Dry run — re-run with --apply to write.');
  process.exit(0);
}

// ---- Backup, then write ----
mkdirSync('backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join('backups', `pre-recompute-${stamp}.sql`);
execSync(`npx wrangler d1 export ${DB_NAME} ${target} --output "${backup}"`, { stdio: 'inherit' });
if (!existsSync(backup)) {
  console.error('Backup did not land; refusing to write.');
  process.exit(1);
}
console.log(`Backup at ${backup}`);

const n = (v) => (v === null ? 'NULL' : String(v));
const stmts = [];
for (const u of seatUpdates) {
  const v = u.values;
  stmts.push(
    `UPDATE game_players SET placement = ${v.placement}, mu_before = ${n(v.mu_before)}, sigma_before = ${n(v.sigma_before)}, ` +
      `sigma_rusted = ${n(v.sigma_rusted)}, rust_days = ${n(v.rust_days)}, mu_after = ${n(v.mu_after)}, sigma_after = ${n(v.sigma_after)} ` +
      `WHERE game_id = ${u.gameId} AND player_id = ${u.playerId};`,
  );
}
for (const u of gameUpdates) stmts.push(`UPDATE games SET top_player_id = ${n(u.topPlayerId)} WHERE id = ${u.gameId};`);
for (const [id, r] of state) stmts.push(`UPDATE players SET ts_mu = ${r.mu}, ts_sigma = ${r.sigma} WHERE id = ${id};`);
for (let i = 0; i < stmts.length; i += 400) {
  process.stdout.write(`  writing statements ${i + 1}–${Math.min(i + 400, stmts.length)} of ${stmts.length}…${NL}`);
  d1(stmts.slice(i, i + 400).join(NL));
}
console.log('✅ Ratings recomputed.');
