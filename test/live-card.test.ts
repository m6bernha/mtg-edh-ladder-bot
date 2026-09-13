import { describe, expect, it } from 'vitest';
import { cardFailureHint } from '../src/discord/live-card';

describe('cardFailureHint', () => {
  it('blames the token, not channel permissions, on 401', () => {
    const hint = cardFailureHint({ ok: false, status: 401, code: 0, message: '401: Unauthorized' });
    expect(hint).toContain('rejected my bot token');
    expect(hint).toContain('DISCORD_BOT_TOKEN');
    expect(hint).not.toContain('View Channel');
  });

  it('distinguishes Missing Access from Missing Permissions on 403', () => {
    const access = cardFailureHint({ ok: false, status: 403, code: 50001, message: 'Missing Access' });
    expect(access).toContain('View Channel');
    expect(access).toContain('re-invite');
    const perms = cardFailureHint({ ok: false, status: 403, code: 50013, message: 'Missing Permissions' });
    expect(perms).toContain('Send Messages');
    expect(perms).not.toContain('re-invite');
  });

  it('flags a bodiless 403 as the WAF rather than a permission problem', () => {
    expect(cardFailureHint({ ok: false, status: 403 })).toContain('WAF');
  });

  it('quotes Discord’s own message and falls back to the status code', () => {
    expect(cardFailureHint({ ok: false, status: 429 })).toContain('rate-limiting');
    expect(cardFailureHint({ ok: false, status: 0, message: 'fetch failed' })).toContain('fetch failed');
    const other = cardFailureHint({ ok: false, status: 502, message: 'Bad Gateway' });
    expect(other).toContain('502');
    expect(other).toContain('Bad Gateway');
  });
});
