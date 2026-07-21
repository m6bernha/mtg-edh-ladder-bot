import { verifyKey } from 'discord-interactions';
import { json } from './discord/api';
import { routeAutocomplete, routeCommand } from './router';
import { InteractionType, ResponseType, type Env, type Interaction } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'GET') return new Response('MTG EDH Ladder is up ⚔️');
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.text();
    const valid =
      signature != null &&
      timestamp != null &&
      (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
    if (!valid) return new Response('invalid request signature', { status: 401 });

    const interaction = JSON.parse(body) as Interaction;
    switch (interaction.type) {
      case InteractionType.PING:
        return json({ type: ResponseType.PONG });
      case InteractionType.APPLICATION_COMMAND:
        return routeCommand(interaction, env, ctx);
      case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE:
        return routeAutocomplete(interaction, env);
      default:
        return json({
          type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: 'Unsupported interaction type.' },
        });
    }
  },
} satisfies ExportedHandler<Env>;
