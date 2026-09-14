import type { ParsedId } from '../discord/custom-id.ts';
import type { Env, Interaction, MessageData, ModalData } from '../types';

/**
 * What a button / select / modal handler asks the router to send back.
 *
 * - update       → type 7: replace the message the component sits on, now.
 * - reply        → type 4: a new message (ephemeral by default for flows).
 * - modal        → type 9: open a modal (must be the initial response).
 * - deferUpdate  → type 6 now, then `work` edits the component's message.
 * - deferReply   → type 5 now, then `work` fills the new message.
 */
export type ComponentReply =
  | { kind: 'update'; data: MessageData }
  | { kind: 'reply'; data: MessageData; ephemeral?: boolean }
  | { kind: 'modal'; data: ModalData }
  | { kind: 'deferUpdate'; work: () => Promise<MessageData | null> }
  | { kind: 'deferReply'; ephemeral: boolean; work: () => Promise<MessageData> };

export type ComponentHandler = (i: Interaction, env: Env, id: ParsedId) => Promise<ComponentReply>;
