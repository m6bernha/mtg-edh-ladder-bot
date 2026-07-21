export interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
}

// ---- Discord interaction payload (minimal, hand-rolled) ----

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
} as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
} as const;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
  focused?: boolean;
}

export interface Interaction {
  type: number;
  id: string;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser; permissions?: string; nick?: string | null };
  user?: DiscordUser;
  data?: {
    name: string;
    options?: InteractionOption[];
    resolved?: { users?: Record<string, DiscordUser> };
  };
}

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

/** Body of a message the bot sends (initial response or webhook edit). */
export interface MessageData {
  content?: string;
  embeds?: Embed[];
  allowed_mentions?: { users?: string[]; parse?: string[] };
}

// ---- Database rows ----

export interface PlayerRow {
  id: number;
  guild_id: string;
  discord_user_id: string;
  username: string;
  elo: number;
  ts_mu: number;
  ts_sigma: number;
}

export interface GameRow {
  id: number;
  guild_id: string;
  channel_id: string;
  status: 'active' | 'completed' | 'cancelled' | 'undone';
  bracket: string;
  winner_only: number;
  draw: number;
  started_at: number;
  ended_at: number | null;
  created_by: string;
  reported_by: string | null;
}

export interface GamePlayerRow {
  game_id: number;
  player_id: number;
  placement: number | null;
  commander: string | null;
  elo_before: number | null;
  elo_after: number | null;
  mu_before: number | null;
  mu_after: number | null;
  sigma_before: number | null;
  sigma_after: number | null;
}

/** game_players joined with its player row — the usual working shape. */
export interface RosterEntry extends GamePlayerRow {
  discord_user_id: string;
  username: string;
  elo: number;
  ts_mu: number;
  ts_sigma: number;
}
