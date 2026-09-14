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
| `/commander` | Log your commander for the game. Autocomplete is instant and typo-tolerant (`atraxa preators`, `urdragon`, `lim dul` all work) and its art appears on the card. Optional `partner` for Partner / Background / Friends Forever decks, stored as one deck identity. Confirms only to you. |
| `/game report` | Report placements (1st…Nth). Flags: `winner_only` (only 1st counts, rest tied), `draw` (placement ignored). Posts the final card with SR deltas for the whole pod plus a 📣 block — rank changes, streaks, upsets, milestones — and stops the live timer. |
| `/game bracket` | Set or correct the game's bracket mid-match, or after reporting. |
| `/game cancel` | Abort the active game. Nothing is recorded. |
| `/undo` | Revert the most recent completed game and restore every player's exact prior rating. Participants and admins only. |
| `/leaderboard` | The ladder: SR, record, win %, last-five form, ▲▼ movement since each player's last game. Paged with ◀ ▶. |
| `/stats` | Player profile: ladder rank, SR with a sparkline, placement spread, streak and form, record by bracket, nemesis and favourite victim, commanders (with art), badges. |
| `/vs` | Head-to-head between two players. |
| `/meta` | The commander meta: games, wins, win %, average finish and pilot count per commander (3+ games). Paginated. |
| `/history` | Recent games — winner and their commander, pod size, bracket, length. Optional `player` filter. Paginated. |
| `/predict` | Win odds for the pod in progress, from everyone's rating, plus a match-quality score. |
| `/config digest-channel` | Admins: post a weekly ladder digest (games, most active, biggest climber, commander of the week, top 3) to a channel every Monday. `/config digest-off` stops it. |
| `/help` | In-Discord cheatsheet. |

The **live match card** is the centrepiece: `/game start` posts one message with three
buttons — **🧙 Set commander**, **🏁 Report result**, **🗑️ Cancel game** — and every
button and every command edits that same message instead of posting new ones. Set commander
offers your recent decks first, then a typo-tolerant search; Report result walks the pod
through 1st, 2nd, 3rd… (or winner-only / draw) with a select menu and a Confirm. Follow-ups
reply to you privately (ephemerally) — the card carries the news for the channel.

### Ratings, briefly

**SR** is the ranking number, derived from TrueSkill's conservative estimate:

```
SR = round((μ − 3σ) × 40 + 500)
```

A fresh player (μ 25, σ 8.33) starts near 500. Early games move SR quickly because the
system is resolving *uncertainty* (σ shrinking), not because the player improved — this is
expected and settles down. Beating a stronger pod moves SR more than beating a weaker one.
SR is the only rating; there is no second number to reconcile.

Two things keep a closed group's ladder from freezing (see
[ARCHITECTURE.md → Rating dynamics](ARCHITECTURE.md#rating-dynamics)):

- **Motion.** Uncertainty never collapses to nothing, so a settled player's 4-pod win is
  still worth about +45 SR, not +6.
- **Rust 🦀.** Sit out for more than a week and your uncertainty grows again — roughly
  −50 SR at two weeks, −135 at a month — so your next games move you faster. One good night
  repairs a month away. The 📣 block on the report says when rust applied.

Every knob lives in `src/ratings/config.ts`. After changing one, `npm run recompute-ratings`
replays the whole history under the new numbers (dry run by default; `-- --apply` takes a
backup first, then writes).

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
npx wrangler d1 create edh-ladder
```

That prints a `database_id`. Copy the example config and paste it in:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Open `wrangler.jsonc` and replace `PASTE_YOUR_DATABASE_ID_HERE` with the id you were given.
`wrangler.jsonc` is gitignored, so your database id never lands in a commit.

Now create the tables and load the commander index (every commander-legal card, pulled
from Scryfall — about 3,400 rows, a minute of paging):

```bash
npx wrangler d1 execute edh-ladder --remote --file schema.sql
npm run sync-commanders
```

The index is what makes `/commander` autocomplete instant and typo-tolerant. Re-run
`npm run sync-commanders` after a new set releases (monthly is plenty); until you do, brand-new
commanders simply fall back to a live Scryfall lookup. The sync is a script rather than a Worker
cron because the Workers Free plan's 10 ms CPU budget cannot parse a Scryfall page.

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
npx wrangler d1 export edh-ladder --remote --output=backup.sql
npx wrangler d1 execute edh-ladder --remote --file migrations/0001_live_card.sql
npx wrangler d1 execute edh-ladder --remote --file migrations/0002_drop_elo.sql
npx wrangler d1 execute edh-ladder --remote --file migrations/0003_commander_index.sql
npm run sync-commanders            # fill the new commander index
npm run backfill-commanders        # report historical names the index spells differently
npx wrangler d1 execute edh-ladder --remote --file migrations/0004_dynamics.sql
npm run recompute-ratings          # dry run: shows every player's SR before/after
npm run recompute-ratings -- --apply
```

`recompute-ratings` replays every completed game through the current rating engine (the
same code the Worker runs) so history adopts the rust + motion dynamics instead of only
future games. It refuses to run while a game is active and takes a `wrangler d1 export`
into `backups/` before writing. Tell the pod: every SR in the channel scrollback becomes
history at that point.

Finish or cancel any game in progress before deploying: the new live card uses Discord's
Components V2, and a card posted by the previous version cannot be edited into the new
shape (the bot reposts a fresh card for that game instead).

`backfill-commanders` only reports by default. It lists the stored names it would re-link
(exact or unambiguous index matches) and the ones it refuses to guess at; re-run with
`-- --apply` to write the confident ones. Then set the `DISCORD_BOT_TOKEN` secret (step 3) if
you have not already, and redeploy.

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

# 2. Create the local database (separate from your deployed one) and fill its commander index
npx wrangler d1 execute edh-ladder --local --file schema.sql
npm run sync-commanders -- --local

# 3. Start the dev server with that public key
npx wrangler dev --port 8787 --var DISCORD_PUBLIC_KEY:<hex-from-step-1>

# 4. In a second terminal, run the end-to-end checks
node scripts/local-smoke.mjs run
```

That exercises signature rejection, PING/PONG, starting a game, the card's buttons (report
picker, cancel confirm, commander modal), duplicate-game rejection, reporting, typo-tolerant
commander autocomplete, the readouts, the digest cron, and `/help`.

### Project layout

```
src/
  index.ts          Worker entry: signature verification, payload parsing, dispatch
  router.ts         Command registry — the inline/deferred + ephemeral split
  types.ts          Discord payload and database row types
  validation.ts     Pure validation and permission predicates (no I/O)
  commanders/       Local commander index: pure tiered search, aliases, Scryfall page parser
  scryfall.ts       Live Scryfall lookups — the fallback while the index is empty
  commands/         One module per command surface
  services/         reportGame — the single write path for finishing a game
  engagement/       Shoutouts, badges and the weekly digest (pure) + the cron poster
  db/               D1 queries and rating snapshot handling
  ratings/          TrueSkill (SR), the tunables, rust, /predict
  discord/          API calls, Components V2 builders, the live card, readouts, custom-id grammar
  flows/            Button / select / modal handlers: set commander, report, cancel, paging
test/               Vitest unit tests
scripts/            Command registration, index sync/backfill, rating recompute, doctor, smoke tests
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

**"I couldn't update the pod card" on every `/commander`.**
Run `npm run doctor -- <pod channel id>` (Developer Mode → right-click the channel → Copy
Channel ID). It uses the `.dev.vars` token to check, in order: the token is valid, it belongs
to `DISCORD_APP_ID`, the bot is a member of `GUILD_ID`, whether any of its roles carries
**Administrator**, and whether it can see that channel. A `403 Missing Access` on the last
step means the channel (or its category) is private and the bot isn't on its permission list;
a role with every box ticked is *not* Administrator and does not bypass channel overrides.
If every check passes, the deployed Worker's `DISCORD_BOT_TOKEN` secret differs from
`.dev.vars` — re-push it (from Git Bash, not PowerShell).

**Commands don't appear in Discord.**
`npm run register` registers to the single server in `GUILD_ID`. Confirm that id is your
server, that the bot was invited with the `applications.commands` scope, and try fully
restarting your Discord client.

**"Run this in a server channel."**
The bot is guild-only; every command needs server context. It does not work in DMs.

**`/commander` stores the name I typed instead of the real card.**
Nothing in the index matched, even allowing for typos, and the live Scryfall fallback did not
recognise it either. The reply says so; re-running `/commander` and picking from autocomplete
overwrites it. If autocomplete itself is empty, the index has not been synced —
`npm run sync-commanders`.

**`/commander` picked the wrong card for a short name.**
Several commanders share a short name (`atraxa`, `urza`). The bot takes the most-played one
and lists the others in its reply; re-run with the full name from autocomplete.

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
