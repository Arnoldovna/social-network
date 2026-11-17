import { useEffect, useState } from 'react';

/** The header search waits this long after the last keystroke before it queries (F-59, OVERVIEW §7). */
export const DEFAULT_DEBOUNCE_MS = 300;

/**
 * `value` once it has stopped changing for `delayMs`. Each change restarts the timer, and unmounting cancels it, so a
 * fast typist sends one search request instead of one per character, and nothing updates after the component is gone.
 */
export function useDebouncedValue<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
