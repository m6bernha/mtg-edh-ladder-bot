import type { DiscordUser, Interaction, InteractionOption } from '../types';

/** Unwrap a subcommand: /game start → { name: 'start', options: [...] } */
export function getSub(i: Interaction): { name: string; options: InteractionOption[] } | null {
  const top = i.data?.options?.[0];
  if (top && top.type === 1) return { name: top.name, options: top.options ?? [] };
  return null;
}

export function opt<T = string>(options: InteractionOption[], name: string): T | undefined {
  return options.find((o) => o.name === name)?.value as T | undefined;
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
    const v = opt<string>(options, n);
    if (v) out.push(v);
  }
  return out;
}
