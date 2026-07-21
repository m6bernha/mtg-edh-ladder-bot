// Local end-to-end smoke test against `wrangler dev`, using a throwaway
// Ed25519 keypair to sign requests exactly like Discord does.
//
//   node scripts/local-smoke.mjs keygen   → writes .smoke-keys.json, prints public hex
//   node scripts/local-smoke.mjs run      → fires signed interactions at :8787
//
// Start the dev server between the two steps:
//   npx wrangler dev --port 8787 --var DISCORD_PUBLIC_KEY:<hex from keygen>

import { createPrivateKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const KEYS_FILE = new URL('../.smoke-keys.json', import.meta.url);
const BASE = 'http://127.0.0.1:8787';

const mode = process.argv[2];

if (mode === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const publicHex = Buffer.from(jwk.x, 'base64url').toString('hex');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(KEYS_FILE, JSON.stringify({ publicHex, privatePem }));
  console.log(publicHex);
  process.exit(0);
}

if (mode !== 'run') {
  console.error('usage: local-smoke.mjs keygen|run');
  process.exit(1);
}

const { privatePem } = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
const privateKey = createPrivateKey(privatePem);

async function post(payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = edSign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body,
  });
  return { status: res.status, json: res.status === 200 ? await res.json() : await res.text() };
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.error(`  ❌ ${label} — ${JSON.stringify(detail)}`);
  }
}

const user = (id, name) => ({ id, username: name, global_name: name });
const baseInteraction = {
  id: '1',
  token: 'smoke-token',
  application_id: '000000000000000000',
  guild_id: 'smoke-guild',
  channel_id: 'smoke-channel',
  member: { user: user('u1', 'Alice'), permissions: '8' },
};

// 1. Unsigned request is rejected
{
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 1 }),
  });
  check('unsigned request → 401', res.status === 401, res.status);
}

// 2. Signed PING → PONG (this is Discord's endpoint-verification handshake)
{
  const r = await post({ type: 1 });
  check('signed PING → PONG', r.status === 200 && r.json.type === 1, r);
}

// 3. /game start (inline path: validation, D1 upserts, embed)
const startPayload = {
  ...baseInteraction,
  type: 2,
  data: {
    name: 'game',
    options: [
      {
        type: 1,
        name: 'start',
        options: [
          { type: 6, name: 'player1', value: 'u1' },
          { type: 6, name: 'player2', value: 'u2' },
          { type: 6, name: 'player3', value: 'u3' },
          { type: 3, name: 'bracket', value: '3' },
        ],
      },
    ],
    resolved: { users: { u1: user('u1', 'Alice'), u2: user('u2', 'Bob'), u3: user('u3', 'Cara') } },
  },
};
{
  const r = await post(startPayload);
  check(
    '/game start → embed + pings',
    r.status === 200 &&
      r.json.type === 4 &&
      r.json.data?.embeds?.[0]?.title?.includes('pod started') &&
      r.json.data?.content?.includes('<@u2>'),
    r,
  );
}

// 4. Second /game start in same channel → friendly error
{
  const r = await post(startPayload);
  check(
    'duplicate /game start → rejected',
    r.status === 200 &&
      r.json.type === 4 &&
      r.json.data?.embeds?.[0]?.description?.includes('already an active game'),
    r,
  );
}

// 5. /game report → deferred ack (rating math runs in waitUntil)
{
  const r = await post({
    ...baseInteraction,
    type: 2,
    data: {
      name: 'game',
      options: [
        {
          type: 1,
          name: 'report',
          options: [
            { type: 6, name: 'first', value: 'u2' },
            { type: 6, name: 'second', value: 'u1' },
            { type: 6, name: 'third', value: 'u3' },
          ],
        },
      ],
    },
  });
  check('/game report → deferred ack', r.status === 200 && r.json.type === 5, r);
}

// 6. commander autocomplete → choices from Scryfall (or empty on timeout)
{
  const r = await post({
    ...baseInteraction,
    type: 4,
    data: {
      name: 'commander',
      options: [{ type: 3, name: 'name', value: 'atraxa', focused: true }],
    },
  });
  const choices = r.json?.data?.choices;
  check(
    'autocomplete → type 8 with choices array',
    r.status === 200 && r.json.type === 8 && Array.isArray(choices),
    r,
  );
  if (Array.isArray(choices) && choices.length > 0) {
    console.log(`     ↳ scryfall live: ${choices.length} results, first: ${choices[0].name}`);
  } else {
    console.log('     ↳ scryfall returned no results (timeout is tolerated by design)');
  }
}

// 7. /help inline
{
  const r = await post({ ...baseInteraction, type: 2, data: { name: 'help' } });
  check(
    '/help → embed',
    r.status === 200 && r.json.type === 4 && r.json.data?.embeds?.[0]?.title?.includes('EDH Ladder'),
    r,
  );
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
