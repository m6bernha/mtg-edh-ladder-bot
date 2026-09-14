/**
 * Components V2 renderers for every readout that is not the live card:
 * leaderboard, profile, meta, history, predict, help, digest, and the 📣 block.
 * Pure functions of view models — the command handlers build the views.
 */

import { colorEmoji } from '../commanders';
import type { Badge } from '../engagement/achievements';
import type { DigestView } from '../engagement/digest';
import type { HistoryView } from '../commands/history';
import type { MetaView } from '../commands/meta';
import type { PredictView } from '../commands/predict';
import type { MessageData } from '../types';
import {
  ButtonStyle,
  button,
  container,
  row,
  section,
  sep,
  text,
  thumb,
  type ContainerChild,
} from './components.ts';
import { encodeId } from './custom-id.ts';
import { COLORS, MEDALS, bracketLabel, fmtDuration, signed } from './embeds';

// ---- helpers ----

const SPARK = '▁▂▃▄▅▆▇█';

/** Unicode sparkline of a series (oldest → newest). Flat series render mid-height. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return SPARK[3].repeat(values.length);
  return values.map((v) => SPARK[Math.round(((v - min) / (max - min)) * (SPARK.length - 1))]).join('');
}

function pager(ns: string, page: number, pages: number, extra: (string | number)[] = []) {
  return row(
    button(ButtonStyle.SECONDARY, '◀ Prev', encodeId(ns, 'page', page - 1, ...extra), { disabled: page <= 1 }),
    button(ButtonStyle.SECONDARY, `${page} / ${pages}`, encodeId(ns, 'noop', page), { disabled: true }),
    button(ButtonStyle.SECONDARY, 'Next ▶', encodeId(ns, 'page', page + 1, ...extra), { disabled: page >= pages }),
  );
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

/** Append the 📣 block to any V2 message (or make one on its own). */
export function withShoutouts(message: MessageData, lines: string[]): MessageData {
  if (lines.length === 0) return message;
  return {
    ...message,
    components: [...(message.components ?? []), container(COLORS.gold, text(`📣 ${lines.join('\n')}`))],
  };
}

// ---- leaderboard ----

export interface LeaderboardEntry {
  rank: number;
  /** Rank before the player's most recent game (null = new or unknown). */
  previousRank: number | null;
  username: string;
  sr: number;
  provisional: boolean;
  wins: number;
  losses: number;
  draws: number;
  /** Oldest → newest, up to 5 of W/L/D. */
  form: string[];
  lastPlayedAt: number;
}

export interface LeaderboardView {
  entries: LeaderboardEntry[];
  page: number;
  pages: number;
  total: number;
}

const NAME_W = 13;

export function leaderboardMessage(v: LeaderboardView): MessageData {
  const header = ' #   Player          SR   W-L    Win%  Form';
  const lines = v.entries.map((e) => {
    const move =
      e.previousRank == null || e.previousRank === e.rank ? ' ' : e.previousRank > e.rank ? '▲' : '▼';
    const rank = `${String(e.rank).padStart(2)}${move}`;
    const medal = e.rank <= 3 ? MEDALS[e.rank - 1] : '';
    const name = (e.username.slice(0, NAME_W) + (e.provisional ? '*' : '')).padEnd(NAME_W + 1);
    const rec = `${e.wins}-${e.losses}${e.draws ? `-${e.draws}D` : ''}`.padEnd(7);
    const games = e.wins + e.losses + e.draws;
    return `${rank} ${name} ${String(e.sr).padStart(4)}  ${rec}${pct(e.wins, games).padStart(4)}  ${e.form.join('')}${medal ? ' ' + medal : ''}`;
  });
  const children: ContainerChild[] = [
    text(`## 🏆 The ladder\n-# ${v.total} rated player${v.total === 1 ? '' : 's'} · SR = TrueSkill rank · \`*\` still settling · ▲▼ vs before their last game`),
    text('```\n' + [header, ...lines].join('\n') + '\n```'),
  ];
  if (v.pages > 1) children.push(pager('lb', v.page, v.pages));
  children.push(text('-# `/stats` for a full profile · `/meta` for the commander table'));
  return { components: [container(COLORS.brand, ...children)] };
}

// ---- stats ----

export interface StatsView {
  username: string;
  rank?: { rank: number; of: number };
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
  /** SR after each of the last N games, oldest → newest. */
  srSeries: number[];
  perBracket: { bracket: string; games: number; wins: number }[];
  nemesis?: { username: string; above: number; shared: number };
  victim?: { username: string; below: number; shared: number };
  mostPlayed?: { name: string; games: number; art: string | null };
  best?: { name: string; winPct: number; games: number };
  badges: Badge[];
}

export function statsMessage(v: StatsView): MessageData {
  const title = text(
    `## 📊 ${v.username}${v.rank ? `  ·  #${v.rank.rank} of ${v.rank.of}` : ''}\n` +
      `SR **${v.sr}**  ·  μ ${v.mu.toFixed(1)} · σ ${v.sigma.toFixed(1)}${v.sigma > 6 ? ' · still settling' : ''}`,
  );
  const head = v.mostPlayed?.art ? section(thumb(v.mostPlayed.art, v.mostPlayed.name), title) : title;

  const placements = v.placementCounts
    .map((c, i) => (c > 0 || i < 4 ? `${MEDALS[i] ?? `${i + 1}.`} ${c}` : null))
    .filter(Boolean)
    .join(' · ');
  const brackets = v.perBracket.length
    ? v.perBracket.map((b) => `${bracketLabel(b.bracket)} ${b.wins}/${b.games}`).join(' · ')
    : '—';
  const rivals = [
    v.nemesis ? `Nemesis: **${v.nemesis.username}** finished above you ${v.nemesis.above}× in ${v.nemesis.shared}` : null,
    v.victim ? `Favourite victim: you finished above **${v.victim.username}** ${v.victim.below}× in ${v.victim.shared}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const commanders =
    v.mostPlayed == null
      ? 'None logged yet — use `/commander` during a game'
      : `Most played: **${v.mostPlayed.name}** (${v.mostPlayed.games})` +
        (v.best ? `\nBest: **${v.best.name}** (${v.best.winPct}% of ${v.best.games})` : '');
  const badges = v.badges.length
    ? v.badges.map((b) => `${b.emoji} **${b.label}** — ${b.description}`).join('\n')
    : 'None yet — win a pod for First Blood.';

  return {
    components: [
      container(
        COLORS.brand,
        head,
        sep(1),
        text(
          `**Record** ${v.wins}W-${v.losses}L${v.draws ? `-${v.draws}D` : ''} · ${v.winPct}% · ${v.games} games\n` +
            `**Placements** ${placements || '—'}\n` +
            `**Momentum** streak **${v.streak}** · form ${v.form.join(' ')} · SR ${signed(v.srTrendRecent)} over last ${v.form.length}` +
            (v.srSeries.length > 1 ? `  \`${sparkline(v.srSeries)}\`` : '') +
            `\n**Pace** avg game ${fmtDuration(v.avgDuration)}\n` +
            `**By bracket** ${brackets}` +
            (rivals ? `\n${rivals}` : ''),
        ),
        sep(1),
        text(`**Commanders**\n${commanders}`),
        sep(1),
        text(`**Badges (${v.badges.length})**\n${badges}`),
      ),
    ],
  };
}

// ---- vs ----

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
    components: [
      container(
        COLORS.brand,
        text(`## ⚔️ ${v.nameA} vs ${v.nameB}\n-# ${v.shared} shared pod${v.shared === 1 ? '' : 's'}`),
        sep(1),
        text(
          `**Finishes above** ${v.nameA} **${v.aAbove}** – **${v.bAbove}** ${v.nameB}${v.even ? ` (${v.even} even)` : ''}\n` +
            `**Pod wins** ${v.nameA} ${v.aWins} · ${v.nameB} ${v.bWins}\n` +
            `**Avg placement** ${v.nameA} ${v.avgA.toFixed(1)} · ${v.nameB} ${v.avgB.toFixed(1)}\n` +
            `**Longest / fastest** ${fmtDuration(v.longest)} / ${fmtDuration(v.fastest)}`,
        ),
      ),
    ],
  };
}

// ---- meta / history / predict ----

export function metaMessage(v: MetaView): MessageData {
  const lines = v.rows.map((r, i) => {
    const n = (v.page - 1) * 10 + i + 1;
    const avg = r.avg_placement != null ? r.avg_placement.toFixed(1) : '—';
    return (
      `**${n}.** ${colorEmoji(r.colors)} **${r.commander}**\n` +
      `-# ${r.games} games · ${r.wins} wins (${pct(r.wins, r.games)}) · avg finish ${avg} · ${r.pilots} pilot${r.pilots === 1 ? '' : 's'}`
    );
  });
  const children: ContainerChild[] = [
    text(`## 🧙 Commander meta\n-# ${v.minGames}+ logged games to appear`),
    sep(1),
    text(lines.join('\n')),
  ];
  if (v.pages > 1) children.push(pager('meta', v.page, v.pages));
  return { components: [container(COLORS.brand, ...children)] };
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
  const children: ContainerChild[] = [
    text(v.filter ? `## 📜 Games with ${v.filter.username}` : '## 📜 Recent games'),
    sep(1),
    text(lines.join('\n')),
  ];
  if (v.pages > 1) children.push(pager('hist', v.page, v.pages, [v.filter?.userId ?? '-']));
  return { components: [container(COLORS.brand, ...children)] };
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
    components: [
      container(
        COLORS.brand,
        text(`## 🔮 Win odds\n-# pod started <t:${v.startedAt}:R>`),
        sep(1),
        text(lines.join('\n')),
        sep(1),
        text(`**Match quality** ${q}% — ${verdict}\n-# TrueSkill first-place odds · 🦀 = rusty (uncertainty inflated by time away)`),
      ),
    ],
  };
}

// ---- digest ----

export function digestMessage(v: DigestView, sinceTs: number): MessageData {
  const lines: string[] = [];
  if (v.mostActive) lines.push(`**Most active** ${v.mostActive.username} · ${v.mostActive.games} games`);
  if (v.biggestClimber) lines.push(`**Biggest climber** ${v.biggestClimber.username} · ${signed(v.biggestClimber.delta)} SR`);
  if (v.commanderOfWeek) {
    lines.push(`**Commander of the week** ${v.commanderOfWeek.name} · ${v.commanderOfWeek.games} games, ${v.commanderOfWeek.wins} wins`);
  }
  if (v.longest) lines.push(`**Longest game** ${fmtDuration(v.longest.seconds)}${v.longest.winner ? ` · won by ${v.longest.winner}` : ''}`);
  const children: ContainerChild[] = [
    text(`## 📰 This week on the ladder\n-# **${v.games}** game${v.games === 1 ? '' : 's'} · **${v.players}** players · since <t:${sinceTs}:R>`),
    sep(1),
    text(lines.join('\n') || '—'),
  ];
  if (v.top3.length) {
    children.push(sep(1), text(`**Top of the ladder**\n${v.top3.map((t, i) => `${MEDALS[i]} **${t.username}** · ${t.sr}`).join('\n')}`));
  }
  children.push(text('-# `/leaderboard` · `/stats` · `/meta`'));
  return { components: [container(COLORS.gold, ...children)] };
}

// ---- help ----

export function helpMessage(): MessageData {
  return {
    components: [
      container(
        COLORS.brand,
        text(
          '## 📖 EDH Ladder\nOne live card per game. `/game start` posts it; the buttons on it — and every other command — update that same card. No channel spam.',
        ),
        sep(1),
        text(
          '**▶️ Run a game**\n' +
            '`/game start` — @ the pod (2–6 players, 1v1 included), optional bracket. Posts the live card and starts a timer.\n' +
            '🧙 **Set commander** — pick a recent deck or search by name (typos are fine). Its art appears on the card. `/commander` does the same by keyboard, with `partner` for Partner / Background / Friends Forever.\n' +
            '🏁 **Report result** — pick who finished 1st, 2nd… or switch to winner-only / draw, then confirm. `/game report` by keyboard.\n' +
            '🗑️ **Cancel game** — abort; nothing counts.',
        ),
        sep(1),
        text(
          '**🔧 Fix things**\n' +
            '`/game bracket` — set or correct the bracket mid-game or after reporting.\n' +
            '`/undo` — revert the most recent completed game (players or admins).',
        ),
        sep(1),
        text(
          '**📊 The ladder**\n' +
            '`/leaderboard` — ranking by SR, with form and movement.\n' +
            "`/stats` — your (or anyone's) profile: rank, SR trend, placements, brackets, rivals, commanders, badges.\n" +
            '`/vs` — head-to-head between two players.\n' +
            '`/meta` — the commander meta.  `/history` — recent games.  `/predict` — win odds for the pod in progress.',
        ),
        sep(1),
        text(
          '**🎯 How rating works**\n' +
            '**SR** is your rank — a TrueSkill number that handles free-for-all pods and models uncertainty. Fresh players start near **500** and move fast until the system is confident, then settle — but never freeze: every game keeps ratings in motion, and a player who sits out for more than a week gets **rusty** 🦀 (uncertainty grows, so their next games move them faster, up or down). Beating a stronger pod is worth more than beating a weaker one.',
        ),
        sep(1),
        text('**🛠️ Admins** `/config digest-channel #channel` — a weekly ladder digest, Mondays. `/config digest-off` stops it.'),
        row(button(ButtonStyle.SECONDARY, 'Show the ladder', encodeId('lb', 'page', 1), { emoji: '🏆' })),
      ),
    ],
  };
}
