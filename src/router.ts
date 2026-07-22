import {
  handleGameBracket,
  handleGameCancel,
  handleGameReport,
  handleGameStart,
} from './commands/game';
import { handleCommander } from './commands/commander';
import { handleLeaderboard, handleStats, handleVs } from './commands/boards';
import { handleUndo } from './commands/undo';
import { errorMessage, helpMessage } from './discord/embeds';
import { fetchOriginalMessageId, json, patchOriginal } from './discord/api';
import { getActiveGame, setGameMessageId } from './db/queries';
import { searchCommanders } from './scryfall';
import { EPHEMERAL, ResponseType, type Env, type Interaction, type MessageData } from './types';

type CommandHandler = (i: Interaction, env: Env) => Promise<MessageData>;

interface CommandSpec {
  handler: CommandHandler;
  /** inline = reply immediately (type 4); deferred = ack now, edit later (type 5). */
  mode: 'inline' | 'deferred';
  /** Ephemerality is fixed here, at reply time — it cannot be added to a later edit. */
  ephemeral?: boolean;
  /** Side-effect run after the response is sent, inside ctx.waitUntil. */
  after?: (i: Interaction, env: Env) => Promise<void>;
}

/**
 * After /game start responds inline, read back the message we just created and
 * store its id, so every later command can edit that one card. A fast follow-up
 * that beats this write self-heals by reposting (see updateLiveCard).
 */
async function captureStartMessageId(i: Interaction, env: Env): Promise<void> {
  if (!i.guild_id || !i.channel_id) return;
  const messageId = await fetchOriginalMessageId(i.application_id, i.token);
  if (!messageId) return;
  const game = await getActiveGame(env.DB, i.guild_id, i.channel_id);
  if (game && game.status === 'active') {
    await setGameMessageId(env.DB, game.id, messageId);
  }
}

const COMMANDS: Record<string, CommandSpec> = {
  // Inline so its @mentions ping; this message becomes the live card.
  'game start': { handler: handleGameStart, mode: 'inline', after: captureStartMessageId },
  help: { handler: async () => helpMessage(), mode: 'inline', ephemeral: true },

  // Private tweaks to the live card — the shared card shows the change, so the
  // reply just confirms to whoever ran the command.
  'game cancel': { handler: handleGameCancel, mode: 'deferred', ephemeral: true },
  'game bracket': { handler: handleGameBracket, mode: 'deferred', ephemeral: true },
  commander: { handler: handleCommander, mode: 'deferred', ephemeral: true },

  // Public results and shared readouts — the whole channel sees these.
  'game report': { handler: handleGameReport, mode: 'deferred' },
  leaderboard: { handler: handleLeaderboard, mode: 'deferred' },
  stats: { handler: handleStats, mode: 'deferred' },
  vs: { handler: handleVs, mode: 'deferred' },
  undo: { handler: handleUndo, mode: 'deferred' },
};

function commandKey(i: Interaction): string {
  const data = i.data!;
  const top = data.options?.[0];
  return top && top.type === 1 ? `${data.name} ${top.name}` : data.name;
}

export async function routeCommand(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const key = commandKey(i);
  const spec = COMMANDS[key];
  if (!spec) {
    return json({
      type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: errorMessage(`Unknown command: ${key}`),
    });
  }

  if (spec.mode === 'inline') {
    let data: MessageData;
    try {
      data = await spec.handler(i, env);
    } catch (e) {
      console.error(`${key} failed:`, e);
      data = errorMessage('Something went wrong — try again.');
    }
    if (spec.ephemeral) data.flags = (data.flags ?? 0) | EPHEMERAL;
    if (spec.after) ctx.waitUntil(spec.after(i, env));
    return json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data });
  }

  ctx.waitUntil(
    (async () => {
      let data: MessageData;
      try {
        data = await spec.handler(i, env);
      } catch (e) {
        console.error(`${key} failed:`, e);
        data = errorMessage('Something went wrong — try again.');
      }
      await patchOriginal(i.application_id, i.token, data);
    })(),
  );
  return json({
    type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: spec.ephemeral ? { flags: EPHEMERAL } : undefined,
  });
}

export async function routeAutocomplete(i: Interaction, env: Env): Promise<Response> {
  const opts = i.data?.options ?? [];
  const flat = opts[0]?.type === 1 ? (opts[0].options ?? []) : opts;
  const focused = flat.find((o) => o.focused);

  let choices: { name: string; value: string }[] = [];
  if (i.data?.name === 'commander' && (focused?.name === 'name' || focused?.name === 'partner')) {
    const names = await searchCommanders(String(focused.value ?? ''));
    choices = names.map((n) => ({ name: n, value: n }));
  }
  return json({
    type: ResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  });
}
