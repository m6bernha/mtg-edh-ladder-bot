import { skillRating } from '../ratings/trueskill.ts';
import { COLORS, MEDALS, bracketLabel, fmtDuration, signed } from './embeds';
import {
  ButtonStyle,
  button,
  container,
  gallery,
  row,
  section,
  sep,
  text,
  thumb,
  type Button,
  type ContainerChild,
} from './components.ts';
import { encodeId } from './custom-id.ts';
import type { GameRow, MessageData, RosterEntry } from '../types';

/**
 * The live match card: ONE Discord message per game that mutates in place as the
 * pod plays. /game start posts it; /commander, /game bracket, /game report,
 * /game cancel and the card's own buttons edit it. Built on Components V2 (a
 * Container with sections, art and buttons). Everything here is a pure function
 * of MatchCardState so it can be unit-tested without a database or Discord.
 */

export type MatchPhase = 'active' | 'completed' | 'cancelled';

export interface CardPlayer {
  userId: string;
  username: string;
  commander: string | null;
  commanderImage: string | null;
  placement: number | null;
  /** SR before this game (or current SR while the game is live). */
  srBefore: number | null;
  /** SR after the game — only set once reported. */
  srAfter: number | null;
  /** Idle days that applied rust at report time; null when none. */
  rustDays: number | null;
}

export interface MatchCardState {
  gameId: number;
  phase: MatchPhase;
  players: CardPlayer[];
  bracket: string;
  startedAt: number;
  endedAt: number | null;
  draw: boolean;
  winnerOnly: boolean;
}

/** Six players plus chrome is ~28 components; Discord allows 40. */
const MAX_PLAYERS_RENDERED = 6;

/**
 * Adapt DB rows into the pure card state. A completed roster carries per-game
 * mu/sigma snapshots; a live roster only has the player's current rating.
 */
export function matchState(game: GameRow, roster: RosterEntry[]): MatchCardState {
  const phase: MatchPhase =
    game.status === 'completed' ? 'completed' : game.status === 'cancelled' ? 'cancelled' : 'active';

  const players: CardPlayer[] = roster.map((r) => {
    const reported = r.mu_after != null && r.sigma_after != null;
    return {
      userId: r.discord_user_id,
      username: r.username,
      commander: r.commander,
      commanderImage: r.commander_image,
      placement: r.placement,
      srBefore:
        reported && r.mu_before != null && r.sigma_before != null
          ? skillRating(r.mu_before, r.sigma_before)
          : skillRating(r.ts_mu, r.ts_sigma),
      srAfter: reported ? skillRating(r.mu_after!, r.sigma_after!) : null,
      rustDays: r.sigma_rusted != null ? r.rust_days : null,
    };
  });

  return {
    gameId: game.id,
    phase,
    players,
    bracket: game.bracket,
    startedAt: game.started_at,
    endedAt: game.ended_at,
    draw: game.draw === 1,
    winnerOnly: game.winner_only === 1,
  };
}

// ---- Text helpers ----

function headerTitle(s: MatchCardState): string {
  if (s.phase === 'cancelled') return '## 🗑️ Game cancelled';
  if (s.phase === 'completed') {
    if (s.draw) return '## 🤝 Draw — the pod splits it';
    const winner = s.players.find((p) => p.placement === 1);
    return winner ? `## 🏆 ${winner.username} takes the pod!` : '## 🏆 Pod reported';
  }
  return '## ⚔️ Pod in progress';
}

function accent(s: MatchCardState): number {
  if (s.phase === 'cancelled') return COLORS.error;
  if (s.phase === 'completed') return COLORS.gold;
  return COLORS.brand;
}

function metaLine(s: MatchCardState): string {
  const parts = [`**${s.players.length} players**`, bracketLabel(s.bracket)];
  if (s.phase === 'active') {
    // <t:…:R> is a self-updating relative timestamp — a live timer with no edits.
    parts.push(`started <t:${s.startedAt}:R>`);
  } else {
    parts.push(fmtDuration(s.endedAt != null ? s.endedAt - s.startedAt : 0));
    if (s.winnerOnly) parts.push('winner-only');
  }
  return parts.join(' · ');
}

function footer(s: MatchCardState): string {
  if (s.phase === 'active') return '-# Buttons work for anyone in the pod · or `/commander`, `/game report`, `/game cancel`';
  if (s.phase === 'completed') return '-# Wrong result? `/undo` · Full profile: `/stats`';
  return '-# Nothing counts — start fresh with `/game start`';
}

/** Order players by finish once reported; keep roster order while live. */
function orderPlayers(s: MatchCardState): CardPlayer[] {
  if (s.phase !== 'completed' || s.draw) return s.players;
  return [...s.players].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99));
}

function playerLine(p: CardPlayer, s: MatchCardState, idx: number): string {
  let head: string;
  if (s.phase === 'active') {
    head = `**${p.username}**${p.srBefore != null ? ` · SR ${p.srBefore}` : ''}`;
  } else {
    const medal = s.draw ? '🤝' : (MEDALS[(p.placement ?? idx + 1) - 1] ?? `${p.placement}.`);
    const sr =
      p.srAfter != null
        ? ` · SR **${p.srAfter}**${p.srBefore != null ? ` (${signed(p.srAfter - p.srBefore)})` : ''}`
        : '';
    head = `${medal} **${p.username}**${sr}`;
  }
  const deck = p.commander
    ? `*${p.commander}*`
    : s.phase === 'active'
      ? '-# No commander logged yet'
      : '-# No commander logged';
  const rust = p.rustDays != null && s.phase === 'completed' ? `\n-# 🦀 ${p.rustDays} days rusty` : '';
  return `${head}\n${deck}${rust}`;
}

// ---- Buttons ----

export const CardButtons = {
  setCommander: (gameId: number, idx?: number) =>
    idx === undefined ? encodeId('cmd', 'open', gameId) : encodeId('cmd', 'open', gameId, idx),
  report: (gameId: number) => encodeId('rep', 'open', gameId),
  cancel: (gameId: number) => encodeId('cxl', 'ask', gameId),
} as const;

function actionRow(s: MatchCardState) {
  return row(
    button(ButtonStyle.PRIMARY, 'Set commander', CardButtons.setCommander(s.gameId), { emoji: '🧙' }),
    button(ButtonStyle.SUCCESS, 'Report result', CardButtons.report(s.gameId), { emoji: '🏁' }),
    button(ButtonStyle.DANGER, 'Cancel game', CardButtons.cancel(s.gameId), { emoji: '🗑️' }),
  );
}

// ---- Renderer ----

export function renderMatchCard(s: MatchCardState): MessageData {
  const children: ContainerChild[] = [];

  if (s.phase === 'cancelled') {
    children.push(text(`${headerTitle(s)}\n${metaLine(s)}\n${footer(s)}`));
    return { components: [container(accent(s), ...children)] };
  }

  const ordered = orderPlayers(s).slice(0, MAX_PLAYERS_RENDERED);

  if (s.phase === 'completed' && !s.draw) {
    const winner = ordered.find((p) => p.placement === 1);
    if (winner?.commanderImage) {
      children.push(gallery({ url: winner.commanderImage, description: winner.commander ?? winner.username }));
    }
  }

  const pings = s.phase === 'active' ? `\n🎲 **Game on!** ${s.players.map((p) => `<@${p.userId}>`).join(' ')}` : '';
  children.push(text(`${headerTitle(s)}${pings}`), text(metaLine(s)), sep(1));

  ordered.forEach((p, idx) => {
    const line = text(playerLine(p, s, idx));
    if (p.commanderImage) {
      children.push(section(thumb(p.commanderImage, p.commander ?? undefined), line));
    } else if (s.phase === 'active') {
      const set: Button = button(ButtonStyle.SECONDARY, 'Set', CardButtons.setCommander(s.gameId, idx));
      children.push(section(set, line));
    } else {
      children.push(line);
    }
  });

  if (s.phase === 'active') {
    children.push(sep(2), actionRow(s));
  } else {
    children.push(sep(1));
  }
  children.push(text(footer(s)));

  const data: MessageData = { components: [container(accent(s), ...children)] };
  if (s.phase === 'active') {
    // Roster pings live in the header text so the pod is notified on the initial
    // post. Edits suppress re-pings by overriding allowed_mentions (see updateLiveCard).
    data.allowed_mentions = { users: s.players.map((p) => p.userId) };
  }
  return data;
}
