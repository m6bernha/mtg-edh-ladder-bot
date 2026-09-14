import { describe, expect, it } from 'vitest';
import {
  digestMessage,
  helpMessage,
  historyMessage,
  leaderboardMessage,
  metaMessage,
  predictMessage,
  sparkline,
  statsMessage,
  vsMessage,
  withShoutouts,
  type LeaderboardView,
  type StatsView,
} from '../src/discord/boards';
import { LIMITS, countComponents, customIds, totalTextLength, type Component, type Container, type TextDisplay } from '../src/discord/components';
import { withV2 } from '../src/discord/api';
import type { MessageData } from '../src/types';

const texts = (m: MessageData) =>
  (m.components as Container[])
    .flatMap((c) => c.components)
    .flatMap((c) => (c.type === 10 ? [c] : c.type === 9 ? c.components : []))
    .map((t: TextDisplay) => t.content)
    .join('\n');

function withinLimits(m: MessageData) {
  const comps = m.components as Component[];
  expect(comps.length).toBeGreaterThan(0);
  expect(countComponents(comps)).toBeLessThanOrEqual(LIMITS.COMPONENTS_PER_MESSAGE);
  expect(totalTextLength(comps)).toBeLessThanOrEqual(LIMITS.TEXT_DISPLAY_CHARS);
  for (const id of customIds(comps)) expect(id.length).toBeLessThanOrEqual(LIMITS.CUSTOM_ID_CHARS);
  expect(m.content).toBeUndefined();
  expect(m.embeds).toBeUndefined();
  expect(() => withV2(m)).not.toThrow();
}

describe('sparkline', () => {
  it('scales to the block range and flattens a constant series', () => {
    expect(sparkline([1, 8])).toBe('▁█');
    expect(sparkline([5, 5, 5])).toBe('▄▄▄');
    expect(sparkline([])).toBe('');
  });
});

describe('leaderboardMessage', () => {
  const entries = new Array(15).fill(null).map((_, i) => ({
    rank: i + 1,
    previousRank: i === 0 ? 2 : i === 1 ? 1 : i === 2 ? null : i + 1,
    username: `PlayerWithALongName${i}`,
    sr: 900 - i * 20,
    provisional: i > 12,
    wins: 10 - (i % 5),
    losses: i,
    draws: i % 3,
    form: ['W', 'L', 'W', 'D', 'W'],
    lastPlayedAt: 1_700_000_000,
  }));
  const view: LeaderboardView = { entries, page: 2, pages: 3, total: 40 };
  const m = leaderboardMessage(view);

  it('is a fixed-width table with movement arrows, provisional marks and a pager', () => {
    withinLimits(m);
    const t = texts(m);
    expect(t).toContain('```');
    expect(t).toMatch(/ 1▲/);
    expect(t).toMatch(/ 2▼/);
    expect(t).toMatch(/PlayerWithALo\*/); // truncated + provisional (index 13)
    expect(t).toContain('WLWDW');
    expect(customIds(m.components!)).toEqual(['lb:page:1', 'lb:noop:2', 'lb:page:3']);
  });

  it('a single page has no pager', () => {
    const one = leaderboardMessage({ ...view, page: 1, pages: 1, total: 15 });
    expect(customIds(one.components!)).toEqual([]);
  });
});

describe('statsMessage', () => {
  const view: StatsView = {
    username: 'Alice',
    rank: { rank: 3, of: 12 },
    sr: 731,
    mu: 27.2,
    sigma: 2.1,
    wins: 12,
    losses: 20,
    draws: 1,
    games: 33,
    winPct: 36,
    placementCounts: [12, 8, 7, 5],
    avgDuration: 5400,
    streak: 'W2',
    form: ['L', 'W', 'W'],
    srTrendRecent: 44,
    srSeries: [600, 640, 620, 700, 731],
    perBracket: [{ bracket: '3', games: 20, wins: 8 }, { bracket: 'open', games: 13, wins: 4 }],
    nemesis: { username: 'Bob', above: 14, shared: 25 },
    victim: { username: 'Cy', below: 11, shared: 20 },
    mostPlayed: { name: "Atraxa, Praetors' Voice", games: 15, art: 'https://img/a' },
    best: { name: 'Edgar Markov', winPct: 60, games: 5 },
    badges: [{ id: 'first-blood', emoji: '🩸', label: 'First Blood', description: 'Won a pod', earnedAt: 1 }],
  };
  it('renders rank, sparkline, brackets, rivals, badges with the most-played art as a thumbnail', () => {
    const m = statsMessage(view);
    withinLimits(m);
    const t = texts(m);
    expect(t).toContain('#3 of 12');
    expect(t).toContain('`▁▃▂▆█`');
    expect(t).toContain('Bracket 3 8/20');
    expect(t).toContain('Nemesis: **Bob**');
    expect(t).toContain('First Blood');
    const head = (m.components![0] as Container).components[0];
    expect(head.type).toBe(9);
    expect((head as { accessory: { media: { url: string } } }).accessory.media.url).toBe('https://img/a');
  });
  it('without art the header is plain text', () => {
    const m = statsMessage({ ...view, mostPlayed: undefined, badges: [], nemesis: undefined, victim: undefined });
    withinLimits(m);
    expect((m.components![0] as Container).components[0].type).toBe(10);
    expect(texts(m)).toContain('None yet');
  });
});

describe('other readouts', () => {
  it('meta, history, predict, vs, digest, help all stay within limits', () => {
    withinLimits(
      metaMessage({
        rows: new Array(10).fill(null).map((_, i) => ({ commander: `Commander ${i}`, games: 10 - i, wins: 3, draws: 0, avg_placement: 2.4, pilots: 2, colors: 'WUB' })),
        page: 1,
        pages: 2,
        minGames: 3,
      }),
    );
    withinLimits(
      historyMessage({
        rows: new Array(6).fill(null).map((_, i) => ({ game_id: i, started_at: 0, ended_at: 7200, draw: i % 2, winner_only: 0, bracket: 'open', pod_size: 4, winner_name: 'Ann', winner_commander: 'Atraxa' })),
        page: 2,
        pages: 3,
        filter: { userId: '123', username: 'Ann' },
      }),
    );
    const hist = historyMessage({ rows: [], page: 1, pages: 2, filter: { userId: '123', username: 'Ann' } });
    expect(customIds(hist.components!)).toContain('hist:page:2:123');
    withinLimits(
      predictMessage({ entries: [{ username: 'Ann', commander: 'Atraxa', sr: 700, winPct: 0.4, rusted: true }, { username: 'Bob', commander: null, sr: 600, winPct: 0.6, rusted: false }], quality: 0.7, startedAt: 1 }),
    );
    withinLimits(vsMessage({ nameA: 'A', nameB: 'B', shared: 3, aAbove: 2, bAbove: 1, even: 0, aWins: 1, bWins: 0, avgA: 1.5, avgB: 2.5, longest: 7200, fastest: 1800 }));
    withinLimits(
      digestMessage(
        { games: 4, players: 5, mostActive: { username: 'Ann', games: 4 }, biggestClimber: { username: 'Bob', delta: 80 }, commanderOfWeek: { name: 'Atraxa', games: 3, wins: 2 }, top3: [{ username: 'Ann', sr: 800 }], longest: { seconds: 9000, winner: 'Cy' } },
        1,
      ),
    );
    withinLimits(helpMessage());
  });

  it('withShoutouts appends a gold container and leaves a message alone when empty', () => {
    const base: MessageData = { components: [{ type: 17, components: [{ type: 10, content: 'x' }] }] };
    expect(withShoutouts(base, [])).toBe(base);
    const m = withShoutouts(base, ['a', 'b']);
    expect(m.components).toHaveLength(2);
    expect(texts(m)).toContain('📣 a\nb');
  });
});
