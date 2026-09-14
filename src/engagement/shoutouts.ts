/**
 * The 📣 block appended to a public /game report: what changed on the ladder
 * because of this game. Pure — computed from the board before and after, plus
 * per-seat facts the report service already has in hand.
 */

export interface RankedEntry {
  playerId: number;
  username: string;
  sr: number;
}

export interface PodFact {
  playerId: number;
  username: string;
  placement: number;
  srBefore: number;
  srAfter: number;
  /** Completed games before this one. */
  gamesBefore: number;
  /** Highest SR the player had held before this game (0 when unknown). */
  personalBestBefore: number;
  /** Consecutive wins before this game (so a win now makes it +1). */
  winStreakBefore: number;
  /** Consecutive losses before this game. */
  lossStreakBefore: number;
  hasWonBefore: boolean;
  /** First-place probability from /predict's model, computed before the game. */
  preGameWinPct: number;
  rustDays: number | null;
}

export interface ShoutoutInput {
  /** Sorted by SR desc, before the game. */
  before: RankedEntry[];
  /** Sorted by SR desc, after the game. */
  after: RankedEntry[];
  pod: PodFact[];
  draw: boolean;
}

export const MAX_SHOUTOUTS = 5;
const MILESTONES = [10, 25, 50, 100, 250];
const UPSET_THRESHOLD = 0.25;
const RUST_NOTE_DAYS = 14;
const STREAK_MIN = 3;

function rankOf(board: RankedEntry[], playerId: number): number {
  const i = board.findIndex((e) => e.playerId === playerId);
  return i === -1 ? Infinity : i + 1;
}

export function buildShoutouts(input: ShoutoutInput): string[] {
  const out: string[] = [];
  const { before, after, pod, draw } = input;
  const winner = draw ? undefined : pod.find((p) => p.placement === 1);

  // New #1 — someone else led before.
  const newTop = after[0];
  if (newTop && before[0]?.playerId !== newTop.playerId && pod.some((p) => p.playerId === newTop.playerId)) {
    out.push(`👑 **${newTop.username}** takes #1 on the ladder!`);
  }

  // Rank climbs, biggest first.
  const climbs = pod
    .map((p) => ({ p, from: rankOf(before, p.playerId), to: rankOf(after, p.playerId) }))
    .filter((c) => c.to < c.from && Number.isFinite(c.from) && c.to !== 1)
    .sort((a, b) => b.from - b.to - (a.from - a.to));
  for (const c of climbs.slice(0, 2)) {
    const spots = c.from - c.to;
    out.push(`📈 **${c.p.username}** climbs ${spots === 1 ? 'a spot' : `${spots} spots`} to #${c.to}`);
  }

  if (winner) {
    const streak = winner.winStreakBefore + 1;
    if (streak >= STREAK_MIN) out.push(`🔥 **${winner.username}** is on a ${streak}-game win streak`);

    const lowest = Math.min(...pod.map((p) => p.preGameWinPct));
    if (winner.preGameWinPct === lowest && winner.preGameWinPct < UPSET_THRESHOLD && pod.length > 2) {
      out.push(`😱 Upset! **${winner.username}** won at ${Math.round(winner.preGameWinPct * 100)}% odds`);
    }

    if (winner.lossStreakBefore >= STREAK_MIN) {
      out.push(`💪 **${winner.username}** snaps a ${winner.lossStreakBefore}-game skid`);
    }
  }

  // Personal bests.
  for (const p of pod) {
    if (p.personalBestBefore > 0 && p.srAfter > p.personalBestBefore) {
      out.push(`🏅 **${p.username}** hits a personal-best SR of ${p.srAfter}`);
    }
  }

  // First win ever.
  if (winner && !winner.hasWonBefore) {
    out.push(`🎉 **${winner.username}** wins their first pod!`);
  }

  // Game-count milestones.
  for (const p of pod) {
    const n = p.gamesBefore + 1;
    if (MILESTONES.includes(n)) out.push(`🎲 **${p.username}** plays game #${n}`);
  }

  // Rust.
  for (const p of pod) {
    if (p.rustDays != null && p.rustDays >= RUST_NOTE_DAYS) {
      out.push(`🦀 **${p.username}** was ${p.rustDays} days rusty — rating moves faster until it settles`);
    }
  }

  return out.slice(0, MAX_SHOUTOUTS);
}
