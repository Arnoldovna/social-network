import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** Within this many pixels of the end the reader counts as "at the bottom" (sub-pixel rounding, a last half line). */
export const BOTTOM_THRESHOLD_PX = 48;

export interface StickToBottomOptions {
  /** Key of the oldest rendered entry; it changes when older entries are added on top (F-82). */
  oldestKey: string | null;
  /** Key of the newest rendered entry; it changes when an entry is added at the bottom (F-81). */
  newestKey: string | null;
  /** Number of rendered entries, so an added older page can be told apart from pages being dropped by a resync. */
  itemCount: number;
  /** The newest entry is the reader's own message: follow it to the bottom even when scrolled up. */
  followNewest: boolean;
}

export interface StickToBottom<T extends HTMLElement> {
  /** Attach to the scroll container. */
  ref: RefObject<T | null>;
  /** Attach as the container's `onScroll`. */
  onScroll: () => void;
  /** Newer entries arrived below while the reader was scrolled up: show the "new messages" pill (F-81). */
  hasNewBelow: boolean;
  /** Jumps to the newest entry (the pill's action). */
  scrollToBottom: () => void;
}

interface Snapshot {
  oldestKey: string | null;
  newestKey: string | null;
  itemCount: number;
  /** `scrollHeight` after the last render or scroll, i.e. before the next content change. */
  scrollHeight: number;
}

export function isScrolledToBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX;
}

export function scrollToEnd(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}

/**
 * Scroll behaviour of a chat log (F-81, F-82, B-85). Legacy forced `scrollTop` on every update, even while the reader
 * was scrolled up, and crashed when the container was not rendered (empty chat). Here:
 *
 * - The first content starts at the newest entry.
 * - A new entry at the bottom scrolls into view only when the reader was already at the bottom (or it is their own
 *   message); otherwise `hasNewBelow` turns true until they reach the bottom or use `scrollToBottom`.
 * - Older entries added on top keep the entries in view where they were (the container sets `overflow-anchor: none`,
 *   so the browser's own anchoring never adds the same offset a second time).
 * - Every DOM access checks the ref first, so an absent container (loading, error) is simply skipped.
 *
 * "At the bottom" and the newest entry the reader has seen are updated from scroll events, which browsers also fire
 * for the programmatic scrolls above, so the state is never set inside the effect.
 */
export function useStickToBottom<T extends HTMLElement>({
  oldestKey,
  newestKey,
  itemCount,
  followNewest,
}: StickToBottomOptions): StickToBottom<T> {
  const ref = useRef<T>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [seenNewestKey, setSeenNewestKey] = useState<string | null>(null);
  // The same answer as `atBottom`, readable in the layout effect without making it a dependency.
  const atBottomRef = useRef(true);
  const snapshot = useRef<Snapshot>({ oldestKey: null, newestKey: null, itemCount: 0, scrollHeight: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    const previous = snapshot.current;
    if (element !== null && newestKey !== null) {
      if (previous.newestKey === null) {
        scrollToEnd(element);
      } else if (newestKey !== previous.newestKey) {
        if (atBottomRef.current || followNewest) {
          scrollToEnd(element);
          atBottomRef.current = true;
        }
      } else if (oldestKey !== previous.oldestKey && itemCount > previous.itemCount) {
        element.scrollTop += element.scrollHeight - previous.scrollHeight;
      }
    }
    snapshot.current = { oldestKey, newestKey, itemCount, scrollHeight: element?.scrollHeight ?? 0 };
  }, [oldestKey, newestKey, itemCount, followNewest]);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const bottom = isScrolledToBottom(element);
    atBottomRef.current = bottom;
    snapshot.current.scrollHeight = element.scrollHeight;
    setAtBottom(bottom);
    if (bottom) {
      setSeenNewestKey(newestKey);
    }
  }, [newestKey]);

  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    scrollToEnd(element);
    atBottomRef.current = true;
    setAtBottom(true);
    setSeenNewestKey(newestKey);
  }, [newestKey]);

  const hasNewBelow = !atBottom && newestKey !== null && seenNewestKey !== null && newestKey !== seenNewestKey;

  return { ref, onScroll, hasNewBelow, scrollToBottom };
}
