import { skillRating } from '../ratings/trueskill';
import type { LeaderboardRow } from '../db/queries';
import type { MessageData } from '../types';

export const COLORS = {
  brand: 0x8b5cf6,
  success: 0x22c55e,
  error: 0xef4444,
  gold: 0xf59e0b,
} as const;

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣'];

export function errorMessage(msg: string): MessageData {
  return { embeds: [{ description: `❌ ${msg}`, color: COLORS.error }] };
}

export function successMessage(msg: string): MessageData {
  return { embeds: [{ description: msg, color: COLORS.success }] };
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

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export function gameStartMessage(
  userIds: string[],
  bracket: string,
  startedAt: number,
): MessageData {
  return {
    content: `🎲 **Game on!** ${userIds.map((id) => `<@${id}>`).join(' ')}`,
    embeds: [
      {
        title: '⚔️ EDH pod started',
        color: COLORS.brand,
        fields: [
          { name: 'Pod', value: `${userIds.length} players`, inline: true },
          { name: 'Bracket', value: bracketLabel(bracket), inline: true },
          { name: 'Started', value: `<t:${startedAt}:R>`, inline: true },
        ],
        footer: {
          text: 'When the dust settles: /game report · Log your deck: /commander',
        },
      },
    ],
    allowed_mentions: { users: userIds },
  };
}

export interface ReportLine {
  userId: string;
  username: string;
  placement: number;
  eloBefore: number;
  eloAfter: number;
  srBefore: number;
  srAfter: number;
  commander: string | null;
}

export function reportMessage(
  lines: ReportLine[],
  opts: { duration: number; bracket: string; draw: boolean; winnerOnly: boolean },
): MessageData {
  const rows = lines.map((l) => {
    const medal = opts.draw ? '🤝' : (MEDALS[l.placement - 1] ?? `${l.placement}.`);
    const eloD = Math.round(l.eloAfter) - Math.round(l.eloBefore);
    const srD = l.srAfter - l.srBefore;
    const deck = l.commander ? ` — *${l.commander}*` : '';
    return `${medal} **${l.username}**${deck}\n` +
      `　 Elo ${Math.round(l.eloAfter)} (${signed(eloD)}) · SR ${l.srAfter} (${signed(srD)})`;
  });
  const title = opts.draw
    ? '🤝 Draw reported'
    : `🏆 ${lines[0].username} takes the pod!`;
  const meta = [
    `⏱️ ${fmtDuration(opts.duration)}`,
    bracketLabel(opts.bracket),
    ...(opts.winnerOnly ? ['Winner-only scoring'] : []),
  ].join(' · ');
  return {
    embeds: [
      {
        title,
        description: `${rows.join('\n')}\n\n${meta}`,
        color: COLORS.gold,
      },
    ],
  };
}

export function leaderboardMessage(rows: LeaderboardRow[]): MessageData {
  const header = ' #  Player          SR    Elo  Record    Win%';
  const lines = rows.map((r, i) => {
    const rank = String(i + 1).padStart(2);
    const name = r.username.slice(0, 13).padEnd(15);
    const sr = String(skillRating(r.ts_mu, r.ts_sigma)).padStart(4);
    const elo = String(Math.round(r.elo)).padStart(5);
    const losses = r.games - r.wins - r.draws;
    const rec = `${r.wins}-${losses}${r.draws ? `-${r.draws}D` : ''}`.padEnd(9);
    const pct = `${Math.round((r.wins / r.games) * 100)}%`.padStart(4);
    return `${rank}  ${name}${sr}  ${elo}  ${rec}${pct}`;
  });
  return {
    embeds: [
      {
        title: '🏆 All-time ladder',
        description: '```\n' + [header, ...lines].join('\n') + '\n```',
        color: COLORS.brand,
        footer: { text: 'SR = TrueSkill (ranked by this) · Elo = pairwise · /stats for details' },
      },
    ],
  };
}

export interface StatsView {
  username: string;
  sr: number;
  mu: number;
  sigma: number;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  winPct: number;
  placementCounts: number[]; // index 0 = 1st place count, over non-draw games
  avgDuration: number;
  streak: string; // e.g. "W3"
  form: string[]; // oldest→newest, up to 5 of W/L/D
  eloTrend5: number;
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
            name: 'Ratings',
            value: `SR **${v.sr}** (μ ${v.mu.toFixed(1)}, σ ${v.sigma.toFixed(1)}) · Elo **${Math.round(v.elo)}**`,
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
              `Elo ${signed(v.eloTrend5)} over last ${Math.min(v.games, 5)}`,
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
        title: '📖 EDH Ladder — how it works',
        color: COLORS.brand,
        description: [
          '**Playing**',
          '`/game start` — start a game in this channel, @ the pod (2-6 players, 1v1 EDH included), optional bracket. A live timer starts.',
          '`/commander` — (optional) log your commander for the game, with autocomplete. Add `partner` for pairs (Partner, Backgrounds, Friends Forever).',
          '`/game report` — report placements when it ends: 1st, 2nd, 3rd… Flags: `winner_only`, `draw`.',
          '`/game cancel` — abort the game, nothing counts.',
          '`/undo` — revert the most recent completed game (participants/admins).',
          '',
          '**Stats**',
          '`/leaderboard` — all-time ladder: SR, Elo, W-L, win%.',
          '`/stats` — your (or anyone\'s) profile: placements, streak, form, commanders.',
          '`/vs` — head-to-head between two players.',
          '',
          '**Ratings**: SR is TrueSkill (uncertainty-aware, the real ranking). Elo is classic pairwise (starts 1000). Both update every game.',
        ].join('\n'),
      },
    ],
  };
}
