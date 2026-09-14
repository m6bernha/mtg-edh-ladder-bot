import { describe, expect, it } from 'vitest';
import type { DigestSeatRow, PlayerGameRow, PodSnapshotRow } from '../src/db/queries';
import { computeBadges } from '../src/engagement/achievements';
import { buildDigest } from '../src/engagement/digest';
import { MAX_SHOUTOUTS, buildShoutouts, type PodFact, type RankedEntry } from '../src/engagement/shoutouts';

// ---------------------------------------------------------------- shoutouts

const board = (...names: [string, number][]): RankedEntry[] =>
  names.map(([username, sr], i) => ({ playerId: i + 1, username, sr }));

const fact = (over: Partial<PodFact> & { playerId: number; username: string; placement: number }): PodFact => ({
  srBefore: 600,
  srAfter: 620,
  gamesBefore: 5,
  personalBestBefore: 650,
  winStreakBefore: 0,
  lossStreakBefore: 0,
  hasWonBefore: true,
  preGameWinPct: 0.25,
  rustDays: null,
  ...over,
});

describe('buildShoutouts', () => {
  const quiet = {
    before: board(['Ann', 700], ['Bob', 650], ['Cy', 600], ['Dee', 550]),
    after: board(['Ann', 710], ['Bob', 640], ['Cy', 600], ['Dee', 550]),
    draw: false,
  };
  const pod = (winnerId: number) =>
    [1, 2, 3, 4].map((id) =>
      fact({ playerId: id, username: ['Ann', 'Bob', 'Cy', 'Dee'][id - 1], placement: id === winnerId ? 1 : 2 }),
    );

  it('says nothing when the ladder order is unchanged and nothing notable happened', () => {
    expect(buildShoutouts({ ...quiet, pod: pod(1) })).toEqual([]);
  });

  it('announces a new #1 and rank climbs', () => {
    const after = board(['Bob', 720], ['Ann', 700], ['Dee', 610], ['Cy', 600]);
    // playerIds must match the "before" board: rebuild with explicit ids.
    after[0].playerId = 2;
    after[1].playerId = 1;
    after[2].playerId = 4;
    after[3].playerId = 3;
    const out = buildShoutouts({ before: quiet.before, after, pod: pod(2), draw: false });
    expect(out[0]).toContain('**Bob** takes #1');
    expect(out.some((l) => l.includes('**Dee** climbs a spot to #3'))).toBe(true);
  });

  it('win streak from exactly 3', () => {
    const p = pod(1);
    p[0].winStreakBefore = 2;
    expect(buildShoutouts({ ...quiet, pod: p }).some((l) => l.includes('3-game win streak'))).toBe(true);
    p[0].winStreakBefore = 1;
    expect(buildShoutouts({ ...quiet, pod: p }).some((l) => l.includes('win streak'))).toBe(false);
  });

  it('upset only when the winner held the lowest odds under the threshold', () => {
    const p = pod(4);
    p[0].preGameWinPct = 0.5;
    p[1].preGameWinPct = 0.2;
    p[2].preGameWinPct = 0.2;
    p[3].preGameWinPct = 0.1;
    expect(buildShoutouts({ ...quiet, pod: p }).some((l) => l.startsWith('😱 Upset'))).toBe(true);
    p[3].preGameWinPct = 0.3; // not the lowest any more
    expect(buildShoutouts({ ...quiet, pod: p }).some((l) => l.startsWith('😱'))).toBe(false);
  });

  it('personal best, first win, milestone, rust, skid', () => {
    const p = pod(1);
    p[0].srAfter = 700;
    p[0].personalBestBefore = 690;
    p[0].hasWonBefore = false;
    p[1].gamesBefore = 9;
    p[2].rustDays = 20;
    p[0].lossStreakBefore = 3;
    const out = buildShoutouts({ ...quiet, pod: p });
    expect(out).toEqual([
      '💪 **Ann** snaps a 3-game skid',
      '🏅 **Ann** hits a personal-best SR of 700',
      '🎉 **Ann** wins their first pod!',
      '🎲 **Bob** plays game #10',
      '🦀 **Cy** was 20 days rusty — rating moves faster until it settles',
    ]);
  });

  it('caps the block', () => {
    const p = pod(1);
    for (const f of p) {
      f.gamesBefore = 24;
      f.rustDays = 30;
      f.srAfter = 900;
    }
    expect(buildShoutouts({ ...quiet, pod: p })).toHaveLength(MAX_SHOUTOUTS);
  });

  it('a draw has no winner-based lines', () => {
    const p = pod(1).map((f) => ({ ...f, placement: 1, winStreakBefore: 5, hasWonBefore: false }));
    const out = buildShoutouts({ ...quiet, pod: p, draw: true });
    expect(out.some((l) => l.includes('streak') || l.includes('first pod'))).toBe(false);
  });
});

// ------------------------------------------------------------- achievements

let nextId = 1;
const game = (over: Partial<PlayerGameRow> & { placement: number }): PlayerGameRow => {
  const id = nextId++;
  return {
    game_id: id,
    started_at: id * 10_000,
    ended_at: id * 10_000 + 3600,
    draw: 0,
    winner_only: 0,
    bracket: 'open',
    commander: null,
    mu_before: 25,
    mu_after: 25,
    sigma_before: 2,
    sigma_after: 2,
    top_player_id: null,
    ...over,
  };
};
const newestFirst = (games: PlayerGameRow[]) => [...games].reverse();
const ids = (badges: { id: string }[]) => badges.map((b) => b.id);
const ME = 1;

describe('computeBadges', () => {
  it('nothing for a winless history', () => {
    const g = [game({ placement: 2 }), game({ placement: 3 })];
    expect(computeBadges(newestFirst(g), new Map(), new Map(), ME)).toEqual([]);
  });

  it('first blood, hat trick, comeback', () => {
    const g = [
      game({ placement: 2 }), game({ placement: 3 }), game({ placement: 4 }),
      game({ placement: 1 }), game({ placement: 1 }), game({ placement: 1 }),
    ];
    const b = ids(computeBadges(newestFirst(g), new Map(), new Map(), ME));
    expect(b).toEqual(['first-blood', 'comeback', 'hat-trick']);
  });

  it('a draw breaks a streak without counting as a loss', () => {
    const g = [game({ placement: 1 }), game({ placement: 1 }), game({ placement: 1, draw: 1 }), game({ placement: 1 })];
    expect(ids(computeBadges(newestFirst(g), new Map(), new Map(), ME))).not.toContain('hat-trick');
  });

  it('iron pilot, loyalist, mainstay', () => {
    const g: PlayerGameRow[] = [];
    for (let i = 0; i < 25; i++) g.push(game({ placement: i % 2 === 0 ? 1 : 2, commander: i < 12 ? 'Atraxa' : 'Edgar' }));
    const b = ids(computeBadges(newestFirst(g), new Map(), new Map(), ME));
    expect(b).toContain('iron-pilot');
    expect(b).toContain('loyalist');
    expect(b).toContain('mainstay');
  });

  it('marathon and blitz depend on the length of a WON game', () => {
    const g = [
      game({ placement: 2, started_at: 0, ended_at: 4 * 3600 }),
      game({ placement: 1, started_at: 100_000, ended_at: 100_000 + 4 * 3600 }),
      game({ placement: 1, started_at: 200_000, ended_at: 200_000 + 600 }),
    ];
    const b = ids(computeBadges(newestFirst(g), new Map(), new Map(), ME));
    expect(b).toContain('marathon');
    expect(b).toContain('blitz');
  });

  it('giant killer: won as the lowest conservative rating in a 3+ pod', () => {
    const g = [game({ placement: 1 })];
    const pod: PodSnapshotRow[] = [
      { game_id: g[0].game_id, player_id: ME, placement: 1, mu_before: 22, sigma_before: 2, sigma_rusted: null },
      { game_id: g[0].game_id, player_id: 2, placement: 2, mu_before: 28, sigma_before: 2, sigma_rusted: null },
      { game_id: g[0].game_id, player_id: 3, placement: 3, mu_before: 25, sigma_before: 2, sigma_rusted: null },
    ];
    const pods = new Map([[g[0].game_id, pod]]);
    expect(ids(computeBadges(g, pods, new Map(), ME))).toContain('giant-killer');
    pod[1].mu_before = 20; // no longer the lowest
    expect(ids(computeBadges(g, pods, new Map(), ME))).not.toContain('giant-killer');
  });

  it('kingslayer needs a recorded #1 who sat in the pod and was not you', () => {
    const g = [game({ placement: 1 })];
    const pod: PodSnapshotRow[] = [
      { game_id: g[0].game_id, player_id: ME, placement: 1, mu_before: 25, sigma_before: 2, sigma_rusted: null },
      { game_id: g[0].game_id, player_id: 2, placement: 2, mu_before: 25, sigma_before: 2, sigma_rusted: null },
    ];
    const pods = new Map([[g[0].game_id, pod]]);
    expect(ids(computeBadges(g, pods, new Map([[g[0].game_id, 2]]), ME))).toContain('kingslayer');
    expect(ids(computeBadges(g, pods, new Map([[g[0].game_id, null]]), ME))).not.toContain('kingslayer');
    expect(ids(computeBadges(g, pods, new Map([[g[0].game_id, ME]]), ME))).not.toContain('kingslayer');
    expect(ids(computeBadges(g, pods, new Map([[g[0].game_id, 99]]), ME))).not.toContain('kingslayer');
  });

  it('badges are ordered by when they were earned and never duplicated', () => {
    const g = [game({ placement: 1 }), game({ placement: 1 }), game({ placement: 1 }), game({ placement: 1 })];
    const b = computeBadges(newestFirst(g), new Map(), new Map(), ME);
    expect(ids(b)).toEqual(['first-blood', 'hat-trick']);
    expect(b[0].earnedAt).toBeLessThan(b[1].earnedAt);
  });
});

// ------------------------------------------------------------------ digest

const seat = (over: Partial<DigestSeatRow>): DigestSeatRow => ({
  game_id: 1,
  started_at: 0,
  ended_at: 3600,
  draw: 0,
  player_id: 1,
  username: 'Ann',
  placement: 1,
  commander: null,
  mu_before: 25,
  sigma_before: 2,
  mu_after: 25,
  sigma_after: 2,
  ...over,
});

describe('buildDigest', () => {
  it('returns null for an empty week', () => {
    expect(buildDigest([], [])).toBeNull();
  });

  it('derives every headline from the seats', () => {
    const seats = [
      seat({ game_id: 1, player_id: 1, username: 'Ann', placement: 1, commander: 'Atraxa', mu_after: 27 }),
      seat({ game_id: 1, player_id: 2, username: 'Bob', placement: 2, commander: 'Edgar', mu_after: 24 }),
      seat({ game_id: 2, player_id: 1, username: 'Ann', placement: 2, commander: 'Atraxa', mu_after: 24.5, started_at: 5000, ended_at: 5000 + 7200 }),
      seat({ game_id: 2, player_id: 3, username: 'Cy', placement: 1, commander: 'Edgar', mu_after: 26, started_at: 5000, ended_at: 5000 + 7200 }),
    ];
    const v = buildDigest(seats, [{ username: 'Ann', sr: 700 }, { username: 'Cy', sr: 650 }, { username: 'Bob', sr: 600 }, { username: 'Dee', sr: 500 }]);
    expect(v).toMatchObject({
      games: 2,
      players: 3,
      mostActive: { username: 'Ann', games: 2 },
      biggestClimber: { username: 'Ann', delta: 60 }, // +80 then −20
      commanderOfWeek: { name: 'Atraxa', games: 2, wins: 1 },
      longest: { seconds: 7200, winner: 'Cy' },
    });
    expect(v!.top3.map((t) => t.username)).toEqual(['Ann', 'Cy', 'Bob']);
  });

  it('no climber when nobody gained', () => {
    const v = buildDigest([seat({ mu_after: 24 })], []);
    expect(v!.biggestClimber).toBeNull();
  });
});
