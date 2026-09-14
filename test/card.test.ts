import { describe, expect, it } from 'vitest';
import { matchState, renderMatchCard } from '../src/discord/card';
import {
  LIMITS,
  countComponents,
  customIds,
  totalTextLength,
  type Component,
  type Container,
  type Section,
  type TextDisplay,
} from '../src/discord/components';
import { COLORS } from '../src/discord/embeds';
import type { GameRow, RosterEntry } from '../src/types';

function game(overrides: Partial<GameRow> = {}): GameRow {
  return {
    id: 42,
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
    top_player_id: null,
    ...overrides,
  };
}

function player(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    game_id: 42,
    player_id: 1,
    placement: null,
    commander: null,
    commander_image: null,
    mu_before: null,
    mu_after: null,
    sigma_before: null,
    sigma_after: null,
    sigma_rusted: null,
    rust_days: null,
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

const root = (m: { components?: Component[] }) => m.components![0] as Container;
const children = (m: { components?: Component[] }) => root(m).components;
const allText = (m: { components?: Component[] }) =>
  children(m)
    .flatMap((c) => (c.type === 10 ? [c] : c.type === 9 ? c.components : []))
    .map((t: TextDisplay) => t.content)
    .join('\n');
const sections = (m: { components?: Component[] }) => children(m).filter((c): c is Section => c.type === 9);
const rows = (m: { components?: Component[] }) => children(m).filter((c) => c.type === 1);

describe('renderMatchCard — active phase', () => {
  const s = matchState(game(), [
    player({ player_id: 1, discord_user_id: 'd1', username: 'Alice' }),
    player({ player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
  ]);
  const card = renderMatchCard(s);

  it('is a single V2 container with no content or embeds', () => {
    expect(card.components).toHaveLength(1);
    expect(root(card).type).toBe(17);
    expect(card.content).toBeUndefined();
    expect(card.embeds).toBeUndefined();
  });

  it('pings the pod in the header text and scopes allowed_mentions to the pod', () => {
    expect(allText(card)).toContain('<@d1>');
    expect(allText(card)).toContain('<@d2>');
    expect(card.allowed_mentions).toEqual({ users: ['d1', 'd2'] });
  });

  it('uses the in-progress title, brand accent and a live relative timer', () => {
    expect(allText(card)).toMatch(/in progress/i);
    expect(root(card).accent_color).toBe(COLORS.brand);
    expect(allText(card)).toContain('<t:1000:R>');
  });

  it('players without art are plain text lines, not sections with buttons', () => {
    expect(sections(card)).toHaveLength(0);
    expect(allText(card)).toMatch(/No commander logged yet/);
  });

  it('carries exactly four action buttons (set, report, cancel, settings) with well-formed ids', () => {
    const ids = customIds(card.components!);
    expect(ids).toEqual(['cmd:open:42', 'rep:open:42', 'cxl:ask:42', 'set:open:42']);
    expect(rows(card)).toHaveLength(1);
  });
});

describe('renderMatchCard — commander artwork', () => {
  it('renders a thumbnail accessory only for players who logged art', () => {
    const s = matchState(game(), [
      player({ player_id: 1, discord_user_id: 'd1', username: 'Alice', commander: 'Atraxa', commander_image: 'https://img/a' }),
      player({ player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    ]);
    const card = renderMatchCard(s);
    const secs = sections(card);
    expect(secs).toHaveLength(1);
    expect(secs[0].accessory).toEqual({ type: 11, media: { url: 'https://img/a' }, description: 'Atraxa' });
    expect(secs[0].components[0].content).toContain('Atraxa');
  });
});

describe('renderMatchCard — completed phase', () => {
  const roster = [
    // Deliberately out of finish order to prove the card sorts.
    reported(2, 24, { player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    reported(1, 27, { player_id: 1, discord_user_id: 'd1', username: 'Alice', commander: 'Atraxa', commander_image: 'https://img/a', sigma_rusted: 4, rust_days: 23 }),
  ];
  const card = renderMatchCard(matchState(game({ status: 'completed', ended_at: 5000 }), roster));

  it('titles the winner, turns gold, shows the winner art as a gallery, no pings', () => {
    expect(allText(card)).toContain('Alice takes the pod');
    expect(root(card).accent_color).toBe(COLORS.gold);
    expect(children(card)[0]).toMatchObject({ type: 12, items: [{ media: { url: 'https://img/a' } }] });
    expect(card.allowed_mentions).toBeUndefined();
    expect(allText(card)).not.toContain('<@');
  });

  it('orders players by finish with medals and a signed SR delta', () => {
    const t = allText(card);
    expect(t.indexOf('🥇 **Alice**')).toBeLessThan(t.indexOf('🥈 **Bob**'));
    expect(t).toMatch(/SR \*\*\d+\*\* \(\+\d+\)/);
  });

  it('reports match length instead of a live timer, and notes rust', () => {
    expect(allText(card)).toContain('1h 6m');
    expect(allText(card)).not.toContain(':R>');
    expect(allText(card)).toContain('🦀 23 days rusty');
  });

  it('has no buttons', () => {
    expect(rows(card)).toHaveLength(0);
    expect(customIds(card.components!)).toEqual([]);
  });

  it('a player without art becomes plain text, not a section', () => {
    expect(sections(card)).toHaveLength(1);
  });
});

describe('renderMatchCard — special results', () => {
  it('draw: every player gets the handshake medal and no gallery', () => {
    const roster = [
      reported(1, 25, { player_id: 1, discord_user_id: 'd1', username: 'Alice', commander_image: 'https://img/a' }),
      reported(1, 25, { player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    ];
    const card = renderMatchCard(matchState(game({ status: 'completed', draw: 1, ended_at: 5000 }), roster));
    expect(allText(card)).toMatch(/Draw/);
    expect(allText(card).match(/🤝 \*\*/g)).toHaveLength(2);
    expect(children(card)[0].type).not.toBe(12);
  });

  it('winner-only: meta line carries the note', () => {
    const roster = [
      reported(1, 27, { player_id: 1, discord_user_id: 'd1', username: 'Alice' }),
      reported(2, 24, { player_id: 2, discord_user_id: 'd2', username: 'Bob' }),
    ];
    const card = renderMatchCard(matchState(game({ status: 'completed', winner_only: 1, ended_at: 5000 }), roster));
    expect(allText(card)).toContain('winner-only');
  });
});

describe('renderMatchCard — cancelled phase', () => {
  it('is a single text in a red container, no pings, no buttons', () => {
    const card = renderMatchCard(matchState(game({ status: 'cancelled', ended_at: 5000 }), [player(), player({ player_id: 2 })]));
    expect(children(card)).toHaveLength(1);
    expect(root(card).accent_color).toBe(COLORS.error);
    expect(card.allowed_mentions).toBeUndefined();
    expect(customIds(card.components!)).toEqual([]);
  });
});

describe('renderMatchCard — Discord limits', () => {
  const phases: Partial<GameRow>[] = [
    {},
    { status: 'completed', ended_at: 5000 },
    { status: 'completed', draw: 1, ended_at: 5000 },
    { status: 'cancelled', ended_at: 5000 },
  ];
  for (const n of [2, 3, 4, 5, 6]) {
    for (const [pi, phase] of phases.entries()) {
      it(`${n}-player pod, phase ${pi}: within 40 components, 4000 chars, 100-char ids`, () => {
        const roster = new Array(n).fill(null).map((_, i) =>
          phase.status === 'completed'
            ? reported(phase.draw ? 1 : i + 1, 25, {
                player_id: i + 1,
                discord_user_id: `d${i + 1}`,
                username: `Player${i + 1}`,
                commander: "Atraxa, Praetors' Voice + Tymna the Weaver",
                commander_image: 'https://img/x',
                sigma_rusted: 3,
                rust_days: 20,
              })
            : player({ player_id: i + 1, discord_user_id: `d${i + 1}`, username: `Player${i + 1}` }),
        );
        const card = renderMatchCard(matchState(game(phase), roster));
        expect(countComponents(card.components!)).toBeLessThanOrEqual(LIMITS.COMPONENTS_PER_MESSAGE);
        expect(totalTextLength(card.components!)).toBeLessThanOrEqual(LIMITS.TEXT_DISPLAY_CHARS);
        for (const id of customIds(card.components!)) expect(id.length).toBeLessThanOrEqual(LIMITS.CUSTOM_ID_CHARS);
      });
    }
  }
});
