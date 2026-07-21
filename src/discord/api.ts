import type { MessageData } from '../types';

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
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) {
    console.error(`patchOriginal failed: ${res.status} ${await res.text()}`);
  }
}
