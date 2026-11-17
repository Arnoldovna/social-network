import type { FriendEntry, FriendshipState } from '@app/shared';
import { useId, useLayoutEffect, useRef } from 'react';

import { hasLostFocus } from '../../../shared/lib/focus';
import { formatDate, formatDateTime } from '../../../shared/lib/format-date';
import { fullName } from '../../../shared/lib/names';
import { EmptyState } from '../../../shared/ui/EmptyState';
import { UserRow } from '../../../shared/ui/UserRow';
import { SINCE_PREFIX } from '../friend-button-labels';
import { FriendActions } from './FriendButton';
import type { FriendActionResult } from './FriendButton';
import './FriendSection.css';

/** The three lists of `/friends`, named by the state their entries are in. */
export type FriendSectionKind = Exclude<FriendshipState, 'none'>;

export interface FriendSectionProps {
  kind: FriendSectionKind;
  /** Lowercase section label, e.g. "friend requests" (maw section label). */
  title: string;
  entries: readonly FriendEntry[];
  /** "2 requests"; not shown while the list is empty. */
  countLabel: (count: number) => string;
  /** The empty state (F-56): what is not there, and what to do next. */
  emptyTitle: string;
  emptyText: string;
  /** A confirmed action in this list, e.g. to show its message. */
  onDone: (result: FriendActionResult) => void;
  /** A failed action in this list; the message outlives the row, which a refetch may remove (B-26). */
  onError: (message: string) => void;
}

/**
 * One list of `/friends` (F-54): a section label, then one `UserRow` per person with avatar, name linking to the
 * profile (B-93), the date as meta and the actions of this list (F-55), or the empty state (F-56). Names are rendered
 * as stored (F-58, B-110).
 *
 * An action usually moves the person out of this list. When the row disappears while it held focus, focus goes to the
 * section heading instead of falling back to the document, so keyboard users keep their place.
 */
export function FriendSection({
  kind,
  title,
  entries,
  countLabel,
  emptyTitle,
  emptyText,
  onDone,
  onError,
}: FriendSectionProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Whose row had an action settle; cleared once focus was handled. */
  const settledUserId = useRef<number | null>(null);
  /** The ids rendered by the last commit, readable from the async action callbacks. */
  const renderedIds = useRef<ReadonlySet<number>>(new Set());

  const focusHeadingIfRowGone = () => {
    const userId = settledUserId.current;
    if (userId === null || renderedIds.current.has(userId)) {
      return;
    }
    settledUserId.current = null;
    if (hasLostFocus()) {
      headingRef.current?.focus();
    }
  };

  useLayoutEffect(() => {
    renderedIds.current = new Set(entries.map((entry) => entry.user.id));
    focusHeadingIfRowGone();
  });

  // The cache may already have dropped the row before the action's promise settled; check right away as well.
  const settle = (userId: number) => {
    settledUserId.current = userId;
    focusHeadingIfRowGone();
  };

  return (
    <section className="friend-section" aria-labelledby={headingId}>
      <div className="friend-section__header">
        <h2 id={headingId} ref={headingRef} className="friend-section__title" tabIndex={-1}>
          {title}
        </h2>
        {entries.length === 0 ? null : <p className="friend-section__count">{countLabel(entries.length)}</p>}
      </div>
      {entries.length === 0 ? (
        <EmptyState title={emptyTitle} text={emptyText} />
      ) : (
        <ul className="friend-section__list">
          {entries.map(({ user, since }) => {
            const userName = fullName(user);
            return (
              <UserRow
                key={user.id}
                user={user}
                meta={
                  <>
                    {SINCE_PREFIX[kind]}{' '}
                    <time dateTime={since} title={formatDateTime(since)}>
                      {formatDate(since)}
                    </time>
                  </>
                }
                actions={
                  <FriendActions
                    userId={user.id}
                    userName={userName}
                    state={kind}
                    place="row"
                    onDone={(result) => {
                      settle(user.id);
                      onDone(result);
                    }}
                    onError={(message) => {
                      settle(user.id);
                      onError(message);
                    }}
                  />
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
