import { skillRating } from '../ratings/trueskill';
import { colorEmoji } from '../commanders';
import type { LeaderboardRow } from '../db/queries';
import type { Badge } from '../engagement/achievements';
import type { DigestView } from '../engagement/digest';
import type { HistoryView } from '../commands/history';
import type { MetaView } from '../commands/meta';
import type { PredictView } from '../commands/predict';
import type { Embed, MessageData } from '../types';

export const COLORS = {
  brand: 0x8b5cf6,
  success: 0x22c55e,
  error: 0xef4444,
  gold: 0xf59e0b,
} as const;

export const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'];

// The leaderboard renders inside a Discord code block, so it relies on a
// fixed-width layout. Names are truncated, then padded, to keep columns aligned.
// Dropping the Elo column freed horizontal room, so names get more of it.
const NAME_MAX_CHARS = 18;
const NAME_COLUMN_WIDTH = 20;

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

/** The 📣 block under a reported game: rank changes, streaks, upsets, milestones. */
export function shoutoutsEmbed(lines: string[]): Embed {
  return { description: lines.join('\n'), color: COLORS.gold };
}

export function leaderboardMessage(rows: LeaderboardRow[]): MessageData {
  const header = ' #  Player               SR   Record    Win%';
  const lines = rows.map((r, i) => {
    const rank = String(i + 1).padStart(2);
    const name = r.username.slice(0, NAME_MAX_CHARS).padEnd(NAME_COLUMN_WIDTH);
    const sr = String(skillRating(r.ts_mu, r.ts_sigma)).padStart(4);
    const losses = r.games - r.wins - r.draws;
    const rec = `${r.wins}-${losses}${r.draws ? `-${r.draws}D` : ''}`.padEnd(9);
    const pct = `${Math.round((r.wins / r.games) * 100)}%`.padStart(4);
    return `${rank}  ${name}${sr}  ${rec}${pct}`;
  });
  return {
    embeds: [
      {
        title: '🏆 All-time ladder',
        description: '```\n' + [header, ...lines].join('\n') + '\n```',
        color: COLORS.brand,
        footer: { text: 'SR = TrueSkill rank · /stats for a full profile' },
      },
    ],
  };
}

export interface StatsView {
  username: string;
  sr: number;
  mu: number;
  sigma: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  winPct: number;
  placementCounts: number[]; // index 0 = 1st place count, over non-draw games
  avgDuration: number;
  streak: string; // e.g. "W3"
  form: string[]; // oldest→newest, up to 5 of W/L/D
  srTrendRecent: number;
  mostPlayed?: { name: string; games: number };
  best?: { name: string; winPct: number; games: number };
  /** Ladder position, e.g. { rank: 3, of: 12 }. */
  rank?: { rank: number; of: number };
  badges: Badge[];
}

export function statsMessage(v: StatsView): MessageData {
  const placements = v.placementCounts
    .map((c, i) => (c > 0 || i < 4 ? `${MEDALS[i] ?? `${i + 1}.`} ${c}` : null))
    .filter(Boolean)
    .join(' · ');
  const commanders =
    v.mostPlayed == null
      ? 'None logged yet — use /commander during a game'
      : `Most played: **${v.mostPlayed.name}** (${v.mostPlayed.games})` +
        (v.best ? ` · Best: **${v.best.name}** (${v.best.winPct}% of ${v.best.games})` : '');
  const badges = v.badges.length
    ? v.badges.map((b) => `${b.emoji} **${b.label}** — ${b.description}`).join('\n')
    : 'None yet — win a pod for First Blood.';
  return {
    embeds: [
      {
        title: `📊 ${v.username}${v.rank ? `  ·  #${v.rank.rank} of ${v.rank.of}` : ''}`,
        color: COLORS.brand,
        fields: [
          {
            name: 'Rating',
            value: `SR **${v.sr}**  ·  μ ${v.mu.toFixed(1)} · σ ${v.sigma.toFixed(1)}`,
          },
          {
            name: 'Record',
            value:
              `${v.wins}W-${v.losses}L${v.draws ? `-${v.draws}D` : ''} · ` +
              `${v.winPct}% win rate · ${v.games} games`,
          },
          { name: 'Placements', value: placements || '—' },
          {
            name: 'Momentum',
            value:
              `Streak **${v.streak}** · Form ${v.form.join(' ')} · ` +
              `SR ${signed(v.srTrendRecent)} over last ${v.form.length}`,
          },
          { name: 'Pace', value: `Avg game ${fmtDuration(v.avgDuration)}` },
          { name: 'Commanders', value: commanders },
          { name: `Badges (${v.badges.length})`, value: badges },
        ],
      },
    ],
  };
}

export interface VsView {
  nameA: string;
  nameB: string;
  shared: number;
  aAbove: number;
  bAbove: number;
  even: number;
  aWins: number;
  bWins: number;
  avgA: number;
  avgB: number;
  longest: number;
  fastest: number;
}

export function vsMessage(v: VsView): MessageData {
  return {
    embeds: [
      {
        title: `⚔️ ${v.nameA} vs ${v.nameB}`,
        color: COLORS.brand,
        fields: [
          { name: 'Shared pods', value: String(v.shared), inline: true },
          { name: 'Pod wins', value: `${v.nameA} ${v.aWins} · ${v.nameB} ${v.bWins}`, inline: true },
          {
            name: 'Finishes above',
            value: `${v.nameA} **${v.aAbove}** – **${v.bAbove}** ${v.nameB}` +
              (v.even ? ` (${v.even} even)` : ''),
          },
          {
            name: 'Avg placement',
            value: `${v.nameA} ${v.avgA.toFixed(1)} · ${v.nameB} ${v.avgB.toFixed(1)}`,
            inline: true,
          },
          {
            name: 'Longest / fastest',
            value: `${fmtDuration(v.longest)} / ${fmtDuration(v.fastest)}`,
            inline: true,
          },
        ],
      },
    ],
  };
}

export function helpMessage(): MessageData {
  return {
    embeds: [
      {
        title: '📖 EDH Ladder',
        color: COLORS.brand,
        description:
          'One live card per game. `/game start` posts it and every other command ' +
          'updates that same card — no channel spam.',
        fields: [
          {
            name: '▶️  Run a game',
            value: [
              '`/game start` — @ the pod (2–6 players, 1v1 included), optional bracket. Posts the live card and starts a timer.',
              '`/commander` — log your deck (Scryfall autocomplete). Its art appears on the card. `partner` for Partner / Background / Friends Forever.',
              '`/game report` — placements when it ends: 1st, 2nd, 3rd… Flags: `winner_only`, `draw`.',
            ].join('\n'),
          },
          {
            name: '🔧  Fix things',
            value: [
              '`/game bracket` — set or correct the bracket mid-game or after reporting.',
              '`/game cancel` — abort the game; nothing counts.',
              '`/undo` — revert the most recent completed game (players or admins).',
            ].join('\n'),
          },
          {
            name: '📊  The ladder',
            value: [
              '`/leaderboard` — all-time ranking by SR.',
              "`/stats` — your (or anyone's) profile: rank, SR, placements, streak, form, commanders, badges.",
              '`/vs` — head-to-head between two players.',
              '`/meta` — the commander meta: games, win rate, average finish, pilots.',
              "`/history` — recent games, optionally one player's.",
              '`/predict` — win odds for the pod in progress.',
            ].join('\n'),
          },
          {
            name: '🎯  How rating works',
            value:
              '**SR** is your rank — a TrueSkill number that handles free-for-all pods and ' +
              'models uncertainty. Fresh players start near **500** and move fast until the ' +
              'system is confident, then settle — but never freeze: every game keeps ratings ' +
              'in motion, and a player who sits out for more than a week gets **rusty** 🦀 ' +
              '(uncertainty grows, so their next games move them faster, up or down). ' +
              'Beating a stronger pod is worth more than beating a weaker one.',
          },
          {
            name: '🛠️  Admins',
            value: '`/config digest-channel #channel` — a weekly ladder digest, Mondays. `/config digest-off` stops it.',
          },
        ],
        footer: { text: 'Commander confirmations are shown only to you — the card carries the news.' },
      },
    ],
  };
}

// ---- /meta, /history, /predict, digest ----

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

export function metaMessage(v: MetaView): MessageData {
  const lines = v.rows.map((r, i) => {
    const n = (v.page - 1) * 10 + i + 1;
    const avg = r.avg_placement != null ? r.avg_placement.toFixed(1) : '—';
    return (
      `**${n}.** ${colorEmoji(r.colors)} **${r.commander}**\n` +
      `-# ${r.games} games · ${r.wins} wins (${pct(r.wins, r.games)}) · avg finish ${avg} · ${r.pilots} pilot${r.pilots === 1 ? '' : 's'}`
    );
  });
  return {
    embeds: [
      {
        title: '🧙 Commander meta',
        description: lines.join('\n'),
        color: COLORS.brand,
        footer: {
          text: `Page ${v.page}/${v.pages} · ${v.minGames}+ games to appear · /meta page:<n>`,
        },
      },
    ],
  };
}

export function historyMessage(v: HistoryView): MessageData {
  const lines = v.rows.map((r) => {
    const result = r.draw
      ? '🤝 Draw'
      : r.winner_name
        ? `🏆 **${r.winner_name}**${r.winner_commander ? ` · *${r.winner_commander}*` : ''}`
        : '🏆 Reported';
    const flags = r.winner_only ? ' · winner-only' : '';
    return `${result}\n-# <t:${r.ended_at}:R> · ${r.pod_size} players · ${bracketLabel(r.bracket)} · ${fmtDuration(r.ended_at - r.started_at)}${flags}`;
  });
  return {
    embeds: [
      {
        title: v.filter ? `📜 Games with ${v.filter.username}` : '📜 Recent games',
        description: lines.join('\n'),
        color: COLORS.brand,
        footer: { text: `Page ${v.page}/${v.pages} · /history page:<n>` },
      },
    ],
  };
}

const BAR_WIDTH = 12;
function bar(p: number): string {
  const filled = Math.round(p * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

export function predictMessage(v: PredictView): MessageData {
  const lines = v.entries.map(
    (e) =>
      `\`${bar(e.winPct)}\` **${Math.round(e.winPct * 100)}%** ${e.username}` +
      ` · SR ${e.sr}${e.rusted ? ' 🦀' : ''}${e.commander ? ` · *${e.commander}*` : ''}`,
  );
  const q = Math.round(v.quality * 100);
  const verdict = q >= 60 ? 'an even table' : q >= 35 ? 'a slight favourite' : 'a lopsided pod';
  return {
    embeds: [
      {
        title: '🔮 Win odds',
        description: lines.join('\n'),
        color: COLORS.brand,
        fields: [{ name: 'Match quality', value: `${q}% — ${verdict}`, inline: true }],
        footer: { text: 'TrueSkill first-place odds; 🦀 = rusty (uncertainty inflated by time away)' },
      },
    ],
  };
}

export function digestMessage(v: DigestView, sinceTs: number): MessageData {
  const fields: Embed['fields'] = [];
  if (v.mostActive) fields.push({ name: 'Most active', value: `**${v.mostActive.username}** · ${v.mostActive.games} games`, inline: true });
  if (v.biggestClimber) fields.push({ name: 'Biggest climber', value: `**${v.biggestClimber.username}** · ${signed(v.biggestClimber.delta)} SR`, inline: true });
  if (v.commanderOfWeek) {
    fields.push({
      name: 'Commander of the week',
      value: `**${v.commanderOfWeek.name}** · ${v.commanderOfWeek.games} games, ${v.commanderOfWeek.wins} wins`,
      inline: true,
    });
  }
  if (v.longest) fields.push({ name: 'Longest game', value: `${fmtDuration(v.longest.seconds)}${v.longest.winner ? ` · won by **${v.longest.winner}**` : ''}`, inline: true });
  if (v.top3.length) {
    fields.push({ name: 'Top of the ladder', value: v.top3.map((t, i) => `${MEDALS[i]} **${t.username}** · ${t.sr}`).join('\n') });
  }
  return {
    embeds: [
      {
        title: '📰 This week on the ladder',
        description: `**${v.games}** game${v.games === 1 ? '' : 's'} · **${v.players}** players · since <t:${sinceTs}:R>`,
        color: COLORS.gold,
        fields,
        footer: { text: '/leaderboard · /stats · /meta' },
      },
    ],
  };
}
