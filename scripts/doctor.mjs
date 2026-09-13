// Diagnoses "I couldn't update the pod card" without guesswork. Uses the bot
// token from .dev.vars (or env) to ask Discord the questions that matter, in
// the order they eliminate causes:
//
//   1. Is the token valid, and which bot user / application is it?  (401 = stale token)
//   2. Does that application match DISCORD_APP_ID?                    (token from another app)
//   3. Is the bot user a member of GUILD_ID, and with which roles?    (invited without `bot` scope)
//   4. Does any of its roles carry Administrator?                     (no -> channel overrides apply)
//   5. Can it see the given channel?                                  (403 50001 = Missing Access)
//
// Usage: npm run doctor -- <channel id>      (right-click the pod channel -> Copy Channel ID)
//        npm run doctor                       (skips step 5)
//
// Never prints the token. Note this checks the token in .dev.vars; the deployed
// Worker uses the wrangler secret, which must hold the same value.

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
const CHANNEL_ID = process.argv[2];

if (!APP_ID || !TOKEN || !GUILD_ID) {
  console.error('Missing config. Set DISCORD_APP_ID, DISCORD_BOT_TOKEN, GUILD_ID (env vars or in .dev.vars).');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;

async function get(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bot ${TOKEN}`,
      'User-Agent': 'DiscordBot (https://github.com/m6bernha/mtg-edh-ladder-bot, 1.0)',
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const ok = (s) => console.log(`  ✔ ${s}`);
const bad = (s) => console.log(`  ✘ ${s}`);
let failed = false;

// 1. Token identity
console.log('1. Token');
const me = await get('/users/@me');
if (me.status !== 200) {
  bad(`Discord rejected the token: ${me.status} ${JSON.stringify(me.body)}`);
  if (me.status === 401) console.log('    -> stale/corrupted token. Reset it in the Dev Portal, update .dev.vars AND the wrangler secret.');
  process.exit(1);
}
ok(`valid — bot user "${me.body.username}" (id ${me.body.id})`);

// 2. Application match
console.log('2. Application');
const app = await get('/oauth2/applications/@me');
if (app.status === 200 && app.body.id !== APP_ID) {
  bad(`token belongs to application ${app.body.id} ("${app.body.name}") but DISCORD_APP_ID is ${APP_ID}`);
  console.log('    -> the Worker is editing cards as a DIFFERENT bot than the one whose commands run. Use that app\'s token.');
  failed = true;
} else if (app.status === 200) {
  ok(`matches DISCORD_APP_ID ("${app.body.name}")`);
} else {
  console.log(`  ? could not read application: ${app.status}`);
}

// 3. Guild membership + roles
console.log('3. Server membership');
const member = await get(`/guilds/${GUILD_ID}/members/${me.body.id}`);
if (member.status !== 200) {
  bad(`not a member of guild ${GUILD_ID}: ${member.status} ${JSON.stringify(member.body)}`);
  console.log('    -> re-invite with scopes `bot` + `applications.commands` (README step 6).');
  process.exit(1);
}
const roles = await get(`/guilds/${GUILD_ID}/roles`);
const mine = roles.status === 200 ? roles.body.filter((r) => member.body.roles.includes(r.id)) : [];
ok(`member of the server; roles: ${mine.map((r) => r.name).join(', ') || '(none beyond @everyone)'}`);

// 4. Administrator?
console.log('4. Permissions');
const everyone = roles.status === 200 ? roles.body.find((r) => r.id === GUILD_ID) : null;
const rolePerms = [everyone, ...mine].filter(Boolean).reduce((acc, r) => acc | BigInt(r.permissions), 0n);
const isAdmin = (rolePerms & ADMINISTRATOR) !== 0n;
if (isAdmin) {
  ok('a role carries Administrator — channel overrides cannot block the bot');
} else {
  console.log('  ! no role carries Administrator. Role-level grants:');
  console.log(`      View Channels ${rolePerms & VIEW_CHANNEL ? 'yes' : 'NO'}, Send Messages ${rolePerms & SEND_MESSAGES ? 'yes' : 'NO'}, Embed Links ${rolePerms & EMBED_LINKS ? 'yes' : 'NO'}`);
  console.log('    -> a private channel (or category) still overrides these. Either add the bot to that channel\'s permission list, or give its role Administrator.');
}

// 5. Channel visibility
if (CHANNEL_ID) {
  console.log(`5. Channel ${CHANNEL_ID}`);
  const ch = await get(`/channels/${CHANNEL_ID}`);
  if (ch.status === 200) {
    ok(`visible: #${ch.body.name} (type ${ch.body.type}${ch.body.parent_id ? `, under category ${ch.body.parent_id}` : ''})`);
    if (ch.body.guild_id && ch.body.guild_id !== GUILD_ID) bad(`that channel is in guild ${ch.body.guild_id}, not GUILD_ID ${GUILD_ID}`);
    const overwrites = (ch.body.permission_overwrites ?? []).filter((o) => o.id === me.body.id || member.body.roles.includes(o.id) || o.id === GUILD_ID);
    if (!isAdmin && overwrites.length) {
      console.log('    overrides that touch the bot:');
      for (const o of overwrites) {
        const who = o.id === me.body.id ? 'bot user' : o.id === GUILD_ID ? '@everyone' : mine.find((r) => r.id === o.id)?.name ?? o.id;
        const deny = BigInt(o.deny);
        const allow = BigInt(o.allow);
        console.log(`      ${who}: ${deny & VIEW_CHANNEL ? 'DENIES View Channel ' : ''}${deny & SEND_MESSAGES ? 'DENIES Send Messages ' : ''}${allow & VIEW_CHANNEL ? 'allows View Channel ' : ''}${allow & SEND_MESSAGES ? 'allows Send Messages' : ''}`.trimEnd());
      }
    }
  } else {
    bad(`cannot access it: ${ch.status} ${JSON.stringify(ch.body)}`);
    if (ch.body?.code === 50001) {
      console.log('    -> Missing Access reproduced. The bot cannot VIEW this channel.');
      // The guild channel list still returns the channel (with its overrides) even
      // when the bot cannot read it, so we can say exactly who is locked out.
      const all = await get(`/guilds/${GUILD_ID}/channels`);
      const hidden = all.status === 200 ? all.body.find((c) => c.id === CHANNEL_ID) : null;
      if (hidden) {
        const name = (o) => (o.id === me.body.id ? 'bot user' : o.id === GUILD_ID ? '@everyone' : roles.body?.find((r) => r.id === o.id)?.name ?? o.id);
        const overwrites = hidden.permission_overwrites ?? [];
        const everyoneDeniesView = overwrites.some((o) => o.id === GUILD_ID && BigInt(o.deny) & VIEW_CHANNEL);
        const botAllowed = overwrites.some((o) => (o.id === me.body.id || member.body.roles.includes(o.id)) && BigInt(o.allow) & VIEW_CHANNEL);
        console.log(`    #${hidden.name} overrides: ${overwrites.map((o) => `${name(o)} allow=${o.allow} deny=${o.deny}`).join('; ') || '(none)'}`);
        if (everyoneDeniesView && !botAllowed) {
          console.log(`    -> private channel: @everyone is denied View Channel and none of the bot's roles (${mine.map((r) => r.name).join(', ') || 'none'}) is allowed in.`);
          console.log(`       Fix: #${hidden.name} -> Edit Channel -> Permissions -> Add members or roles -> "${mine[mine.length - 1]?.name ?? 'EDH Ladder'}" -> allow View Channel + Send Messages + Embed Links.`);
        }
      } else {
        console.log('    -> Channel -> Edit -> Permissions -> add the bot (or its role) with View Channel + Send Messages, or give the role Administrator.');
      }
    }
    failed = true;
  }
} else {
  console.log('5. Channel check skipped — pass the pod channel id: npm run doctor -- <channel id>');
}

console.log(failed ? '\nSomething above needs fixing.' : '\nAll checks passed with the .dev.vars token. If the Worker still fails, its wrangler secret differs from .dev.vars — re-push it.');
process.exit(failed ? 1 : 0);
