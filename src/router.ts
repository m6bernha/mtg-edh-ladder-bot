import {
  handleGameBracket,
  handleGameCancel,
  handleGameReport,
  handleGameStart,
} from './commands/game';
import { handleCommander } from './commands/commander';
import { handleLeaderboard, handleStats, handleVs } from './commands/boards';
import { handleUndo } from './commands/undo';
import { handleMeta } from './commands/meta';
import { handleHistory } from './commands/history';
import { handlePredict } from './commands/predict';
import { handleConfig } from './commands/config';
import { helpMessage } from './discord/boards.ts';
import { errorMessage } from './discord/embeds';
import { fetchOriginalMessageId, json, patchOriginal, withV2 } from './discord/api';
import { parseId } from './discord/custom-id.ts';
import { getActiveGame, setGameMessageId } from './db/queries';
import { colorEmoji, suggestCommanders } from './commanders';
import { cancelFlow } from './flows/cancel.ts';
import { commanderFlow } from './flows/commander.ts';
import { pageFlow } from './flows/pages.ts';
import { reportFlow } from './flows/report.ts';
import { errorV2 } from './flows/shared.ts';
import type { ComponentHandler, ComponentReply } from './flows/types.ts';
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
  meta: { handler: handleMeta, mode: 'deferred' },
  history: { handler: handleHistory, mode: 'deferred' },
  predict: { handler: handlePredict, mode: 'deferred' },

  // Admin settings — private.
  'config digest-channel': { handler: handleConfig, mode: 'deferred', ephemeral: true },
  'config digest-off': { handler: handleConfig, mode: 'deferred', ephemeral: true },
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
    return json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: withV2(data) });
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
  // A deferred ack may carry only the EPHEMERAL flag; the V2 flag goes on the edit.
  return json({
    type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: spec.ephemeral ? { flags: EPHEMERAL } : undefined,
  });
}

/** Discord caps an autocomplete choice label at 100 characters. */
const MAX_CHOICE_LABEL = 100;

export async function routeAutocomplete(
  i: Interaction,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const opts = i.data?.options ?? [];
  const flat = opts[0]?.type === 1 ? (opts[0].options ?? []) : opts;
  const focused = flat.find((o) => o.focused);

  let choices: { name: string; value: string }[] = [];
  if (i.data?.name === 'commander' && (focused?.name === 'name' || focused?.name === 'partner')) {
    const matches = await suggestCommanders(env.DB, String(focused.value ?? ''), ctx);
    // The label carries colour identity for the eye; the value is always the exact
    // Scryfall name, which is what /commander resolves and what stats key on.
    choices = matches.map((m) => ({
      name: `${colorEmoji(m.colors)} ${m.name}`.slice(0, MAX_CHOICE_LABEL),
      value: m.name.slice(0, MAX_CHOICE_LABEL),
    }));
  }
  return json({
    type: ResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  });
}

// ---- Components (buttons, selects) and modals ----

const COMPONENTS: Record<string, ComponentHandler> = {
  ...cancelFlow,
  ...commanderFlow,
  ...reportFlow,
  ...pageFlow,
};

/** Modal submits share the cmd:* handlers; only cmd:modal is a modal today. */
const MODALS: Record<string, ComponentHandler> = {
  'cmd:modal': commanderFlow['cmd:modal'],
};

const STALE = errorV2('That button is from an older card.');

async function sendReply(i: Interaction, ctx: ExecutionContext, reply: ComponentReply): Promise<Response> {
  switch (reply.kind) {
    case 'update':
      return json({ type: ResponseType.UPDATE_MESSAGE, data: withV2(reply.data) });
    case 'reply': {
      // Copy: handlers may hand back a shared constant (STALE, noGuild).
      const data = { ...withV2(reply.data) };
      if (reply.ephemeral) data.flags = (data.flags ?? 0) | EPHEMERAL;
      return json({ type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data });
    }
    case 'modal':
      return json({ type: ResponseType.MODAL, data: reply.data });
    case 'deferUpdate':
      ctx.waitUntil(
        (async () => {
          let data: MessageData | null;
          try {
            data = await reply.work();
          } catch (e) {
            console.error(`${i.data?.custom_id} failed:`, e);
            data = errorV2('Something went wrong — try again.');
          }
          if (data) await patchOriginal(i.application_id, i.token, data);
        })(),
      );
      return json({ type: ResponseType.DEFERRED_UPDATE_MESSAGE });
    case 'deferReply':
      ctx.waitUntil(
        (async () => {
          let data: MessageData;
          try {
            data = await reply.work();
          } catch (e) {
            console.error(`${i.data?.custom_id} failed:`, e);
            data = errorV2('Something went wrong — try again.');
          }
          await patchOriginal(i.application_id, i.token, data);
        })(),
      );
      return json({
        type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: reply.ephemeral ? { flags: EPHEMERAL } : undefined,
      });
  }
}

async function dispatch(
  table: Record<string, ComponentHandler>,
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const id = parseId(i.data?.custom_id);
  const handler = id ? table[`${id.ns}:${id.verb}`] : undefined;
  if (!id || !handler) {
    return sendReply(i, ctx, { kind: 'reply', data: STALE, ephemeral: true });
  }
  let reply: ComponentReply;
  try {
    reply = await handler(i, env, id);
  } catch (e) {
    console.error(`${i.data?.custom_id} failed:`, e);
    reply = { kind: 'reply', data: errorV2('Something went wrong — try again.'), ephemeral: true };
  }
  return sendReply(i, ctx, reply);
}

export const routeComponent = (i: Interaction, env: Env, ctx: ExecutionContext) => dispatch(COMPONENTS, i, env, ctx);
export const routeModal = (i: Interaction, env: Env, ctx: ExecutionContext) => dispatch(MODALS, i, env, ctx);
