import type { MessageData } from '../types';

const API = 'https://discord.com/api/v10';

// Discord sits behind Cloudflare, and its WAF silently rejects bot-authenticated
// REST calls that lack a proper `DiscordBot (...)` User-Agent — as bare 403s that
// look exactly like permission errors. Every Discord API fetch must send this.
// (Cost of learning this: one very long debugging night. See ARCHITECTURE.md.)
const USER_AGENT = 'DiscordBot (https://github.com/m6bernha/mtg-edh-ladder-bot, 1.0)';

const JSON_HEADERS = { 'content-type': 'application/json', 'User-Agent': USER_AGENT };

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Edit the deferred "thinking…" message via the interaction webhook (no bot token needed). */
export async function patchOriginal(
  applicationId: string,
  token: string,
  data: MessageData,
): Promise<void> {
  const res = await fetch(`${API}/webhooks/${applicationId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    console.error(`patchOriginal failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Read back the message a type-4 (inline) response just created, to learn its id.
 * A type-4 body does not return the message object, so this is the only way to
 * capture it. Uses the interaction token (no auth header), so it MUST run inside
 * the same request's ctx.waitUntil, before the 15-minute token expires.
 */
export async function fetchOriginalMessageId(
  applicationId: string,
  token: string,
): Promise<string | null> {
  const res = await fetch(`${API}/webhooks/${applicationId}/${token}/messages/@original`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    console.error(`fetchOriginalMessageId failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const msg = (await res.json()) as { id?: string };
  return msg.id ?? null;
}

/**
 * Edit any message by id with the bot token. Unlike the interaction webhook this
 * never expires, so it can update a game's live card an hour into the match.
 * Returns false on 403 (bot lost channel access) / 404 (card deleted) / network
 * error, so the caller can degrade — repost the card rather than fail silently.
 */
export async function editMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  data: MessageData,
): Promise<boolean> {
  try {
    const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, Authorization: `Bot ${botToken}` },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.error(`editMessage failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('editMessage threw:', e);
    return false;
  }
}

/**
 * Post a new message to a channel with the bot token, returning its id. Used to
 * (re)create a game's live card when no card exists yet or the old one is gone.
 */
export async function createMessage(
  botToken: string,
  channelId: string,
  data: MessageData,
): Promise<string | null> {
  try {
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Authorization: `Bot ${botToken}` },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.error(`createMessage failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const msg = (await res.json()) as { id?: string };
    return msg.id ?? null;
  } catch (e) {
    console.error('createMessage threw:', e);
    return null;
  }
}
