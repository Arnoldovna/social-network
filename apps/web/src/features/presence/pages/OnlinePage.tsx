import { useId, useMemo } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../../../shared/api/problem';
import { pluralize } from '../../../shared/lib/format-count';
import { useCurrentUser } from '../../../shared/session/use-current-user';
import { EmptyState } from '../../../shared/ui/EmptyState';
import { ErrorState } from '../../../shared/ui/ErrorState';
import { LoadingState } from '../../../shared/ui/LoadingState';
import { UserRow } from '../../../shared/ui/UserRow';
import { onlineUsersSelectors, useGetOnlineUsersQuery } from '../presence.api';
import './OnlinePage.css';

/** "1 person online", "1,284 people online" (maw-design-system §10). */
function onlineCount(count: number): string {
  return `${pluralize(count, 'person', 'people')} online`;
}

/**
 * `/online` (F-86–F-89): everyone else with at least one open connection, as list rows with avatar and a name that
 * links to the profile (B-93), in name order. The list is the `getOnlineUsers` cache, which the socket keeps current,
 * so people appear and disappear without a reload and never twice (F-87, F-88, B-87). The current user is never
 * listed: the API leaves them out, and the page filters them as well, so a stray event cannot add them (B-46).
 *
 * The count sits in a polite live region, so screen reader users hear when someone joins or leaves. Loading, error
 * (with "try again") and empty states replace the list (F-89, F-105). Data comes only from RTK Query; there is no
 * dispatch of its own (B-89).
 */
export function OnlinePage() {
  const titleId = useId();
  const currentUser = useCurrentUser();
  const { data, error, isLoading, isError, isFetching, refetch } = useGetOnlineUsersQuery(undefined, {
    // Presence goes stale within seconds; a page visit after a while away always asks the server again.
    refetchOnMountOrArgChange: true,
  });

  const people = useMemo(() => {
    if (data === undefined) {
      return [];
    }
    const everyone = onlineUsersSelectors.selectAll(data);
    return currentUser === null ? everyone : everyone.filter((person) => person.id !== currentUser.id);
  }, [data, currentUser]);

  const showList = !isError && data !== undefined;

  return (
    <div className="online-page">
      <title>Online · Let's chat!</title>
      <header className="online-page__header">
        <h1 className="online-page__title" id={titleId}>
          Online
        </h1>
        <p className="online-page__count" role="status">
          {showList && people.length > 0 ? onlineCount(people.length) : ''}
        </p>
      </header>

      {isLoading ? <LoadingState label="loading who is online…" /> : null}

      {isError ? (
        <ErrorState
          title="The online list could not be loaded."
          message={errorMessage(error, 'Check your connection, then try again.')}
          onRetry={() => {
            void refetch();
          }}
          retrying={isFetching}
        />
      ) : null}

      {showList && people.length === 0 ? (
        <EmptyState
          title="Nobody else is online right now."
          text="This list updates on its own as soon as someone signs in."
          action={
            <Link className="online-page__link" to="/chat">
              go to the chat
            </Link>
          }
        />
      ) : null}

      {showList && people.length > 0 ? (
        <ul className="online-page__list" aria-labelledby={titleId}>
          {people.map((person) => (
            <UserRow key={person.id} user={person} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
