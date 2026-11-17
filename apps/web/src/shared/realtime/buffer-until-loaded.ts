/** The socket events of one RTK Query cache entry, held back until its first response is in the cache. */
export interface EventBuffer<Event> {
  /** Applies the event at once, or keeps it while the first response is still loading. */
  push: (event: Event) => void;
  /** The first response is in the cache: replays the kept events in order; every later `push` applies at once. */
  flush: () => void;
}

/**
 * The one client copy of the B-86 rule for real-time caches (wall, chat, presence; ADR-0012): an event is applied to a
 * cache entry only once its first response is there, because before that there is nothing to patch. Events that arrive
 * while that request is in flight are not dropped but replayed in order by `flush`, so nothing that happened during
 * the first load is missed. Replaying is safe because every `apply` is idempotent (upserts and removals by id).
 */
export function bufferUntilLoaded<Event>(apply: (event: Event) => void): EventBuffer<Event> {
  let pending: Event[] | null = [];
  return {
    push: (event) => {
      if (pending === null) {
        apply(event);
      } else {
        pending.push(event);
      }
    },
    flush: () => {
      const waiting = pending ?? [];
      pending = null;
      waiting.forEach(apply);
    },
  };
}
