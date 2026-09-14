// Local end-to-end smoke test against `wrangler dev`, using a throwaway
// Ed25519 keypair to sign requests exactly like Discord does.
//
//   node scripts/local-smoke.mjs keygen   → writes .smoke-keys.json, prints public hex
//   node scripts/local-smoke.mjs run      → fires signed interactions at :8787
//
// Start the dev server between the two steps:
//   npx wrangler dev --port 8787 --test-scheduled --var DISCORD_PUBLIC_KEY:<hex from keygen>

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
const V2 = 1 << 15;
const flat = (components) =>
  (components ?? []).flatMap((c) => [c, ...flat(c.components), ...(c.accessory ? [c.accessory] : [])]);
const texts = (data) => flat(data?.components).filter((c) => c.type === 10).map((c) => c.content).join('\n');
const ids = (data) => flat(data?.components).map((c) => c.custom_id).filter(Boolean);

let gameId = null;
{
  const r = await post(startPayload);
  check(
    '/game start → V2 live card + pings + buttons',
    r.status === 200 &&
      r.json.type === 4 &&
      (r.json.data?.flags & V2) === V2 &&
      texts(r.json.data).includes('in progress') &&
      texts(r.json.data).includes('<@u2>') &&
      r.json.data?.allowed_mentions?.users?.includes('u2') &&
      ids(r.json.data).some((id) => id.startsWith('rep:open:')),
    r,
  );
  gameId = Number((ids(r.json.data).find((id) => id.startsWith('rep:open:')) ?? '').split(':')[2]);
}

// 3b. Card buttons — signed MESSAGE_COMPONENT / MODAL_SUBMIT interactions
const component = (custom_id, extra = {}) => ({
  ...baseInteraction,
  type: 3,
  message: { id: 'smoke-msg' },
  data: { custom_id, component_type: 2, ...extra },
});
{
  let r = await post(component(`rep:open:${gameId}`));
  check(
    'Report button → ephemeral V2 picker',
    r.status === 200 && r.json.type === 4 && (r.json.data?.flags & 64) === 64 && (r.json.data?.flags & V2) === V2 &&
      ids(r.json.data).includes(`rep:pick:${gameId}:f:-`),
    r,
  );
  r = await post(component(`rep:pick:${gameId}:f:-`, { component_type: 3, values: ['1'] }));
  check(
    'Pick 1st → UPDATE_MESSAGE with the draft advanced',
    r.status === 200 && r.json.type === 7 && ids(r.json.data).includes(`rep:pick:${gameId}:f:1`),
    r,
  );
  r = await post(component(`rep:mode:${gameId}:d`));
  check(
    'Draw mode → confirm enabled',
    r.status === 200 && r.json.type === 7 && ids(r.json.data).includes(`rep:confirm:${gameId}:d:-`),
    r,
  );
  r = await post(component(`cxl:ask:${gameId}`));
  check('Cancel button → ephemeral confirm', r.status === 200 && r.json.type === 4 && ids(r.json.data).includes(`cxl:yes:${gameId}`), r);
  r = await post(component(`cxl:no:${gameId}`));
  check('Keep playing → UPDATE_MESSAGE', r.status === 200 && r.json.type === 7, r);
  r = await post(component(`cmd:open:${gameId}`));
  check(
    'Set commander (no recent decks) → modal',
    r.status === 200 && (r.json.type === 9 ? r.json.data?.custom_id === `cmd:modal:${gameId}` : r.json.type === 4),
    r,
  );
  r = await post({ ...baseInteraction, type: 5, data: { custom_id: `cmd:modal:${gameId}`, components: [{ type: 18, component: { type: 4, custom_id: 'q', value: 'atraxa preators' } }] } });
  check('Modal submit → deferred ephemeral reply', r.status === 200 && r.json.type === 5 && (r.json.data?.flags & 64) === 64, r);
  r = await post(component('nope:what:1'));
  check('Unknown button → ephemeral refusal, not a crash', r.status === 200 && r.json.type === 4 && (r.json.data?.flags & 64) === 64, r);
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

// 6. commander autocomplete → choices from the local index (or Scryfall while it is empty)
async function autocomplete(value) {
  const r = await post({
    ...baseInteraction,
    type: 4,
    data: {
      name: 'commander',
      options: [{ type: 3, name: 'name', value, focused: true }],
    },
  });
  return { r, choices: r.json?.data?.choices };
}
{
  const { r, choices } = await autocomplete('atraxa');
  check(
    'autocomplete → type 8 with choices array',
    r.status === 200 && r.json.type === 8 && Array.isArray(choices),
    r,
  );
  if (Array.isArray(choices) && choices.length > 0) {
    console.log(`     ↳ ${choices.length} results, first: ${choices[0].name} (value "${choices[0].value}")`);
  } else {
    console.log('     ↳ no results (empty index + Scryfall timeout is tolerated by design)');
  }
  // Second call hits the warmed in-memory index; a typo must still find the card
  // when the index is synced (`npm run sync-commanders -- --local`).
  const typo = await autocomplete('atraxa preators');
  const hit = typo.choices?.some((c) => c.value === "Atraxa, Praetors' Voice");
  console.log(
    hit
      ? "     ↳ typo-tolerant: 'atraxa preators' → Atraxa, Praetors' Voice"
      : '     ↳ typo lookup found nothing — local index not synced? (not a failure)',
  );
}

// 7. Readouts and settings — all deferred acks (the bodies land via webhook, out of reach here).
{
  const deferred = async (label, data, ephemeral = false) => {
    const r = await post({ ...baseInteraction, type: 2, data });
    check(
      `${label} → deferred ack${ephemeral ? ' (ephemeral)' : ''}`,
      r.status === 200 && r.json.type === 5 && (!ephemeral || (r.json.data?.flags & 64) === 64),
      r,
    );
  };
  await deferred('/meta', { name: 'meta' });
  await deferred('/history', { name: 'history', options: [{ type: 4, name: 'page', value: 1 }] });
  await deferred('/predict', { name: 'predict' });
  await deferred(
    '/config digest-channel',
    { name: 'config', options: [{ type: 1, name: 'digest-channel', options: [{ type: 7, name: 'channel', value: 'smoke-channel' }] }] },
    true,
  );
}

// 8. Cron: the weekly digest handler (needs `wrangler dev --test-scheduled`)
{
  const res = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=0+18+*+*+1`);
  if (res.status === 200) console.log('  ✅ scheduled handler ran (digest)');
  else console.log(`  ↳ scheduled endpoint returned ${res.status} — start wrangler dev with --test-scheduled to exercise it`);
}

// 9. /help inline
{
  const r = await post({ ...baseInteraction, type: 2, data: { name: 'help' } });
  check(
    '/help → V2 container',
    r.status === 200 && r.json.type === 4 && (r.json.data?.flags & V2) === V2 && texts(r.json.data).includes('EDH Ladder'),
    r,
  );
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
