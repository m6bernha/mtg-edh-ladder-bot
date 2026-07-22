import { describe, expect, it } from 'vitest';
import { matchState, renderMatchCard } from '../src/discord/card';
import { COLORS } from '../src/discord/embeds';
import type { GameRow, RosterEntry } from '../src/types';

function game(overrides: Partial<GameRow> = {}): GameRow {
  return {
    id: 1,
    guild_id: 'g',
    channel_id: 'c',
    status: 'active',
    bracket: 'open',
    winner_only: 0,
    draw: 0,
    started_at: 1000,
    ended_at: null,
    created_by: 'u1',
    reported_by: null,
    message_id: null,
    ...overrides,
  };
}

function player(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    game_id: 1,
    player_id: 1,
    placement: null,
    commander: null,
    commander_image: null,
    mu_before: null,
    mu_after: null,
    sigma_before: null,
    sigma_after: null,
    discord_user_id: 'd1',
    username: 'Alice',
    ts_mu: 25,
    ts_sigma: 25 / 3,
    ...overrides,
  };
}

/** A reported roster entry — carries per-game snapshots so the card reads it as final. */
function reported(placement: number, muAfter: number, overrides: Partial<RosterEntry> = {}) {
  return player({
    placement,
    mu_before: 25,
    sigma_before: 8.33,
    mu_after: muAfter,
    sigma_after: 7.9,
    ...overrides,
  });
}

const embedCount = (n: number) => new Array(n);

describe('renderMatchCard — active phase', () => {
  const s = matchState(game(), [
    player({ player_id: 1, discord_user_id: 'd1', username: 'Alice' }),
    player({ player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
  ]);
  const card = renderMatchCard(s);

  it('is a header embed plus one per player', () => {
    expect(card.embeds).toHaveLength(3);
  });

  it('pings the pod in content and allowed_mentions', () => {
    expect(card.content).toContain('<@d1>');
    expect(card.content).toContain('<@d2>');
    expect(card.allowed_mentions).toEqual({ users: ['d1', 'd2'] });
  });

  it('uses the in-progress title and brand colour with a live relative timer', () => {
    expect(card.embeds![0].title).toMatch(/in progress/i);
    expect(card.embeds![0].color).toBe(COLORS.brand);
    const started = card.embeds![0].fields!.find((f) => f.value.includes('<t:1000:R>'));
    expect(started).toBeDefined();
  });

  it('prompts for a commander when none is logged, and shows no thumbnail', () => {
    expect(card.embeds![1].description).toMatch(/commander/i);
    expect(card.embeds![1].thumbnail).toBeUndefined();
  });
});

describe('renderMatchCard — commander artwork', () => {
  it('renders a thumbnail only for players who logged art', () => {
    const s = matchState(game(), [
      player({ player_id: 1, discord_user_id: 'd1', username: 'Alice', commander: 'Atraxa', commander_image: 'https://img/a' }),
      player({ player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    ]);
    const card = renderMatchCard(s);
    expect(card.embeds![1].thumbnail).toEqual({ url: 'https://img/a' });
    expect(card.embeds![1].description).toContain('Atraxa');
    expect(card.embeds![2].thumbnail).toBeUndefined();
  });
});

describe('renderMatchCard — completed phase', () => {
  const roster = [
    // Deliberately out of finish order to prove the card sorts.
    reported(2, 24, { player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    reported(1, 27, { player_id: 1, discord_user_id: 'd1', username: 'Alice', commander: 'Atraxa', commander_image: 'https://img/a' }),
  ];
  const card = renderMatchCard(matchState(game({ status: 'completed', ended_at: 5000 }), roster));

  it('titles the winner and turns gold, with no pings', () => {
    expect(card.embeds![0].title).toContain('Alice');
    expect(card.embeds![0].color).toBe(COLORS.gold);
    expect(card.content).toBeUndefined();
  });

  it('orders players by finish', () => {
    expect(card.embeds![1].author!.name).toContain('Alice');
    expect(card.embeds![2].author!.name).toContain('Bob');
  });

  it('shows final SR with a signed delta', () => {
    // Alice climbed (mu 25→27), so a positive delta.
    expect(card.embeds![1].description).toMatch(/SR \*\*\d+\*\* \(\+\d+\)/);
  });

  it('reports match length instead of a live timer', () => {
    const len = card.embeds![0].fields!.find((f) => f.name === 'Length');
    expect(len).toBeDefined();
    expect(card.embeds![0].fields!.some((f) => f.value.includes(':R>'))).toBe(false);
  });
});

describe('renderMatchCard — special results', () => {
  it('draw: every player gets the handshake medal', () => {
    const roster = [
      reported(1, 25, { player_id: 1, discord_user_id: 'd1', username: 'Alice' }),
      reported(1, 25, { player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    ];
    const card = renderMatchCard(matchState(game({ status: 'completed', draw: 1, ended_at: 5000 }), roster));
    expect(card.embeds![0].title).toMatch(/draw/i);
    expect(card.embeds![1].author!.name).toContain('🤝');
    expect(card.embeds![2].author!.name).toContain('🤝');
  });

  it('winner-only: header carries a scoring note', () => {
    const roster = [
      reported(1, 27, { player_id: 1, discord_user_id: 'd1', username: 'Alice' }),
      reported(2, 24, { player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    ];
    const card = renderMatchCard(matchState(game({ status: 'completed', winner_only: 1, ended_at: 5000 }), roster));
    const scoring = card.embeds![0].fields!.find((f) => f.name === 'Scoring');
    expect(scoring?.value).toBe('Winner-only');
  });
});

describe('renderMatchCard — cancelled phase', () => {
  it('is a single header embed, error colour, no pings', () => {
    const card = renderMatchCard(
      matchState(game({ status: 'cancelled', ended_at: 5000 }), [player(), player({ player_id: 2 })]),
    );
    expect(card.embeds).toHaveLength(1);
    expect(card.embeds![0].color).toBe(COLORS.error);
    expect(card.content).toBeUndefined();
  });
});

describe('renderMatchCard — pod sizes', () => {
  for (const n of [2, 6]) {
    it(`${n}-player pod stays within Discord's 10-embed limit`, () => {
      const roster = embedCount(n)
        .fill(null)
        .map((_, i) => player({ player_id: i + 1, discord_user_id: `d${i + 1}`, username: `P${i + 1}` }));
      const card = renderMatchCard(matchState(game(), roster));
      expect(card.embeds).toHaveLength(n + 1); // header + one per player
      expect(card.embeds!.length).toBeLessThanOrEqual(10);
    });
  }
});
