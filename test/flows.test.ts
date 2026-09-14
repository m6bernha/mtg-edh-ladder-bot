import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, customIds, type Container } from '../src/discord/components';
import { decodeOrder, encodeId, encodeOrder, parseId } from '../src/discord/custom-id';
import { customId, modalValue, parseInteraction, selectValues } from '../src/discord/options';
import { draftStatus, renderReportStep, toPlacements } from '../src/flows/report';
import { routeComponent, routeModal } from '../src/router';
import { resetIndexCache } from '../src/commanders';
import type { Env, GameRow, Interaction, RosterEntry } from '../src/types';
import { validateReport } from '../src/validation';
import { fakeD1, type FakeRoute } from './helpers/fake-d1';

// ------------------------------------------------------------- custom ids

describe('custom-id grammar', () => {
  it('round-trips and rejects reserved characters', () => {
    const id = encodeId('rep', 'pick', 42, 'f', encodeOrder([2, 0, 3]));
    expect(id).toBe('rep:pick:42:f:2-0-3');
    expect(parseId(id)).toEqual({ ns: 'rep', verb: 'pick', args: ['42', 'f', '2-0-3'] });
    expect(() => encodeId('a', 'b', 'x:y')).toThrow();
    expect(parseId('nocolon')).toBeNull();
    expect(parseId('a:b:c d')).toBeNull();
    expect(parseId(undefined)).toBeNull();
  });
  it('an empty order is a dash, and decodes back to nothing', () => {
    expect(encodeOrder([])).toBe('-');
    expect(decodeOrder('-')).toEqual([]);
    expect(decodeOrder('5-1')).toEqual([5, 1]);
    expect(decodeOrder('x-2')).toEqual([2]);
  });
  it('the worst-case report id fits Discord', () => {
    expect(encodeId('rep', 'confirm', 999999, 'f', encodeOrder([0, 1, 2, 3, 4])).length).toBeLessThanOrEqual(LIMITS.CUSTOM_ID_CHARS);
  });
});

// ---------------------------------------------------------- option parsing

describe('parseInteraction — components and modals', () => {
  const base = { id: 'i', token: 't', application_id: 'a' };
  it('requires custom_id for component and modal interactions', () => {
    expect(parseInteraction({ ...base, type: 3, data: { custom_id: 'x:y' } })).not.toBeNull();
    expect(parseInteraction({ ...base, type: 5, data: { custom_id: 'x:y' } })).not.toBeNull();
    expect(parseInteraction({ ...base, type: 3, data: { name: 'nope' } })).toBeNull();
  });
  it('still requires name for commands', () => {
    expect(parseInteraction({ ...base, type: 2, data: { custom_id: 'x:y' } })).toBeNull();
  });
});

describe('modalValue / selectValues', () => {
  const i = {
    data: {
      custom_id: 'cmd:modal:1',
      values: ['3'],
      components: [
        { type: 18, component: { type: 4, custom_id: 'q', value: 'atraxa' } }, // Label shape
        { type: 1, components: [{ type: 4, custom_id: 'p', value: 'tymna' }] }, // legacy Action Row shape
        { type: 18, component: { type: 3, custom_id: 'recent', values: ['Edgar Markov'] } },
      ],
    },
  } as unknown as Interaction;
  it('walks both wrapper shapes and selects', () => {
    expect(modalValue(i, 'q')).toBe('atraxa');
    expect(modalValue(i, 'p')).toBe('tymna');
    expect(modalValue(i, 'recent')).toBe('Edgar Markov');
    expect(modalValue(i, 'missing')).toBeUndefined();
    expect(selectValues(i)).toEqual(['3']);
    expect(customId(i)).toBe('cmd:modal:1');
  });
});

// --------------------------------------------------------- report reducer

const seat = (player_id: number, name: string): RosterEntry => ({
  game_id: 7,
  player_id,
  placement: null,
  commander: player_id === 1 ? 'Atraxa' : null,
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
  ts_sigma: 8.33,
});
const roster4 = [seat(1, 'Ann'), seat(2, 'Bob'), seat(3, 'Cy'), seat(4, 'Dee')];

describe('report draft', () => {
  it('full placements: done once all but the last are picked', () => {
    expect(draftStatus({ mode: 'f', order: [] }, 4)).toEqual({ done: false, nextPlace: 1 });
    expect(draftStatus({ mode: 'f', order: [2, 0] }, 4)).toEqual({ done: false, nextPlace: 3 });
    expect(draftStatus({ mode: 'f', order: [2, 0, 3] }, 4)).toEqual({ done: true, nextPlace: 0 });
    expect(draftStatus({ mode: 'f', order: [1] }, 2)).toEqual({ done: true, nextPlace: 0 });
  });
  it('winner-only needs one pick; draw needs none', () => {
    expect(draftStatus({ mode: 'w', order: [] }, 4).done).toBe(false);
    expect(draftStatus({ mode: 'w', order: [3] }, 4).done).toBe(true);
    expect(draftStatus({ mode: 'd', order: [] }, 4).done).toBe(true);
  });
  it('toPlacements fills the implied seats and satisfies validateReport', () => {
    const ids = roster4.map((r) => r.discord_user_id);
    const f = toPlacements({ mode: 'f', order: [2, 0, 3] }, roster4);
    expect(f).toEqual([
      { userId: 'u3', place: 1 },
      { userId: 'u1', place: 2 },
      { userId: 'u4', place: 3 },
      { userId: 'u2', place: 4 },
    ]);
    expect(validateReport(ids, f, { draw: false, winnerOnly: false })).toEqual({ ok: true });
    const w = toPlacements({ mode: 'w', order: [3] }, roster4);
    expect(w[0]).toEqual({ userId: 'u4', place: 1 });
    expect(validateReport(ids, w, { draw: false, winnerOnly: true })).toEqual({ ok: true });
    const d = toPlacements({ mode: 'd', order: [] }, roster4);
    expect(validateReport(ids, d, { draw: true, winnerOnly: false })).toEqual({ ok: true });
  });
});

describe('renderReportStep', () => {
  const ids = (m: { components?: unknown[] }) => customIds(m.components as never);
  it('offers only unpicked players, in a select whose id carries the draft', () => {
    const m = renderReportStep(7, { mode: 'f', order: [2] }, roster4);
    const select = (m.components![0] as Container).components.find((c) => c.type === 1 && c.components[0].type === 3)!;
    const opts = (select as { components: { options: { value: string; label: string }[] }[] }).components[0].options;
    expect(opts.map((o) => o.value)).toEqual(['0', '1', '3']);
    expect(opts[0].label).toBe('Ann');
    expect(ids(m)).toContain('rep:pick:7:f:2');
    expect(ids(m)).toContain('rep:back:7:f:2');
    const confirm = ids(m).find((x) => x.startsWith('rep:confirm'));
    expect(confirm).toBe('rep:confirm:7:f:2');
  });
  it('a complete draft has no select and an enabled confirm', () => {
    const m = renderReportStep(7, { mode: 'd', order: [] }, roster4);
    const c = (m.components![0] as Container).components;
    expect(c.some((x) => x.type === 1 && x.components[0].type === 3)).toBe(false);
    const confirmBtn = c
      .filter((x) => x.type === 1)
      .flatMap((x) => x.components)
      .find((b) => b.type === 2 && b.custom_id?.startsWith('rep:confirm')) as { disabled?: boolean };
    expect(confirmBtn.disabled).toBeUndefined();
  });
  it('every id in every step is within limits and unique', () => {
    for (const draft of [{ mode: 'f' as const, order: [] }, { mode: 'f' as const, order: [0, 1, 2] }, { mode: 'w' as const, order: [1] }]) {
      const all = ids(renderReportStep(999999, draft, roster4));
      expect(new Set(all).size).toBe(all.length);
      for (const id of all) expect(id.length).toBeLessThanOrEqual(LIMITS.CUSTOM_ID_CHARS);
    }
  });
});

// ------------------------------------------------------------- routing

const game: GameRow = {
  id: 7,
  guild_id: 'g',
  channel_id: 'c',
  status: 'active',
  bracket: 'open',
  winner_only: 0,
  draw: 0,
  started_at: 1,
  ended_at: null,
  created_by: 'u1',
  reported_by: null,
  message_id: 'm1',
  top_player_id: null,
};

function env(extra: FakeRoute[] = []) {
  const db = fakeD1([
    ...extra,
    { match: "status = 'active' LIMIT 1", first: game },
    { match: 'FROM game_players gp JOIN players p', rows: roster4 },
    { match: 'GROUP BY gp.commander', rows: [] },
    { match: 'UPDATE game_players SET commander', rows: [] },
    { match: "SET status = 'cancelled'", rows: [] },
  ]);
  return { db, env: { DB: db, DISCORD_BOT_TOKEN: 't', DISCORD_PUBLIC_KEY: 'k' } as Env };
}
const ctx = () => {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext, waits };
};
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
const body = async (r: Response) => (await r.json()) as { type: number; data?: { flags?: number; components?: unknown[]; embeds?: unknown[]; custom_id?: string } };

const fetchSpy = vi.fn();
beforeEach(() => {
  resetIndexCache();
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(() => Promise.resolve(new Response('{"id":"m1"}', { status: 200 })));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe('routeComponent', () => {
  it('unknown or malformed ids get an ephemeral V2 refusal', async () => {
    const { env: e } = env();
    const b = await body(await routeComponent(click('nope:what:1'), e, ctx().ctx));
    expect(b.type).toBe(4);
    expect(b.data!.flags! & 64).toBe(64);
    expect(b.data!.flags! & (1 << 15)).toBe(1 << 15);
    expect(b.data!.components).toHaveLength(1);
  });

  it('a card button for a game that is no longer active is refused', async () => {
    const { env: e } = env();
    const b = await body(await routeComponent(click('rep:open:8'), e, ctx().ctx));
    expect(b.type).toBe(4);
    expect(JSON.stringify(b.data)).toContain('no longer in progress');
  });

  it('rep:open by a pod member opens the ephemeral picker; by an outsider is refused', async () => {
    const { env: e } = env();
    const ok = await body(await routeComponent(click('rep:open:7'), e, ctx().ctx));
    expect(ok.type).toBe(4);
    expect(JSON.stringify(ok.data)).toContain('rep:pick:7:f:-');
    const no = await body(await routeComponent(click('rep:open:7', 'stranger'), e, ctx().ctx));
    expect(JSON.stringify(no.data)).toContain('Only players in this game');
  });

  it('rep:pick updates the message in place (type 7) with the extended draft', async () => {
    const { env: e } = env();
    const b = await body(await routeComponent(click('rep:pick:7:f:-', 'u1', { component_type: 3, values: ['2'] }), e, ctx().ctx));
    expect(b.type).toBe(7);
    expect(JSON.stringify(b.data)).toContain('rep:pick:7:f:2');
    expect(JSON.stringify(b.data)).toContain('🥇 **Cy**');
  });

  it('rep:pick rejects a stale/duplicate pick without crashing', async () => {
    const { env: e } = env();
    const b = await body(await routeComponent(click('rep:pick:7:f:2', 'u1', { component_type: 3, values: ['2'] }), e, ctx().ctx));
    expect(b.type).toBe(4);
    expect(JSON.stringify(b.data)).toContain('out of date');
  });

  it('cmd:open by a non-member is refused even for an admin (own-seat rule)', async () => {
    const { env: e } = env();
    const i = click('cmd:open:7', 'admin');
    i.member!.permissions = '8';
    const b = await body(await routeComponent(i, e, ctx().ctx));
    expect(JSON.stringify(b.data)).toContain("not in this game's pod");
  });

  it('cmd:open with no recent decks opens the search modal (type 9)', async () => {
    const { env: e } = env();
    const b = await body(await routeComponent(click('cmd:open:7'), e, ctx().ctx));
    expect(b.type).toBe(9);
    expect(b.data!.custom_id).toBe('cmd:modal:7');
    expect((b.data as { components: unknown[] }).components.length).toBeLessThanOrEqual(LIMITS.MODAL_COMPONENTS);
  });

  it('cmd:open with recent decks offers them plus a search button', async () => {
    const { env: e } = env([{ match: 'GROUP BY gp.commander', rows: [{ commander: 'Edgar Markov', games: 3, last_at: 5 }] }]);
    const b = await body(await routeComponent(click('cmd:open:7'), e, ctx().ctx));
    expect(b.type).toBe(4);
    const s = JSON.stringify(b.data);
    expect(s).toContain('cmd:recent:7');
    expect(s).toContain('cmd:search:7');
    expect(s).toContain('Edgar Markov');
  });

  it('cxl:yes defers the update and then edits the card', async () => {
    const { env: e } = env();
    const c = ctx();
    const b = await body(await routeComponent(click('cxl:yes:7'), e, c.ctx));
    expect(b.type).toBe(6);
    await Promise.all(c.waits);
    // the live-card edit and the @original PATCH both went through fetch
    const urls = fetchSpy.mock.calls.map((x) => String(x[0]));
    expect(urls.some((u) => u.includes('/channels/c/messages/m1'))).toBe(true);
    expect(urls.some((u) => u.includes('/webhooks/app/tok/messages/@original'))).toBe(true);
    const patch = fetchSpy.mock.calls.find((x) => String(x[0]).includes('@original'))![1] as { body: string };
    expect(JSON.parse(patch.body).flags & (1 << 15)).toBe(1 << 15);
  });
});

describe('routeModal', () => {
  it('cmd:modal defers an ephemeral reply, resolves, writes and confirms', async () => {
    const { db, env: e } = env([
      { match: 'SELECT name, norm_name, short_name, norm_short, front_name, color_identity, edhrec_rank, partner_flags FROM commanders', rows: [{ name: 'Edgar Markov', norm_name: 'edgar markov', short_name: 'Edgar Markov', norm_short: 'edgar markov', front_name: null, color_identity: 'WBR', edhrec_rank: 1, partner_flags: 0 }] },
      { match: 'WHERE name = ?', first: { oracle_id: 'o', name: 'Edgar Markov', norm_name: 'edgar markov', short_name: 'Edgar Markov', norm_short: 'edgar markov', front_name: null, color_identity: 'WBR', type_line: null, edhrec_rank: 1, art_crop: 'https://img/e', image_normal: null, partner_flags: 0 } },
    ]);
    const c = ctx();
    const i: Interaction = {
      ...click('cmd:modal:7'),
      type: 5,
      data: { name: '', custom_id: 'cmd:modal:7', components: [{ type: 18, component: { type: 4, custom_id: 'q', value: 'edgar markov' } }] },
    };
    const b = await body(await routeModal(i, e, c.ctx));
    expect(b.type).toBe(5);
    expect(b.data!.flags).toBe(64);
    await Promise.all(c.waits);
    expect(db.log.some((s) => s.includes('UPDATE game_players SET commander'))).toBe(true);
    const patch = fetchSpy.mock.calls.find((x) => String(x[0]).includes('@original'))![1] as { body: string };
    expect(patch.body).toContain('Edgar Markov');
  });
});
