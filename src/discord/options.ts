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
