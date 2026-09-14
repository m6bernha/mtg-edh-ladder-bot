import { IS_COMPONENTS_V2 } from './components.ts';
import type { MessageData } from '../types';

const API = 'https://discord.com/api/v10';

/**
 * The one place the Components V2 flag is set. A message with `components`
 * gets the flag; a message with `content`/`embeds` must not have it. Mixing the
 * two is a programming error and is caught here rather than as a Discord 400.
 */
export function withV2(data: MessageData): MessageData {
  if (!data.components) return data;
  if (data.content !== undefined || data.embeds !== undefined) {
    throw new Error('a Components V2 message cannot carry content or embeds');
  }
  return { ...data, flags: (data.flags ?? 0) | IS_COMPONENTS_V2 };
}

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
    body: JSON.stringify(withV2(data)),
  });
  if (!res.ok) {
    console.error(`patchOriginal failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Post a follow-up message through the interaction webhook — public unless
 * flagged ephemeral, and needing no channel permissions. Used when a button
 * flow's result must reach the whole pod but the live card could not be edited.
 */
export async function followUp(applicationId: string, token: string, data: MessageData): Promise<void> {
  const res = await fetch(`${API}/webhooks/${applicationId}/${token}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(withV2(data)),
  });
  if (!res.ok) {
    console.error(`followUp failed: ${res.status} ${await res.text()}`);
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
 * Outcome of a bot-token call. `status` is the HTTP status (0 when the fetch
 * itself threw) and `message` is Discord's own error text (`{"message","code"}`)
 * when it sent one, so callers can tell a rejected token (401) from a channel
 * permission problem (403) instead of guessing.
 */
export interface BotCallResult {
  ok: boolean;
  status: number;
  code?: number;
  message?: string;
  /** Message id — only set by createMessage on success. */
  id?: string;
}

async function botCall(
  botToken: string,
  method: 'PATCH' | 'POST',
  url: string,
  data: MessageData,
  label: string,
): Promise<BotCallResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...JSON_HEADERS, Authorization: `Bot ${botToken}` },
      body: JSON.stringify(withV2(data)),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`${label} failed: ${res.status} ${text}`);
      let code: number | undefined;
      let message: string | undefined;
      try {
        const parsed = JSON.parse(text) as { code?: number; message?: string };
        code = parsed.code;
        message = parsed.message;
      } catch {
        // Empty or HTML body — Discord's WAF, not a Discord API error.
      }
      return { ok: false, status: res.status, code, message };
    }
    const msg = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, status: res.status, id: msg.id };
  } catch (e) {
    console.error(`${label} threw:`, e);
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Edit any message by id with the bot token. Unlike the interaction webhook this
 * never expires, so it can update a game's live card an hour into the match.
 * Never throws: a 401 (bad token) / 403 (no channel access) / 404 (card deleted)
 * / network error comes back as `ok: false` with the status, so the caller can
 * degrade — repost the card — and tell the user what actually went wrong.
 */
export function editMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  data: MessageData,
): Promise<BotCallResult> {
  return botCall(botToken, 'PATCH', `${API}/channels/${channelId}/messages/${messageId}`, data, 'editMessage');
}

/**
 * Post a new message to a channel with the bot token, returning its id in `id`.
 * Used to (re)create a game's live card when no card exists yet or the old one
 * is gone.
 */
export function createMessage(
  botToken: string,
  channelId: string,
  data: MessageData,
): Promise<BotCallResult> {
  return botCall(botToken, 'POST', `${API}/channels/${channelId}/messages`, data, 'createMessage');
}
