/**
 * Discord Components V2 — the message layout system that replaces embeds:
 * a Container with an accent bar holding Text Displays, Sections (text + a
 * thumbnail or button accessory), Separators, Media Galleries and Action Rows.
 *
 * Type numbers and limits verified against
 * https://docs.discord.com/developers/components/reference (2026-09-13).
 * Messages using these MUST carry the IS_COMPONENTS_V2 flag and cannot carry
 * `content` or `embeds`; the flag cannot be removed from a message once sent.
 * Everything here is data — builders and counters, no I/O.
 */

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  USER_SELECT: 5,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  SEPARATOR: 14,
  CONTAINER: 17,
  LABEL: 18,
} as const;

export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 } as const;

/** Message flag: this message uses Components V2 (no content/embeds). */
export const IS_COMPONENTS_V2 = 1 << 15;

// ---- Limits (per the reference) ----
export const LIMITS = {
  COMPONENTS_PER_MESSAGE: 40,
  TEXT_DISPLAY_CHARS: 4000,
  CUSTOM_ID_CHARS: 100,
  SELECT_OPTIONS: 25,
  SELECT_LABEL_CHARS: 100,
  BUTTONS_PER_ROW: 5,
  MEDIA_GALLERY_ITEMS: 10,
  SECTION_TEXTS: 3,
  MODAL_TITLE_CHARS: 45,
  MODAL_COMPONENTS: 5,
} as const;

// ---- Shapes ----

export interface TextDisplay {
  type: 10;
  content: string;
}
export interface Thumbnail {
  type: 11;
  media: { url: string };
  description?: string;
}
export interface Button {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label?: string;
  emoji?: { name: string };
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}
export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: { name: string };
  default?: boolean;
}
export interface StringSelect {
  type: 3;
  custom_id: string;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  options: SelectOption[];
  disabled?: boolean;
}
export interface ActionRow {
  type: 1;
  components: (Button | StringSelect)[];
}
export interface Section {
  type: 9;
  components: TextDisplay[];
  accessory: Thumbnail | Button;
}
export interface MediaGallery {
  type: 12;
  items: { media: { url: string }; description?: string }[];
}
export interface Separator {
  type: 14;
  divider?: boolean;
  spacing?: 1 | 2;
}
export type ContainerChild = TextDisplay | Section | MediaGallery | Separator | ActionRow;
export interface Container {
  type: 17;
  accent_color?: number;
  spoiler?: boolean;
  components: ContainerChild[];
}
export type Component = Container | ContainerChild;

// Modals
export interface TextInput {
  type: 4;
  custom_id: string;
  style: 1 | 2; // short | paragraph
  placeholder?: string;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  value?: string;
}
export interface Label {
  type: 18;
  label: string;
  description?: string;
  component: TextInput | StringSelect;
}
export interface ModalData {
  custom_id: string;
  title: string;
  components: Label[];
}

// ---- Builders ----

export const text = (content: string): TextDisplay => ({ type: 10, content });
export const thumb = (url: string, description?: string): Thumbnail => ({
  type: 11,
  media: { url },
  ...(description ? { description } : {}),
});
export const sep = (spacing: 1 | 2 = 1, divider = true): Separator => ({ type: 14, divider, spacing });
export const row = (...components: (Button | StringSelect)[]): ActionRow => ({ type: 1, components });
export const section = (accessory: Thumbnail | Button, ...texts: TextDisplay[]): Section => ({
  type: 9,
  components: texts,
  accessory,
});
export const gallery = (...items: { url: string; description?: string }[]): MediaGallery => ({
  type: 12,
  items: items.map((i) => ({ media: { url: i.url }, ...(i.description ? { description: i.description } : {}) })),
});
export const container = (accent: number | undefined, ...components: ContainerChild[]): Container => ({
  type: 17,
  ...(accent !== undefined ? { accent_color: accent } : {}),
  components,
});
export function button(
  style: Button['style'],
  label: string,
  customId: string,
  opts: { emoji?: string; disabled?: boolean } = {},
): Button {
  return {
    type: 2,
    style,
    label,
    custom_id: customId,
    ...(opts.emoji ? { emoji: { name: opts.emoji } } : {}),
    ...(opts.disabled ? { disabled: true } : {}),
  };
}
export function stringSelect(
  customId: string,
  options: SelectOption[],
  opts: { placeholder?: string; min?: number; max?: number } = {},
): StringSelect {
  return {
    type: 3,
    custom_id: customId,
    options: options.slice(0, LIMITS.SELECT_OPTIONS),
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    ...(opts.min !== undefined ? { min_values: opts.min } : {}),
    ...(opts.max !== undefined ? { max_values: opts.max } : {}),
  };
}
export function textInput(
  customId: string,
  opts: { placeholder?: string; required?: boolean; maxLength?: number; value?: string; paragraph?: boolean } = {},
): TextInput {
  return {
    type: 4,
    custom_id: customId,
    style: opts.paragraph ? 2 : 1,
    required: opts.required ?? false,
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    ...(opts.maxLength ? { max_length: opts.maxLength } : {}),
    ...(opts.value ? { value: opts.value } : {}),
  };
}
export const label = (labelText: string, component: TextInput | StringSelect, description?: string): Label => ({
  type: 18,
  label: labelText,
  ...(description ? { description } : {}),
  component,
});

// ---- Counters (used by tests and by renderers that must stay under the caps) ----

export function countComponents(components: Component[]): number {
  let n = 0;
  const walk = (c: Component | Button | StringSelect | Thumbnail): void => {
    n++;
    if (c.type === 17) c.components.forEach(walk);
    else if (c.type === 1) c.components.forEach(walk);
    else if (c.type === 9) {
      c.components.forEach(walk);
      walk(c.accessory);
    }
  };
  components.forEach(walk);
  return n;
}

export function totalTextLength(components: Component[]): number {
  let n = 0;
  const walk = (c: Component): void => {
    if (c.type === 10) n += c.content.length;
    else if (c.type === 17) c.components.forEach(walk);
    else if (c.type === 9) c.components.forEach(walk);
  };
  components.forEach(walk);
  return n;
}

/** Every custom_id in a tree, for uniqueness/length assertions. */
export function customIds(components: Component[]): string[] {
  const out: string[] = [];
  const walk = (c: Component | Button | StringSelect | Thumbnail): void => {
    if ((c.type === 2 || c.type === 3) && c.custom_id) out.push(c.custom_id);
    if (c.type === 17 || c.type === 1) c.components.forEach(walk);
    else if (c.type === 9) {
      c.components.forEach(walk);
      walk(c.accessory);
    }
  };
  components.forEach(walk);
  return out;
}
