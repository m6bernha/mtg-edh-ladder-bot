/**
 * custom_id grammar for buttons, selects and modals:
 *
 *   <ns>:<verb>[:<arg>...]        e.g. "rep:pick:42:f:2-0"   "lb:page:3"
 *
 * Everything a follow-up interaction needs is either in the id or re-derived
 * from the database, so the bot holds no per-click state. Discord caps ids at
 * 100 characters; the worst case here (a six-player full report) is ~32.
 */

import { LIMITS } from './components.ts';

export interface ParsedId {
  ns: string;
  verb: string;
  args: string[];
}

const PART = /^[A-Za-z0-9_\-.]+$/;

export function encodeId(ns: string, verb: string, ...args: (string | number)[]): string {
  const parts = [ns, verb, ...args.map(String)];
  for (const p of parts) {
    if (!PART.test(p)) throw new Error(`custom_id part contains a reserved character: ${JSON.stringify(p)}`);
  }
  const id = parts.join(':');
  if (id.length > LIMITS.CUSTOM_ID_CHARS) throw new Error(`custom_id too long (${id.length}): ${id}`);
  return id;
}

export function parseId(id: string | undefined): ParsedId | null {
  if (!id || id.length > LIMITS.CUSTOM_ID_CHARS) return null;
  const parts = id.split(':');
  if (parts.length < 2) return null;
  if (!parts.every((p) => PART.test(p))) return null;
  return { ns: parts[0], verb: parts[1], args: parts.slice(2) };
}

/** A roster-index list as it travels inside an id: "2-0-3" ⇄ [2, 0, 3]. */
export function encodeOrder(indices: number[]): string {
  return indices.length ? indices.join('-') : '-';
}
export function decodeOrder(s: string | undefined): number[] {
  if (!s) return [];
  return s.split('-').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0);
}

export function intArg(args: string[], i: number): number | null {
  const n = Number.parseInt(args[i] ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
