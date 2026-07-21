# edh-ladder

FaceIt-style ranked ladder Discord bot for an EDH/Commander friend group playing in
Tabletop Simulator. Serverless: Cloudflare Workers (HTTP interactions) + D1. $0/month.

## Commands

| Command | What it does |
|---|---|
| `/game start` | Start a game in this channel: @ the pod (3-6 players), optional bracket. Live timer starts. |
| `/commander` | Optionally log your commander for the game (Scryfall autocomplete). |
| `/game report` | Report placements (1st..Nth). Flags: `winner_only`, `draw`. Updates both ratings instantly. |
| `/game cancel` | Abort the active game. |
| `/undo` | Revert the most recent completed game (participants/admins). |
| `/leaderboard` | All-time ladder: SR, Elo, W-L, win%. |
| `/stats` | Profile: ratings, placement spread, streak, form, commanders. |
| `/vs` | Head-to-head between two players. |
| `/help` | Cheatsheet. |

**Ratings**: SR is TrueSkill (μ − 3σ, scaled — the real ranking). Elo is classic
pairwise multiplayer Elo starting at 1000. Rating snapshots are stored per game, which
is what makes `/undo` exact.

## Development

```bash
npm install
npm test            # vitest: rating math, validation, undo snapshots
npm run check       # tsc --noEmit

# local end-to-end smoke (signed interactions against wrangler dev):
node scripts/local-smoke.mjs keygen        # prints a throwaway public key
npx wrangler d1 execute edh-ladder --local --file schema.sql
npx wrangler dev --port 8787 --var DISCORD_PUBLIC_KEY:<hex>
node scripts/local-smoke.mjs run           # in a second terminal
```

## Deploy (from zero)

1. Cloudflare account → `npx wrangler login`.
2. `npx wrangler d1 create edh-ladder` → paste `database_id` into `wrangler.jsonc`,
   then `npx wrangler d1 execute edh-ladder --remote --file schema.sql`.
3. Discord app at <https://discord.com/developers/applications> → copy Application ID
   + Public Key (General Information) and Bot Token (Bot tab).
4. `npx wrangler secret put DISCORD_PUBLIC_KEY` (the worker's only secret).
5. `npm run deploy` → set the worker URL as the app's **Interactions Endpoint URL**.
6. Create `.dev.vars` (gitignored) with `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`,
   `GUILD_ID`, then `npm run register`.
7. OAuth2 URL Generator: scopes `applications.commands` + `bot`, permissions 0 →
   invite to the server.
