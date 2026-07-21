import { describe, expect, it } from 'vitest';
import {
  optBoolean,
  optString,
  parseInteraction,
  requireGuild,
  requireGuildChannel,
} from '../src/discord/options';
import { InteractionType } from '../src/types';
import type { Interaction, InteractionOption } from '../src/types';

/** Minimal interaction shell — these helpers only read guild_id / channel_id. */
const interaction = (guildId?: string, channelId?: string): Interaction =>
  ({ guild_id: guildId, channel_id: channelId }) as Interaction;

describe('parseInteraction', () => {
  const command = {
    type: InteractionType.APPLICATION_COMMAND,
    id: 'i1',
    token: 't1',
    application_id: 'a1',
    data: { name: 'leaderboard' },
  };

  it('accepts a well-formed command', () => {
    expect(parseInteraction(command)).not.toBeNull();
  });

  it('accepts a bare PING, which carries nothing else we need', () => {
    // Endpoint verification must never be rejected for missing command fields.
    expect(parseInteraction({ type: InteractionType.PING })).not.toBeNull();
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'string', 42, true, []]) {
      expect(parseInteraction(bad)).toBeNull();
    }
  });

  it('rejects a missing or non-numeric type', () => {
    expect(parseInteraction({})).toBeNull();
    expect(parseInteraction({ type: '2' })).toBeNull();
  });

  it('rejects a command missing the fields the webhook reply needs', () => {
    expect(parseInteraction({ ...command, token: undefined })).toBeNull();
    expect(parseInteraction({ ...command, application_id: 42 })).toBeNull();
  });

  it('rejects a command with no usable data.name', () => {
    expect(parseInteraction({ ...command, data: undefined })).toBeNull();
    expect(parseInteraction({ ...command, data: null })).toBeNull();
    expect(parseInteraction({ ...command, data: {} })).toBeNull();
  });

  it('holds autocomplete to the same bar as a command', () => {
    const autocomplete = { ...command, type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE };
    expect(parseInteraction(autocomplete)).not.toBeNull();
    expect(parseInteraction({ ...autocomplete, data: {} })).toBeNull();
  });
});

describe('optString / optBoolean', () => {
  const options: InteractionOption[] = [
    { name: 'bracket', type: 3, value: 'open' },
    { name: 'draw', type: 5, value: true },
    { name: 'count', type: 4, value: 3 },
    { name: 'empty', type: 3, value: '' },
  ];

  it('reads values of the matching type', () => {
    expect(optString(options, 'bracket')).toBe('open');
    expect(optBoolean(options, 'draw')).toBe(true);
  });

  it('returns undefined for absent options', () => {
    expect(optString(options, 'nope')).toBeUndefined();
    expect(optBoolean(options, 'nope')).toBeUndefined();
  });

  it('refuses to coerce across types', () => {
    expect(optString(options, 'count')).toBeUndefined();
    expect(optString(options, 'draw')).toBeUndefined();
    expect(optBoolean(options, 'bracket')).toBeUndefined();
  });

  it('preserves the empty string rather than folding it to undefined', () => {
    // Callers rely on `?? 'open'` and truthiness checks; changing this would
    // silently alter defaulting behaviour.
    expect(optString(options, 'empty')).toBe('');
  });
});

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
