import { describe, expect, it } from 'vitest';
import { restoreFromSnapshots } from '../src/db/snapshots';
import { isAdmin, isPlayerOrAdmin, validateReport, validateStart } from '../src/validation';
import type { GamePlayerRow } from '../src/types';

describe('validateStart', () => {
  it('accepts 2-6 distinct players (1v1 EDH included)', () => {
    expect(validateStart(['a', 'b']).ok).toBe(true);
    expect(validateStart(['a', 'b', 'c']).ok).toBe(true);
    expect(validateStart(['a', 'b', 'c', 'd', 'e', 'f']).ok).toBe(true);
  });
  it('rejects duplicates and bad counts', () => {
    expect(validateStart(['a']).ok).toBe(false);
    expect(validateStart(['a', 'b', 'b']).ok).toBe(false);
    expect(validateStart(['a', 'b', 'c', 'd', 'e', 'f', 'g']).ok).toBe(false);
  });
});

describe('validateReport', () => {
  const roster = ['a', 'b', 'c', 'd'];
  const placed = (ids: string[]) => ids.map((userId, i) => ({ userId, place: i + 1 }));
  const noFlags = { draw: false, winnerOnly: false };

  it('accepts an exact roster permutation', () => {
    expect(validateReport(roster, placed(['c', 'a', 'd', 'b']), noFlags).ok).toBe(true);
  });
  it('rejects duplicate users across slots', () => {
    const r = validateReport(roster, placed(['a', 'a', 'b', 'c']), noFlags);
    expect(r.ok).toBe(false);
  });
  it('rejects outsiders', () => {
    const r = validateReport(roster, placed(['a', 'b', 'c', 'x']), noFlags);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('<@x>');
  });
  it('rejects missing players with a helpful message', () => {
    const r = validateReport(roster, placed(['a', 'b', 'c']), noFlags);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('<@d>');
  });
  it('rejects draw + winner-only together', () => {
    const r = validateReport(roster, placed(['a', 'b', 'c', 'd']), { draw: true, winnerOnly: true });
    expect(r.ok).toBe(false);
  });
});

describe('isAdmin', () => {
  it('detects ADMINISTRATOR and MANAGE_GUILD bits', () => {
    expect(isAdmin('8')).toBe(true);
    expect(isAdmin('32')).toBe(true);
    expect(isAdmin(String(0x8 | 0x400))).toBe(true);
    expect(isAdmin('1024')).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin('garbage')).toBe(false);
  });
});

describe('isPlayerOrAdmin', () => {
  const roster = [{ discord_user_id: 'a' }, { discord_user_id: 'b' }];
  const NO_PERMS = '0';
  const ADMIN = '8';

  it('allows anyone in the pod, regardless of permissions', () => {
    expect(isPlayerOrAdmin(roster, 'a', NO_PERMS)).toBe(true);
    expect(isPlayerOrAdmin(roster, 'b', undefined)).toBe(true);
  });
  it('allows an admin who did not play', () => {
    expect(isPlayerOrAdmin(roster, 'outsider', ADMIN)).toBe(true);
  });
  it('rejects a non-admin who did not play', () => {
    expect(isPlayerOrAdmin(roster, 'outsider', NO_PERMS)).toBe(false);
    expect(isPlayerOrAdmin(roster, 'outsider', undefined)).toBe(false);
  });
  it('rejects everyone when the pod is empty and the caller is not an admin', () => {
    expect(isPlayerOrAdmin([], 'a', NO_PERMS)).toBe(false);
  });
});

describe('restoreFromSnapshots', () => {
  const row = (playerId: number, mu: number, sigma: number): GamePlayerRow => ({
    game_id: 1,
    player_id: playerId,
    placement: 1,
    commander: null,
    commander_image: null,
    mu_before: mu,
    mu_after: mu + 1,
    sigma_before: sigma,
    sigma_after: sigma - 0.5,
  });

  it('returns the pre-game values for every player', () => {
    const updates = restoreFromSnapshots([row(1, 25, 8.33), row(2, 26.1, 7.9)]);
    expect(updates).toEqual([
      { playerId: 1, mu: 25, sigma: 8.33 },
      { playerId: 2, mu: 26.1, sigma: 7.9 },
    ]);
  });

  it('throws when snapshots are missing', () => {
    const bad = { ...row(1, 25, 8.33), mu_before: null };
    expect(() => restoreFromSnapshots([bad])).toThrow();
  });
});
