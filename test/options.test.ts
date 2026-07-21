import { describe, expect, it } from 'vitest';
import { requireGuild, requireGuildChannel } from '../src/discord/options';
import type { Interaction } from '../src/types';

/** Minimal interaction shell — these helpers only read guild_id / channel_id. */
const interaction = (guildId?: string, channelId?: string): Interaction =>
  ({ guild_id: guildId, channel_id: channelId }) as Interaction;

describe('requireGuild', () => {
  it('returns the guild id when present', () => {
    const r = requireGuild(interaction('g1', 'c1'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.guildId).toBe('g1');
  });

  it('rejects a DM interaction, which carries no guild', () => {
    const r = requireGuild(interaction(undefined, 'c1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Run this in a server.');
  });

  it('does not require a channel', () => {
    expect(requireGuild(interaction('g1', undefined)).ok).toBe(true);
  });
});

describe('requireGuildChannel', () => {
  it('returns both ids when present', () => {
    const r = requireGuildChannel(interaction('g1', 'c1'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.guildId).toBe('g1');
      expect(r.channelId).toBe('c1');
    }
  });

  it('rejects when either id is missing', () => {
    for (const i of [
      interaction(undefined, 'c1'),
      interaction('g1', undefined),
      interaction(undefined, undefined),
    ]) {
      const r = requireGuildChannel(i);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('Run this in a server channel.');
    }
  });
});
