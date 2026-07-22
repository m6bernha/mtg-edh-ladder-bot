# MTG EDH Ladder

[![CI](https://github.com/m6bernha/mtg-edh-ladder-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/m6bernha/mtg-edh-ladder-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A competitive ranked ladder for Magic: The Gathering **Commander/EDH** pods, run entirely
from Discord slash commands. Start a pod and it posts **one live match card** that updates
itself as you log commanders, set the bracket, and report the result — no channel spam.
Every player's rating updates instantly, with an Xbox-Live-style SR number, per-commander
stats and artwork, head-to-head records, and an exact undo.

Built as a single [Cloudflare Worker](https://developers.cloudflare.com/workers/) backed
by [D1](https://developers.cloudflare.com/d1/). No server to run, no container to keep
alive, and it fits comfortably inside Cloudflare's free tier.

> **This is not a hosted service.** There is no public invite link. You deploy your own
> instance to your own Cloudflare account, which means you own your data outright. The
> [Self-hosting](#self-hosting) guide below walks through it from nothing.

---

## Why it exists

Commander is a multiplayer format, and multiplayer breaks most rating systems. Elo assumes
two players. "Winner takes all" throws away the information in 2nd vs 4th place. Tracking
it in a spreadsheet means somebody has to maintain the spreadsheet.

This runs the ladder where the games are already being discussed, and rates pods properly:

- **TrueSkill** handles free-for-all pods natively and models *uncertainty*, so a new
  player converges quickly instead of grinding through provisional games. It's the same
  family of system Xbox Live uses to match players — one number, **SR**, does the ranking.
- Everything derivable — win rate, streaks, form, placement spread — is computed from game
  history rather than stored, so no counter can drift out of sync with reality.

The design decisions behind all of this are written up in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Commands

| Command | What it does |
|---|---|
| `/game start` | Start a game in this channel: `@` the pod (2–6 players — 1v1 works too), optional bracket. Posts the live match card; a relative timer ticks on it. |
| `/commander` | Log your commander for the game, with Scryfall autocomplete — its art appears on the card. Optional `partner` for Partner / Background / Friends Forever decks, stored as one deck identity. Confirms only to you. |
| `/game report` | Report placements (1st…Nth). Flags: `winner_only` (only 1st counts, rest tied), `draw` (placement ignored). Posts the final card with SR deltas for the whole pod, and stops the live timer. |
| `/game bracket` | Set or correct the game's bracket mid-match, or after reporting. |
| `/game cancel` | Abort the active game. Nothing is recorded. |
| `/undo` | Revert the most recent completed game and restore every player's exact prior rating. Participants and admins only. |
| `/leaderboard` | All-time ladder: SR, W–L, win %. |
| `/stats` | Player profile: SR, placement spread, current streak, recent form, commanders. |
| `/vs` | Head-to-head between two players. |
| `/help` | In-Discord cheatsheet. |

The **live match card** is the centrepiece: `/game start` posts one message, and
`/commander`, `/game bracket`, `/game report` and `/game cancel` all edit that same message
instead of posting new ones. Follow-up commands reply to you privately (ephemerally) — the
card carries the news for the channel.

### Ratings, briefly

**SR** is the ranking number, derived from TrueSkill's conservative estimate:

```
SR = round((μ − 3σ) × 40 + 500)
```

A fresh player (μ 25, σ 8.33) starts near 500. Early games move SR quickly because the
system is resolving *uncertainty* (σ shrinking), not because the player improved — this is
expected and settles down. Beating a stronger pod moves SR more than beating a weaker one.
SR is the only rating; there is no second number to reconcile.

Brackets follow the official Commander bracket system (Open, 1 Exhibition → 5 cEDH) and are
recorded per game.

---

## Self-hosting

Roughly 15 minutes. You need a [Cloudflare account](https://dash.cloudflare.com/sign-up)
(free tier is fine), a [Discord account](https://discord.com/developers/applications) with
permission to add a bot to your server, and [Node.js](https://nodejs.org/) 20 or newer.

Every command below is run from the project directory.

### 1. Get the code

```bash
git clone https://github.com/m6bernha/mtg-edh-ladder-bot.git
cd mtg-edh-ladder-bot
npm install
```

### 2. Create the database

```bash
npx wrangler login                              # opens a browser to authorise Cloudflare
npx wrangler d1 create mtg-edh-ladder-bot
```

That prints a `database_id`. Copy the example config and paste it in:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Open `wrangler.jsonc` and replace `PASTE_YOUR_DATABASE_ID_HERE` with the id you were given.
`wrangler.jsonc` is gitignored, so your database id never lands in a commit.

Now create the tables:

```bash
npx wrangler d1 execute mtg-edh-ladder-bot --remote --file schema.sql
```

### 3. Create the Discord application

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click
**New Application**. From the application page you need three values:

| Value | Where to find it |
|---|---|
| **Application ID** | General Information |
| **Public Key** | General Information |
| **Bot Token** | Bot → Reset Token. Shown **once** — copy it immediately. |

The Worker needs **two** secrets. The Public Key proves requests genuinely came from
Discord; the Bot Token lets the Worker edit each game's live card long after Discord's
15-minute interaction window has closed. Set both:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
```

Paste the matching value when prompted for each. (The Bot Token is used in two places — here
as a Worker secret, and locally by the command-registration script in step 5.)

### 4. Deploy

```bash
npm run deploy
```

Wrangler prints your Worker URL, something like
`https://mtg-edh-ladder-bot.your-name.workers.dev`. Visit it in a browser — it should
respond `MTG EDH Ladder is up ⚔️`.

Back in the Developer Portal, on **General Information**, set **Interactions Endpoint URL**
to that URL and save. Discord immediately sends a signed test request; saving only succeeds
if signature verification is working, so a successful save means the hard part is done.

### 5. Register the slash commands

Commands are registered to one server so they appear instantly, rather than globally where
propagation can take up to an hour.

You'll need your server's ID: in Discord, enable **Settings → Advanced → Developer Mode**,
then right-click your server icon and **Copy Server ID**.

```bash
cp .dev.vars.example .dev.vars
```

Fill in `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, and `GUILD_ID`, then:

```bash
npm run register
```

`.dev.vars` is gitignored and is only used by this script — the deployed Worker never
reads it.

### 6. Invite the bot

In the Developer Portal under **OAuth2 → URL Generator**, tick the scopes
`applications.commands` and `bot`. Under **Bot Permissions**, tick **View Channels** and
**Send Messages** — the bot needs them to post and edit the live match card in your pod
channels. Open the generated URL and add it to your server.

Type `/help` in any channel to confirm it's alive.

### Upgrading an existing deployment

A brand-new install applies `schema.sql` (step 2) and is already up to date. If you have an
earlier deployment with game data, apply the migrations in `migrations/` in order instead —
back up first, since dropping the old Elo columns is irreversible:

```bash
npx wrangler d1 export mtg-edh-ladder-bot --remote --output=backup.sql
npx wrangler d1 execute mtg-edh-ladder-bot --remote --file migrations/0001_live_card.sql
npx wrangler d1 execute mtg-edh-ladder-bot --remote --file migrations/0002_drop_elo.sql
```

Then set the new `DISCORD_BOT_TOKEN` secret (step 3) and redeploy.

---

## Development

```bash
npm install
npm test          # vitest — rating math, validation, payload parsing, undo snapshots
npm run check     # tsc --noEmit
npm run tail      # stream live logs from the deployed Worker
```

### Running locally

The bot verifies an Ed25519 signature on every request, so you cannot simply `curl` it. The
smoke script generates a throwaway keypair and sends correctly signed interactions.

```bash
# 1. Generate a throwaway keypair — prints a public key
node scripts/local-smoke.mjs keygen

# 2. Create the local database (separate from your deployed one)
npx wrangler d1 execute mtg-edh-ladder-bot --local --file schema.sql

# 3. Start the dev server with that public key
npx wrangler dev --port 8787 --var DISCORD_PUBLIC_KEY:<hex-from-step-1>

# 4. In a second terminal, run the end-to-end checks
node scripts/local-smoke.mjs run
```

That exercises signature rejection, PING/PONG, starting a game, duplicate-game rejection,
reporting, Scryfall autocomplete, and `/help`.

### Project layout

```
src/
  index.ts          Worker entry: signature verification, payload parsing, dispatch
  router.ts         Command registry — the inline/deferred + ephemeral split
  types.ts          Discord payload and database row types
  validation.ts     Pure validation and permission predicates (no I/O)
  scryfall.ts       Commander autocomplete, canonicalisation, and art, cached
  commands/         One module per command surface
  db/               D1 queries and rating snapshot handling
  ratings/          TrueSkill (SR)
  discord/          API calls, embeds, and the live match card (card.ts, live-card.ts)
test/               Vitest unit tests
scripts/            Command registration and signed end-to-end smoke tests
schema.sql          Database schema (post-migration shape, for fresh installs)
migrations/         Ordered ALTER migrations for existing deployments
assets/             Bot avatar
```

---

## Troubleshooting

**Saving the Interactions Endpoint URL fails.**
Discord sends a signed PING and requires a valid response. Check that
`npx wrangler secret put DISCORD_PUBLIC_KEY` used the **Public Key** from General
Information — not the bot token, and not the Application ID. Re-run it if unsure, then
`npm run deploy` again.

**Commands don't appear in Discord.**
`npm run register` registers to the single server in `GUILD_ID`. Confirm that id is your
server, that the bot was invited with the `applications.commands` scope, and try fully
restarting your Discord client.

**"Run this in a server channel."**
The bot is guild-only; every command needs server context. It does not work in DMs.

**`/commander` stores the name I typed instead of the real card.**
Scryfall lookups have a hard timeout so the bot always answers within Discord's deadline.
On a timeout it stores your text verbatim and says so. Re-running `/commander` overwrites it.

**Ratings look wrong after a misreport.**
`/undo` reverts the most recent completed game exactly, restoring every player's prior
rating from the snapshot taken at report time. Only the newest game can be undone — see
[ARCHITECTURE.md](ARCHITECTURE.md#undo) for why.

---

## Contributing

Issues and pull requests are welcome. Please make sure `npm run check` and `npm test` pass;
CI runs both, plus `npm audit`, on every pull request.

## License

[MIT](LICENSE) © Matthias Bernhard
