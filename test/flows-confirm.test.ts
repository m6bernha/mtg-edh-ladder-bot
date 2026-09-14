import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLeaderboardView } from '../src/commands/boards';
import { updateLiveCard } from '../src/discord/live-card';
import { routeComponent } from '../src/router';
import type { Env, GameRow, Interaction, RosterEntry } from '../src/types';
import { fakeD1, type FakeRoute } from './helpers/fake-d1';

const now = Math.floor(Date.now() / 1000);
const game: GameRow = {
  id: 7,
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
  message_id: 'm1',
  top_player_id: null,
};
const seat = (player_id: number, name: string): RosterEntry => ({
  game_id: 7,
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
  discord_user_id: `u${player_id}`,
  username: name,
  ts_mu: 25,
  ts_sigma: 2,
});
const roster = [seat(1, 'Ann'), seat(2, 'Bob'), seat(3, 'Cy')];

function env(extra: FakeRoute[] = [], opts: { batchChanges?: number } = {}) {
  const db = fakeD1(
    [
      ...extra,
      { match: "status = 'active' LIMIT 1", first: game },
      { match: 'FROM game_players gp JOIN players p', rows: roster },
      { match: 'MAX(g.ended_at)', rows: [] },
      { match: 'COUNT(gp.game_id) AS games', rows: roster.map((r) => ({ playerId: r.player_id, username: r.username, mu: 25, sigma: 2, games: 2 })) },
      { match: 'SELECT gp.player_id, g.id AS game_id', rows: [] },
    ],
    opts,
  );
  return { db, env: { DB: db, DISCORD_BOT_TOKEN: 't', DISCORD_PUBLIC_KEY: 'k' } as Env };
}
const click = (custom_id: string, userId = 'u1', extra: Partial<Interaction['data']> = {}): Interaction => ({
  type: 3,
  id: 'i',
  token: 'tok',
  application_id: 'app',
  guild_id: 'g',
  channel_id: 'c',
  member: { user: { id: userId, username: 'x' }, permissions: '0' },
  message: { id: 'm1' },
  data: { name: '', custom_id, component_type: 2, ...extra },
});
const ctx = () => {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext, waits };
};
const body = async (r: Response) => (await r.json()) as { type: number; data?: Record<string, unknown> };
const calls = () => fetchSpy.mock.calls.map((c) => ({ url: String(c[0]), body: JSON.parse(((c[1] as { body?: string })?.body ?? '{}') as string) as Record<string, unknown> }));

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(() => Promise.resolve(new Response('{"id":"m1"}', { status: 200 })));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe('rep:confirm', () => {
  it('writes the report, edits the card, posts PUBLIC shoutouts, confirms privately', async () => {
    const { db, env: e } = env();
    const c = ctx();
    const b = await body(await routeComponent(click('rep:confirm:7:f:2-0'), e, c.ctx));
    expect(b.type).toBe(6);
    await Promise.all(c.waits);
    // completeGame ran with Cy 1st, Ann 2nd, Bob 3rd (implied)
    expect(db.log.some((s) => s.includes("UPDATE games SET status = 'completed'"))).toBe(true);
    const sent = calls();
    const edit = sent.find((x) => x.url.includes('/channels/c/messages/m1'));
    expect(edit).toBeDefined();
    expect((edit!.body.flags as number) & (1 << 15)).toBe(1 << 15);
    const follow = sent.find((x) => x.url.endsWith('/webhooks/app/tok'));
    expect(follow).toBeDefined();
    expect(((follow!.body.flags as number) ?? 0) & 64).toBe(0); // public
    expect(JSON.stringify(follow!.body)).toContain('📣');
    const note = sent.find((x) => x.url.includes('@original'));
    expect(JSON.stringify(note!.body)).toContain('Reported');
  });

  it('a lost race (someone reported first) writes nothing and says so', async () => {
    const { env: e } = env([], { batchChanges: 0 });
    const c = ctx();
    await routeComponent(click('rep:confirm:7:f:2-0'), e, c.ctx);
    await Promise.all(c.waits);
    const sent = calls();
    expect(sent.some((x) => x.url.includes('/channels/c/messages/m1'))).toBe(false);
    expect(sent.some((x) => x.url.endsWith('/webhooks/app/tok'))).toBe(false);
    const note = sent.find((x) => x.url.includes('@original'));
    expect(JSON.stringify(note!.body)).toContain('already reported');
  });

  it('an incomplete draft on confirm re-renders the step instead of reporting', async () => {
    const { db, env: e } = env();
    const b = await body(await routeComponent(click('rep:confirm:7:f:-'), e, ctx().ctx));
    expect(b.type).toBe(7);
    expect(db.log.some((s) => s.includes("SET status = 'completed'"))).toBe(false);
  });
});

describe('rep:mode / rep:back / sanitize', () => {
  it('switching mode resets the picks; undo pops the last', async () => {
    const { env: e } = env();
    const mode = await body(await routeComponent(click('rep:mode:7:w'), e, ctx().ctx));
    expect(JSON.stringify(mode.data)).toContain('rep:pick:7:w:-');
    const back = await body(await routeComponent(click('rep:back:7:f:2-0'), e, ctx().ctx));
    expect(JSON.stringify(back.data)).toContain('rep:pick:7:f:2');
    expect(JSON.stringify(back.data)).not.toContain('rep:pick:7:f:2-0');
  });
  it('out-of-range and duplicate indices in an id are dropped, not crashed on', async () => {
    const { env: e } = env();
    const b = await body(await routeComponent(click('rep:back:7:f:9-9-1-1'), e, ctx().ctx));
    expect(b.type).toBe(7);
    expect(JSON.stringify(b.data)).toContain('rep:pick:7:f:-'); // [1] then pop → []
  });
});

describe("cmd:open on another player's seat", () => {
  it('is refused by name', async () => {
    const { env: e } = env();
    const b = await body(await routeComponent(click('cmd:open:7:1', 'u1'), e, ctx().ctx));
    expect(JSON.stringify(b.data)).toContain("**Bob**'s seat");
  });
  it('own seat proceeds to the modal', async () => {
    const { env: e } = env([{ match: 'GROUP BY gp.commander', rows: [] }]);
    const b = await body(await routeComponent(click('cmd:open:7:0', 'u1'), e, ctx().ctx));
    expect(b.type).toBe(9);
  });
});

describe('leaderboard movement arrows', () => {
  it('shows an overtake inside the pod exactly', async () => {
    // Before the game: Bob 520 led Ann 500. Ann won: Ann 530, Bob 495.
    const rows = [
      { id: 1, guild_id: 'g', discord_user_id: 'u1', username: 'Ann', ts_mu: 25.75, ts_sigma: 2, games: 5, wins: 3, draws: 0, last_played_at: now },
      { id: 2, guild_id: 'g', discord_user_id: 'u2', username: 'Bob', ts_mu: 24.875, ts_sigma: 2, games: 5, wins: 2, draws: 0, last_played_at: now },
    ];
    const db = fakeD1([
      { match: 'COUNT(DISTINCT p.id)', first: { n: 2 } },
      { match: 'ORDER BY (p.ts_mu - 3 * p.ts_sigma) DESC', rows },
      {
        match: 'ROW_NUMBER()',
        rows: [
          { player_id: 1, game_id: 9, rn: 1, placement: 1, draw: 0, mu_before: 25, sigma_before: 2 },
          { player_id: 2, game_id: 9, rn: 1, placement: 2, draw: 0, mu_before: 25.5, sigma_before: 2 },
        ],
      },
      { match: 'COUNT(gp.game_id) AS games', rows: rows.map((r) => ({ playerId: r.id, username: r.username, mu: r.ts_mu, sigma: r.ts_sigma, games: 5 })) },
    ]);
    const view = await loadLeaderboardView(db, 'g', 1);
    expect(view.entries.map((e) => [e.username, e.rank, e.previousRank])).toEqual([
      ['Ann', 1, 2],
      ['Bob', 2, 1],
    ]);
  });
});

describe('updateLiveCard across the V2 switch', () => {
  it('a 400 on editing a pre-V2 card reposts a flagged card without re-pinging and relinks it', async () => {
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('/messages/m1')
          ? new Response('{"message":"Cannot edit","code":50006}', { status: 400 })
          : new Response('{"id":"m2"}', { status: 200 }),
      ),
    );
    const db = fakeD1([
      { match: 'FROM game_players gp JOIN players p', rows: roster },
      { match: 'UPDATE games SET message_id', rows: [] },
    ]);
    const r = await updateLiveCard({ DB: db, DISCORD_BOT_TOKEN: 't', DISCORD_PUBLIC_KEY: 'k' } as Env, game);
    expect(r.ok).toBe(true);
    const post = calls().find((x) => x.url.endsWith('/channels/c/messages'));
    expect(post).toBeDefined();
    expect((post!.body.flags as number) & (1 << 15)).toBe(1 << 15);
    expect(post!.body.allowed_mentions).toEqual({ parse: [] });
    expect(db.log.some((s) => s.includes('UPDATE games SET message_id'))).toBe(true);
  });
});
