import { skillRating } from '../ratings/trueskill';
import type { LeaderboardRow } from '../db/queries';
import type { MessageData } from '../types';

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
  return {
    embeds: [
      {
        title: `📊 ${v.username}`,
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
              "`/stats` — your (or anyone's) profile: SR, placements, streak, form, commanders.",
              '`/vs` — head-to-head between two players.',
            ].join('\n'),
          },
          {
            name: '🎯  How rating works',
            value:
              '**SR** is your rank — an Xbox-Live-style TrueSkill number that handles ' +
              'free-for-all pods and models uncertainty. Fresh players start near **500** ' +
              'and move fast until the system is confident, then settle. Beating a stronger ' +
              'pod is worth more than beating a weaker one.',
          },
        ],
        footer: { text: 'Commander confirmations are shown only to you — the card carries the news.' },
      },
    ],
  };
}
