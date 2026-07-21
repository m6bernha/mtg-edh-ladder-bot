/** Pure validation logic for game start / report — unit-testable, no I/O. */

export interface PlacementInput {
  userId: string;
  place: number; // 1-based, from the first..sixth option slots
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateStart(userIds: string[]): ValidationResult {
  if (userIds.length < 2 || userIds.length > 6) {
    return { ok: false, error: 'A game needs 2-6 players.' };
  }
  if (new Set(userIds).size !== userIds.length) {
    return { ok: false, error: 'The same player is listed twice.' };
  }
  return { ok: true };
}

export function validateReport(
  rosterIds: string[],
  placements: PlacementInput[],
  flags: { draw: boolean; winnerOnly: boolean },
): ValidationResult {
  if (flags.draw && flags.winnerOnly) {
    return { ok: false, error: 'A game cannot be both a draw and winner-only — pick one.' };
  }
  const ids = placements.map((p) => p.userId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: 'The same player appears in two placement slots.' };
  }
  const roster = new Set(rosterIds);
  for (const id of ids) {
    if (!roster.has(id)) {
      return { ok: false, error: `<@${id}> is not in this game's pod.` };
    }
  }
  if (ids.length !== rosterIds.length) {
    const missing = rosterIds.filter((r) => !ids.includes(r));
    return {
      ok: false,
      error: `Placements are missing for: ${missing.map((m) => `<@${m}>`).join(' ')}`,
    };
  }
  // Slots are contiguous by construction (first..sixth), but guard anyway:
  const places = placements.map((p) => p.place).sort((a, b) => a - b);
  for (let i = 0; i < places.length; i++) {
    if (places[i] !== i + 1) {
      return { ok: false, error: 'Placements must be contiguous — fill 1st, 2nd, 3rd… in order.' };
    }
  }
  return { ok: true };
}

/** True if the member permission bitfield contains ADMINISTRATOR or MANAGE_GUILD. */
export function isAdmin(permissions: string | undefined): boolean {
  if (!permissions) return false;
  try {
    const bits = BigInt(permissions);
    return (bits & 0x8n) !== 0n || (bits & 0x20n) !== 0n;
  } catch (e) {
    // Malformed bitfield — deny by default, but make it visible. Discord sends
    // this as a decimal string, so a parse failure means the payload shape
    // changed and permission checks are silently failing closed.
    console.warn('isAdmin: could not parse permission bitfield:', e);
    return false;
  }
}
