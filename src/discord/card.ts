import { skillRating } from '../ratings/trueskill';
import { COLORS, MEDALS, bracketLabel, fmtDuration, signed } from './embeds';
import type { Embed, GameRow, MessageData, RosterEntry } from '../types';

/**
 * The live match card: ONE Discord message per game that mutates in place as the
 * pod plays. /game start posts it; /commander, /game bracket, /game report and
 * /game cancel edit it. Everything here is a pure function of MatchCardState so it
 * can be unit-tested without a database or Discord.
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
}

export interface MatchCardState {
  phase: MatchPhase;
  players: CardPlayer[];
  bracket: string;
  startedAt: number;
  endedAt: number | null;
  draw: boolean;
  winnerOnly: boolean;
}

/** Discord caps a message at 10 embeds; a 6-player pod plus header is 7. */
const MAX_PLAYER_EMBEDS = 9;

/**
 * Adapt DB rows into the pure card state. A completed roster carries per-game
 * mu/sigma snapshots; a live roster only has the player's current rating.
 */
export function matchState(game: GameRow, roster: RosterEntry[]): MatchCardState {
  const phase: MatchPhase =
    game.status === 'completed'
      ? 'completed'
      : game.status === 'cancelled'
        ? 'cancelled'
        : 'active';

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
    };
  });

  return {
    phase,
    players,
    bracket: game.bracket,
    startedAt: game.started_at,
    endedAt: game.ended_at,
    draw: game.draw === 1,
    winnerOnly: game.winner_only === 1,
  };
}

function headerTitle(s: MatchCardState): string {
  if (s.phase === 'cancelled') return '🗑️ Game cancelled';
  if (s.phase === 'completed') {
    if (s.draw) return '🤝 Draw — the pod splits it';
    const winner = s.players.find((p) => p.placement === 1);
    return winner ? `🏆 ${winner.username} takes the pod!` : '🏆 Pod reported';
  }
  return '⚔️ Pod in progress';
}

function headerColor(s: MatchCardState): number {
  if (s.phase === 'cancelled') return COLORS.error;
  if (s.phase === 'completed') return COLORS.gold;
  return COLORS.brand;
}

function timeField(s: MatchCardState): { name: string; value: string; inline: boolean } {
  if (s.phase === 'active') {
    // <t:…:R> is a self-updating relative timestamp — a live timer with no edits.
    return { name: 'Started', value: `<t:${s.startedAt}:R>`, inline: true };
  }
  const seconds = s.endedAt != null ? s.endedAt - s.startedAt : 0;
  return { name: 'Length', value: fmtDuration(seconds), inline: true };
}

function footerText(s: MatchCardState): string {
  if (s.phase === 'active') return 'Log your deck: /commander  ·  Finish: /game report';
  if (s.phase === 'completed') return 'Wrong result? /undo  ·  Full profile: /stats';
  return 'Nothing counts — start fresh with /game start';
}

/** Order players by finish once reported; keep roster order while live. */
function orderPlayers(s: MatchCardState): CardPlayer[] {
  if (s.phase !== 'completed' || s.draw) return s.players;
  return [...s.players].sort(
    (a, b) => (a.placement ?? 99) - (b.placement ?? 99),
  );
}

function playerEmbed(p: CardPlayer, s: MatchCardState, idx: number): Embed {
  const medal = s.draw ? '🤝' : (MEDALS[(p.placement ?? idx + 1) - 1] ?? `${p.placement}.`);
  const author = s.phase === 'active' ? `• ${p.username}` : `${medal} ${p.username}`;

  let line: string;
  if (p.commander) {
    line = `*${p.commander}*`;
  } else if (s.phase === 'active') {
    line = '_No commander logged — `/commander`_';
  } else {
    line = '_No commander logged_';
  }

  if (s.phase === 'completed' && p.srAfter != null) {
    const delta = p.srBefore != null ? ` (${signed(p.srAfter - p.srBefore)})` : '';
    line += `\nSR **${p.srAfter}**${delta}`;
  } else if (p.srBefore != null) {
    line += `\nSR ${p.srBefore}`;
  }

  const embed: Embed = {
    author: { name: author },
    description: line,
    color: headerColor(s),
  };
  if (p.commanderImage) embed.thumbnail = { url: p.commanderImage };
  return embed;
}

export function renderMatchCard(s: MatchCardState): MessageData {
  const ordered = orderPlayers(s);

  const header: Embed = {
    title: headerTitle(s),
    color: headerColor(s),
    fields: [
      { name: 'Pod', value: `${s.players.length} players`, inline: true },
      { name: 'Bracket', value: bracketLabel(s.bracket), inline: true },
      timeField(s),
    ],
    footer: { text: footerText(s) },
  };
  if (s.winnerOnly && s.phase === 'completed') {
    header.fields!.push({ name: 'Scoring', value: 'Winner-only', inline: true });
  }

  const embeds: Embed[] = [header];
  if (s.phase !== 'cancelled') {
    ordered.slice(0, MAX_PLAYER_EMBEDS).forEach((p, idx) => embeds.push(playerEmbed(p, s, idx)));
  }

  const data: MessageData = { embeds };
  if (s.phase === 'active') {
    // Roster pings live in content so the pod is notified on the initial post.
    // Edits suppress re-pings by overriding allowed_mentions (see updateLiveCard).
    data.content = `🎲 **Game on!** ${s.players.map((p) => `<@${p.userId}>`).join(' ')}`;
    data.allowed_mentions = { users: s.players.map((p) => p.userId) };
  }
  return data;
}
