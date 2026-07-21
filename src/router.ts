import { handleGameCancel, handleGameReport, handleGameStart } from './commands/game';
import { handleCommander } from './commands/commander';
import { handleLeaderboard, handleStats, handleVs } from './commands/boards';
import { handleUndo } from './commands/undo';
import { errorMessage, helpMessage } from './discord/embeds';
import { json, patchOriginal } from './discord/api';
import { searchCommanders } from './scryfall';
import { ResponseType, type Env, type Interaction, type MessageData } from './types';

type CommandHandler = (i: Interaction, env: Env) => Promise<MessageData>;

/** Fast handlers answer inline (type 4) — game start must, so its @mentions ping. */
const INLINE: Record<string, CommandHandler> = {
  'game start': handleGameStart,
  help: async () => helpMessage(),
};

/** Everything else defers (type 5) and edits the response when done. */
const DEFERRED: Record<string, CommandHandler> = {
  'game report': handleGameReport,
  'game cancel': handleGameCancel,
  commander: handleCommander,
  leaderboard: handleLeaderboard,
  stats: handleStats,
  vs: handleVs,
  undo: handleUndo,
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

  const inline = INLINE[key];
  if (inline) {
    try {
      return json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: await inline(i, env) });
    } catch (e) {
      console.error(`${key} failed:`, e);
      return json({
        type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: errorMessage('Something went wrong — try again.'),
      });
    }
  }

  const deferred = DEFERRED[key];
  if (!deferred) {
    return json({
      type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: errorMessage(`Unknown command: ${key}`),
    });
  }
  ctx.waitUntil(
    (async () => {
      let data: MessageData;
      try {
        data = await deferred(i, env);
      } catch (e) {
        console.error(`${key} failed:`, e);
        data = errorMessage('Something went wrong — try again.');
      }
      await patchOriginal(i.application_id, i.token, data);
    })(),
  );
  return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
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
