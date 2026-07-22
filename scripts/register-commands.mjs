// Registers the slash commands against ONE guild (instant propagation).
// Reads DISCORD_APP_ID, DISCORD_BOT_TOKEN, GUILD_ID from environment,
// falling back to the gitignored .dev.vars file.
//
// Usage: npm run register   (or: node scripts/register-commands.mjs)

import { readFileSync } from 'node:fs';

function loadDevVars() {
  try {
    const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const vars = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
      if (m) vars[m[1]] = m[2];
    }
    return vars;
  } catch {
    return {};
  }
}

const devVars = loadDevVars();
const APP_ID = process.env.DISCORD_APP_ID ?? devVars.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? devVars.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID ?? devVars.GUILD_ID;

if (!APP_ID || !TOKEN || !GUILD_ID) {
  console.error(
    'Missing config. Set DISCORD_APP_ID, DISCORD_BOT_TOKEN, GUILD_ID ' +
      '(env vars or in .dev.vars).',
  );
  process.exit(1);
}

const USER = 6;
const STRING = 3;
const BOOLEAN = 5;
const SUB = 1;

const bracketOption = {
  type: STRING,
  name: 'bracket',
  description: 'Agreed power bracket (default: open)',
  choices: [
    { name: 'Open', value: 'open' },
    { name: 'Bracket 1 — Exhibition', value: '1' },
    { name: 'Bracket 2 — Core', value: '2' },
    { name: 'Bracket 3 — Upgraded', value: '3' },
    { name: 'Bracket 4 — Optimized', value: '4' },
    { name: 'Bracket 5 — cEDH', value: '5' },
  ],
};

const playerSlot = (n, required) => ({
  type: USER,
  name: `player${n}`,
  description: `Player ${n} in the pod`,
  required,
});

const placeSlot = (name, label, required) => ({
  type: USER,
  name,
  description: label,
  required,
});

const commands = [
  {
    name: 'game',
    description: 'EDH pod games',
    contexts: [0],
    options: [
      {
        type: SUB,
        name: 'start',
        description: 'Start a game in this channel — a live timer begins',
        options: [
          playerSlot(1, true),
          playerSlot(2, true),
          playerSlot(3, false),
          playerSlot(4, false),
          playerSlot(5, false),
          playerSlot(6, false),
          bracketOption,
        ],
      },
      {
        type: SUB,
        name: 'report',
        description: "Report the active game's placements",
        options: [
          placeSlot('first', '1st place — the winner', true),
          placeSlot('second', '2nd place', true),
          placeSlot('third', '3rd place', false),
          placeSlot('fourth', '4th place', false),
          placeSlot('fifth', '5th place', false),
          placeSlot('sixth', '6th place', false),
          {
            type: BOOLEAN,
            name: 'winner_only',
            description: 'Only 1st counts — 2nd through last rated as tied',
          },
          {
            type: BOOLEAN,
            name: 'draw',
            description: 'Game was a draw (placement order is ignored)',
          },
        ],
      },
      {
        type: SUB,
        name: 'cancel',
        description: 'Abort the active game — nothing is recorded',
      },
      {
        type: SUB,
        name: 'bracket',
        description: "Set or correct the game's bracket mid-match (or after reporting)",
        options: [{ ...bracketOption, required: true }],
      },
    ],
  },
  {
    name: 'commander',
    description: "Log your commander for this channel's game",
    contexts: [0],
    options: [
      {
        type: STRING,
        name: 'name',
        description: 'Commander name (autocompletes from Scryfall)',
        required: true,
        autocomplete: true,
      },
      {
        type: STRING,
        name: 'partner',
        description: 'Second commander — Partner / Background / Friends Forever',
        autocomplete: true,
      },
    ],
  },
  { name: 'leaderboard', description: 'All-time ladder — SR, W-L, win%', contexts: [0] },
  {
    name: 'stats',
    description: 'Player profile: SR, placements, streak, commanders',
    contexts: [0],
    options: [
      { type: USER, name: 'player', description: 'Whose stats (default: you)' },
    ],
  },
  {
    name: 'vs',
    description: 'Head-to-head between two players',
    contexts: [0],
    options: [
      { type: USER, name: 'player_a', description: 'First player', required: true },
      { type: USER, name: 'player_b', description: 'Second player', required: true },
    ],
  },
  {
    name: 'undo',
    description: 'Revert the most recent completed game (participants/admins)',
    contexts: [0],
  },
  { name: 'help', description: 'How the EDH ladder works', contexts: [0] },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`,
  {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  },
);

if (!res.ok) {
  console.error(`Failed (${res.status}):`, JSON.stringify(await res.json(), null, 2));
  process.exit(1);
}
const registered = await res.json();
console.log(`✅ Registered ${registered.length} commands in guild ${GUILD_ID}:`);
for (const c of registered) console.log(`   /${c.name}`);
