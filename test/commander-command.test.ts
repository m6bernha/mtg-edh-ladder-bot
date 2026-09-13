import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetIndexCache } from '../src/commanders';
import { handleCommander } from '../src/commands/commander';
import { routeAutocomplete } from '../src/router';
import type { Env, Interaction } from '../src/types';
import { fakeD1, type FakeRoute } from './helpers/fake-d1';

const SNAPSHOT = 'SELECT name, norm_name, short_name, norm_short, front_name, color_identity, edhrec_rank, partner_flags FROM commanders';
const indexRows = [
  { name: "Atraxa, Praetors' Voice", norm_name: 'atraxa praetors voice', short_name: 'Atraxa', norm_short: 'atraxa', front_name: null, color_identity: 'WUBG', edhrec_rank: 2480, partner_flags: 0 },
  { name: 'Atraxa, Grand Unifier', norm_name: 'atraxa grand unifier', short_name: 'Atraxa', norm_short: 'atraxa', front_name: null, color_identity: 'WUBG', edhrec_rank: 3540, partner_flags: 0 },
  { name: 'Edgar Markov', norm_name: 'edgar markov', short_name: 'Edgar Markov', norm_short: 'edgar markov', front_name: null, color_identity: 'WBR', edhrec_rank: 3157, partner_flags: 0 },
  { name: 'A'.repeat(99) + 'x', norm_name: 'a'.repeat(99) + 'x', short_name: 'A'.repeat(99) + 'x', norm_short: 'a'.repeat(99) + 'x', front_name: null, color_identity: '', edhrec_rank: 9999, partner_flags: 0 },
];
const fullRow = (name: string, art: string | null) => ({
  oracle_id: 'o', name, norm_name: name.toLowerCase(), short_name: name, norm_short: name.toLowerCase(),
  front_name: null, color_identity: 'WUBG', type_line: null, edhrec_rank: 1, art_crop: art, image_normal: null, partner_flags: 0,
});

const game = { id: 7, guild_id: 'g', channel_id: 'c', status: 'active', bracket: 'open', winner_only: 0, draw: 0, started_at: 1, ended_at: null, created_by: 'u1', reported_by: null, message_id: 'm1' };
const roster = [
  { game_id: 7, player_id: 1, placement: null, commander: null, commander_image: null, mu_before: null, mu_after: null, sigma_before: null, sigma_after: null, discord_user_id: 'u1', username: 'Alice', ts_mu: 25, ts_sigma: 8.33 },
  { game_id: 7, player_id: 2, placement: null, commander: null, commander_image: null, mu_before: null, mu_after: null, sigma_before: null, sigma_after: null, discord_user_id: 'u2', username: 'Bob', ts_mu: 25, ts_sigma: 8.33 },
];

function env(extra: FakeRoute[] = []) {
  const db = fakeD1([
    { match: SNAPSHOT, rows: indexRows },
    ...extra,
    { match: "status = 'active'", first: game },
    { match: 'FROM game_players gp JOIN players p', rows: roster },
    { match: 'UPDATE game_players SET commander', rows: [] },
  ]);
  return { db, env: { DB: db, DISCORD_BOT_TOKEN: 'tok', DISCORD_PUBLIC_KEY: 'pk' } as Env };
}

const interaction = (name: string, partner?: string, userId = 'u1'): Interaction => ({
  type: 2,
  id: 'i',
  token: 't',
  application_id: 'a',
  guild_id: 'g',
  channel_id: 'c',
  member: { user: { id: userId, username: 'Alice' }, permissions: '0' },
  data: {
    name: 'commander',
    options: [
      { type: 3, name: 'name', value: name },
      ...(partner ? [{ type: 3, name: 'partner', value: partner }] : []),
    ],
  },
});

const fetchSpy = vi.fn();
beforeEach(() => {
  resetIndexCache();
  fetchSpy.mockReset();
  // The live-card edit; succeeds so no hint is appended.
  fetchSpy.mockImplementation(() => Promise.resolve(new Response('{"id":"m1"}', { status: 200 })));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const text = (m: { embeds?: { description?: string }[] }) => m.embeds?.[0]?.description ?? '';
const storedName = (db: ReturnType<typeof fakeD1>) => db.log.find((s) => s.includes('UPDATE game_players SET commander'));

describe('/commander', () => {
  it('stores a confident match with its art and confirms plainly', async () => {
    const { db, env: e } = env([{ match: 'WHERE name = ?', first: fullRow('Edgar Markov', 'https://img/edgar') }]);
    const reply = await handleCommander(interaction('edgar markov'), e);
    expect(text(reply)).toContain('**Edgar Markov** locked in');
    expect(text(reply)).not.toContain('Took');
    expect(storedName(db)).toBeDefined();
  });

  it('ambiguous short name: takes the most-played card, says so, lists the others', async () => {
    const { env: e } = env([{ match: 'WHERE name = ?', first: fullRow("Atraxa, Praetors' Voice", 'https://img/a') }]);
    const reply = await handleCommander(interaction('atraxa'), e);
    expect(text(reply)).toContain("**Atraxa, Praetors' Voice** locked in");
    expect(text(reply)).toContain('Took **Atraxa, Praetors\' Voice** for “atraxa”');
    expect(text(reply)).toContain('Atraxa, Grand Unifier');
  });

  it('typo: never silently commits — the note says what was taken', async () => {
    const { env: e } = env([{ match: 'WHERE name = ?', first: fullRow('Edgar Markov', null) }]);
    const reply = await handleCommander(interaction('edgr markov'), e);
    expect(text(reply)).toContain('Took **Edgar Markov** for “edgr markov”');
  });

  it('no match: stores as typed with a note', async () => {
    const { env: e } = env([{ match: 'WHERE name = ?', first: null }]);
    const reply = await handleCommander(interaction('Totally Not A Card'), e);
    expect(text(reply)).toContain('**Totally Not A Card** locked in');
    expect(text(reply)).toContain('Stored “Totally Not A Card” as typed');
  });

  it('partners combine alphabetically into one deck identity', async () => {
    // The fake returns the same full row for every by-name lookup, so pair a
    // resolved primary with an unmatched partner to see the join.
    const { env: e } = env([{ match: 'WHERE name = ?', first: fullRow('Edgar Markov', null) }]);
    const reply = await handleCommander(interaction('zzz homebrew', 'edgar markov'), e);
    expect(text(reply)).toContain('**Edgar Markov + zzz homebrew** locked in');
    expect(text(reply)).toContain('Stored “zzz homebrew” as typed');
  });

  it('refuses a caller who is not in the pod, before writing anything', async () => {
    const { db, env: e } = env([{ match: 'WHERE name = ?', first: fullRow('Edgar Markov', null) }]);
    const reply = await handleCommander(interaction('edgar markov', undefined, 'stranger'), e);
    expect(text(reply)).toContain("not in that game's pod");
    expect(storedName(db)).toBeUndefined();
  });
});

describe('autocomplete routing', () => {
  const auto = (value: string): Interaction => ({
    type: 4,
    id: 'i',
    token: 't',
    application_id: 'a',
    guild_id: 'g',
    data: { name: 'commander', options: [{ type: 3, name: 'name', value, focused: true }] },
  });

  it('labels carry colour identity; values are the exact card name', async () => {
    const { env: e } = env();
    const res = await routeAutocomplete(auto('atraxa'), e);
    const body = (await res.json()) as { type: number; data: { choices: { name: string; value: string }[] } };
    expect(body.type).toBe(8);
    expect(body.data.choices[0]).toEqual({ name: "⚪🔵⚫🟢 Atraxa, Praetors' Voice", value: "Atraxa, Praetors' Voice" });
  });

  it('caps labels and values at Discord\'s 100 characters', async () => {
    const { env: e } = env();
    const res = await routeAutocomplete(auto('aaaa'), e);
    const body = (await res.json()) as { data: { choices: { name: string; value: string }[] } };
    const long = body.data.choices.find((c) => c.value.startsWith('AAAA'))!;
    expect(long.name.length).toBeLessThanOrEqual(100);
    expect(long.value.length).toBeLessThanOrEqual(100);
  });

  it('returns no choices for an unfocused or unrelated option', async () => {
    const { env: e } = env();
    const i = auto('atraxa');
    i.data!.name = 'stats';
    const body = (await (await routeAutocomplete(i, e)).json()) as { data: { choices: unknown[] } };
    expect(body.data.choices).toEqual([]);
  });
});
