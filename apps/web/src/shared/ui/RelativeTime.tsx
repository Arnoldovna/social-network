import { useSyncExternalStore } from 'react';

import { formatDateTime, formatRelative, toDate } from '../lib/format-date';
import { tokenList } from '../lib/token-list';
import './RelativeTime.css';

/** How often mounted timestamps re-render; also the resolution of "now". */
const TICK_MS = 15_000;

/*
 * One shared clock for every mounted timestamp: a single interval runs while at least one RelativeTime is mounted.
 * The snapshot is "now" rounded down to the tick, so it stays stable between ticks (useSyncExternalStore requires
 * that) and all timestamps on a page agree.
 */
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  interval ??= setInterval(() => {
    for (const notify of listeners) {
      notify();
    }
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  };
}

function getNow(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

export interface RelativeTimeProps {
  /** ISO 8601 timestamp from the API (`createdAt`). */
  dateTime: string;
  /** BEM element class of the parent block, mixed in (layout only). */
  className?: string;
}

/**
 * A relative timestamp in a `<time datetime>` element with the absolute date and time as its title (F-69, F-77,
 * B-99: legacy showed raw ISO strings), in the viewer's time zone (F-108; parsing and wording in
 * `shared/lib/format-date`). It updates itself while mounted. An unparsable value is shown as it is.
 */
export function RelativeTime({ dateTime, className }: RelativeTimeProps) {
  const now = useSyncExternalStore(subscribe, getNow, getNow);
  const date = toDate(dateTime);

  if (date === null) {
    return <span className={tokenList('relative-time', className)}>{dateTime}</span>;
  }

  return (
    <time className={tokenList('relative-time', className)} dateTime={date.toISOString()} title={formatDateTime(date)}>
      {formatRelative(date, now)}
    </time>
  );
}
