/**
 * Classic (embed) messages and shared formatting. Rich readouts live in
 * boards.ts (Components V2); the simple confirmations and errors here stay as
 * embeds because they carry no components, and a message cannot mix the two.
 */

import type { MessageData } from '../types';

export const COLORS = {
  brand: 0x8b5cf6,
  success: 0x22c55e,
  error: 0xef4444,
  gold: 0xf59e0b,
} as const;

export const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'];

export function errorMessage(msg: string): MessageData {
  return { embeds: [{ description: `❌ ${msg}`, color: COLORS.error }] };
}

export function successMessage(msg: string): MessageData {
  return { embeds: [{ description: msg, color: COLORS.success }] };
}

/** Neutral notice — an empty ladder or a fresh player is not an error. */
export function infoMessage(msg: string): MessageData {
  return { embeds: [{ description: msg, color: COLORS.brand }] };
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function bracketLabel(bracket: string): string {
  return bracket === 'open' ? 'Open' : `Bracket ${bracket}`;
}

export const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
