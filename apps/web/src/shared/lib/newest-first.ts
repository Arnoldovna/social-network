/*
 * The order of every paged history the API sends (wall posts, chat messages; ADR-0014): `created_at DESC, id DESC`.
 * One client copy of that rule, so live inserts into the wall and the chat can never order differently.
 */

/** An entry of a newest-first history: a server id and its ISO 8601 `createdAt`. */
export interface Chronological {
  id: number;
  createdAt: string;
}

/**
 * `true` when `a` comes before `b` newest first: the later instant first, the higher id first within one millisecond.
 * The instants are compared, not the strings, so the same moment written with a different precision or offset is
 * still the same moment and falls through to the id.
 */
export function isNewer(a: Chronological, b: Chronological): boolean {
  const difference = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return difference === 0 ? a.id > b.id : difference > 0;
}

/**
 * Where `entry` belongs in `items` (newest first): the index of the first item it is newer than, or `items.length`
 * when it is older than all of them.
 */
export function newestFirstIndex(items: readonly Chronological[], entry: Chronological): number {
  const index = items.findIndex((item) => isNewer(entry, item));
  return index === -1 ? items.length : index;
}

/** `true` when any loaded page of a paged history already holds the entry with this id (live inserts de-duplicate). */
export function isLoaded(pages: readonly { items: readonly { id: number }[] }[], id: number): boolean {
  return pages.some((page) => page.items.some((item) => item.id === id));
}
