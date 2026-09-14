import { describe, expect, it } from 'vitest';
import { RATING } from '../src/ratings/config';
import { reportGame } from '../src/services/report';
import type { Env, GameRow, RosterEntry } from '../src/types';
import { fakeD1, type FakeRoute } from './helpers/fake-d1';

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

const game: GameRow = {
  id: 9,
  guild_id: 'g',
  channel_id: 'c',
  status: 'active',
  bracket: 'open',
  winner_only: 0,
  draw: 0,
  started_at: now - 3600,
  ended_at: null,
  created_by: 'u1',
  reported_by: null,
  message_id: null,
  top_player_id: null,
};
const seat = (player_id: number, discord_user_id: string, username: string, mu = 25, sigma = 2): RosterEntry => ({
  game_id: 9,
  player_id,
  placement: null,
  commander: null,
  commander_image: null,
  mu_before: null,
  mu_after: null,
  sigma_before: null,
  sigma_after: null,
  sigma_rusted: null,
  rust_days: null,
  discord_user_id,
  username,
  ts_mu: mu,
  ts_sigma: sigma,
});
const roster = [seat(1, 'u1', 'Ann', 26, 2), seat(2, 'u2', 'Bob', 25, 2), seat(3, 'u3', 'Cy', 24, 2)];

function setup(extra: FakeRoute[] = []) {
  const db = fakeD1([
    ...extra,
    { match: "status = 'active' LIMIT 1", first: game },
    { match: 'FROM game_players gp JOIN players p', rows: roster },
    { match: 'MAX(g.ended_at)', rows: [{ player_id: 1, last_at: now - DAY }, { player_id: 2, last_at: now - 40 * DAY }] },
    { match: 'COUNT(gp.game_id) AS games', rows: roster.map((r) => ({ playerId: r.player_id, username: r.username, mu: r.ts_mu, sigma: r.ts_sigma, games: 3 })) },
    { match: 'SELECT gp.player_id, g.id AS game_id', rows: [] },
  ]);
  const env = { DB: db, DISCORD_BOT_TOKEN: 't', DISCORD_PUBLIC_KEY: 'k' } as Env;
  return { db, env };
}
const base = { guildId: 'g', channelId: 'c', reporterId: 'u1', reporterPermissions: '0', draw: false, winnerOnly: false };
const full = [{ userId: 'u3', place: 1 }, { userId: 'u1', place: 2 }, { userId: 'u2', place: 3 }];

describe('reportGame', () => {
  it('refuses outsiders and bad placements before touching ratings', async () => {
    const { env } = setup();
    expect(await reportGame(env, { ...base, reporterId: 'nobody', placements: full })).toMatchObject({ ok: false });
    const partial = await reportGame(env, { ...base, placements: full.slice(0, 2) });
    expect(partial).toMatchObject({ ok: false, error: expect.stringContaining('missing') });
  });

  it('applies rust only past the grace window and keeps sigma_before raw for /undo', async () => {
    const { env } = setup();
    const out = await reportGame(env, { ...base, placements: full });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const bob = out.roster.find((r) => r.username === 'Bob')!;
    const ann = out.roster.find((r) => r.username === 'Ann')!;
    expect(bob.sigma_before).toBe(2); // stored value, untouched
    expect(bob.sigma_rusted).toBeGreaterThan(2); // 40 idle days
    expect(bob.rust_days).toBe(40);
    expect(ann.sigma_rusted).toBeNull(); // 1 idle day
    expect(ann.rust_days).toBe(1);
    // Cy (never played) has no rust and is placed first.
    const cy = out.roster.find((r) => r.username === 'Cy')!;
    expect(cy.placement).toBe(1);
    expect(cy.mu_after).toBeGreaterThan(24);
    expect(out.game.status).toBe('completed');
    expect(out.game.top_player_id).toBe(1); // Ann led the pre-game board
  });

  it('emits shoutouts for what changed (climb, upset, first win, rust)', async () => {
    const { env } = setup();
    const out = await reportGame(env, { ...base, placements: full });
    if (!out.ok) throw new Error(out.error);
    expect(out.shoutouts).toEqual([
      '📈 **Cy** climbs a spot to #2',
      expect.stringMatching(/^😱 Upset! \*\*Cy\*\* won at \d+% odds$/),
      '🎉 **Cy** wins their first pod!',
      '🦀 **Bob** was 40 days rusty — rating moves faster until it settles',
    ]);
  });

  it('a draw ties everyone for first', async () => {
    const { env } = setup();
    const out = await reportGame(env, { ...base, draw: true, placements: full });
    if (!out.ok) throw new Error(out.error);
    expect(out.roster.every((r) => r.placement === 1)).toBe(true);
    expect(out.game.draw).toBe(1);
  });

  it('never persists a sigma below the floor', async () => {
    const { env } = setup();
    const out = await reportGame(env, { ...base, placements: full });
    if (!out.ok) throw new Error(out.error);
    for (const r of out.roster) expect(r.sigma_after!).toBeGreaterThanOrEqual(RATING.SIGMA_MIN);
  });
});

describe('reportGame — derived facts from history', () => {
  const hist = (player_id: number, results: ('W' | 'L' | 'D')[]) =>
    // newest first, as getGamesForPlayers returns
    results.map((r, i) => ({
      player_id,
      game_id: 100 - i,
      started_at: 0,
      ended_at: 1000 - i,
      draw: r === 'D' ? 1 : 0,
      winner_only: 0,
      bracket: 'open',
      placement: r === 'W' ? 1 : 2,
      commander: null,
      mu_before: 25,
      mu_after: 25,
      sigma_before: 2,
      sigma_after: 2,
      top_player_id: null,
    }));

  it('reads streaks newest-first: W,W,L → win streak 2; L,L,L,W → loss streak 3', async () => {
    const { env } = setup([{ match: 'SELECT gp.player_id, g.id AS game_id', rows: [...hist(3, ['W', 'W', 'L']), ...hist(2, ['L', 'L', 'L', 'W'])] }]);
    const out = await reportGame(env, { ...base, placements: [{ userId: 'u3', place: 1 }, { userId: 'u2', place: 2 }, { userId: 'u1', place: 3 }] });
    if (!out.ok) throw new Error(out.error);
    expect(out.shoutouts).toContain('🔥 **Cy** is on a 3-game win streak');
    expect(out.shoutouts.some((s) => s.includes('first pod'))).toBe(false);
  });

  it('a winner coming off three losses snaps a skid', async () => {
    const { env } = setup([{ match: 'SELECT gp.player_id, g.id AS game_id', rows: hist(3, ['L', 'L', 'L', 'W']) }]);
    const out = await reportGame(env, { ...base, placements: full });
    if (!out.ok) throw new Error(out.error);
    expect(out.shoutouts).toContain('💪 **Cy** snaps a 3-game skid');
  });
});
