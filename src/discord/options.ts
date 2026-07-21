import { InteractionType } from '../types';
import type { DiscordUser, Interaction, InteractionOption } from '../types';

/**
 * Runtime shape check for the Discord payload. The body is Ed25519-verified
 * before this runs, so this is not a trust boundary — it stops a malformed or
 * restructured payload from surfacing as an `undefined` crash deep inside a
 * handler, and lets us answer 400 instead.
 *
 * Requirements are per interaction type on purpose. PING is how Discord
 * verifies the endpoint URL; holding it to fields it does not need would risk
 * taking the whole bot offline if Discord ever changes its envelope.
 */
export function parseInteraction(body: unknown): Interaction | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const i = body as Record<string, unknown>;
  if (typeof i.type !== 'number') return null;

  const needsResponse =
    i.type === InteractionType.APPLICATION_COMMAND ||
    i.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE;

  if (needsResponse) {
    // Deferred replies are delivered by webhook, which needs both of these,
    // and every handler dispatches on data.name.
    if (typeof i.token !== 'string' || typeof i.application_id !== 'string') return null;
    if (typeof i.data !== 'object' || i.data === null) return null;
    if (typeof (i.data as Record<string, unknown>).name !== 'string') return null;
  }

  return i as unknown as Interaction;
}

/** Unwrap a subcommand: /game start → { name: 'start', options: [...] } */
export function getSub(i: Interaction): { name: string; options: InteractionOption[] } | null {
  const top = i.data?.options?.[0];
  if (top && top.type === 1) return { name: top.name, options: top.options ?? [] };
  return null;
}

/**
 * Discord delivers user, role and channel options as snowflake strings, so
 * mention options read through the same accessor as plain string options.
 * Returns undefined rather than coercing when the payload disagrees with the
 * registered command schema.
 */
export function optString(options: InteractionOption[], name: string): string | undefined {
  const v = options.find((o) => o.name === name)?.value;
  return typeof v === 'string' ? v : undefined;
}

export function optBoolean(options: InteractionOption[], name: string): boolean | undefined {
  const v = options.find((o) => o.name === name)?.value;
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Commands that read guild-wide data (leaderboard, stats, vs, undo) need a
 * guild id. Interactions sent from a DM have none. Returning the id rather than
 * a boolean lets the caller use it as a plain `string`.
 */
export function requireGuild(
  i: Interaction,
): { ok: true; guildId: string } | { ok: false; error: string } {
  if (!i.guild_id) return { ok: false, error: 'Run this in a server.' };
  return { ok: true, guildId: i.guild_id };
}

/**
 * Game commands are scoped to a single channel — one active pod per channel —
 * so they need both ids.
 */
export function requireGuildChannel(
  i: Interaction,
): { ok: true; guildId: string; channelId: string } | { ok: false; error: string } {
  if (!i.guild_id || !i.channel_id) {
    return { ok: false, error: 'Run this in a server channel.' };
  }
  return { ok: true, guildId: i.guild_id, channelId: i.channel_id };
}

export function invoker(i: Interaction): DiscordUser {
  const u = i.member?.user ?? i.user;
  if (!u) throw new Error('interaction has no user');
  return u;
}

export function displayName(u: DiscordUser): string {
  return u.global_name || u.username;
}

export function resolvedUser(i: Interaction, id: string): DiscordUser | undefined {
  return i.data?.resolved?.users?.[id];
}

/** Collect user-option values for the given option names, in order, skipping unset. */
export function collectUsers(options: InteractionOption[], names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = optString(options, n);
    if (v) out.push(v);
  }
  return out;
}
