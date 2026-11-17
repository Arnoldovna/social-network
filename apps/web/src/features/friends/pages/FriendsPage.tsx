import { useState } from 'react';

import { errorMessage } from '../../../shared/api/problem';
import { pluralize } from '../../../shared/lib/format-count';
import { ErrorState } from '../../../shared/ui/ErrorState';
import { LoadingState } from '../../../shared/ui/LoadingState';
import { Toast, toastMessage } from '../../../shared/ui/Toast';
import type { ToastMessage, ToastTone } from '../../../shared/ui/Toast';
import { FriendSection } from '../components/FriendSection';
import type { FriendActionResult } from '../components/FriendButton';
import { useGetFriendshipsQuery } from '../friends.api';
import './FriendsPage.css';

interface Notice {
  message: ToastMessage;
  tone: ToastTone;
}

/**
 * `/friends` (F-54–F-57): "friend requests" (incoming, waiting for an answer, so first), "friends" and "sent requests".
 * The lists are refetched every time the page opens (F-57, `refetchOnMountOrArgChange`) and whenever a
 * `friendship:changed` event arrives (`friends.api.ts`), so they are never stale (B-92). Actions update the lists from
 * the server's answer without a reload: an accepted request moves to "friends" (F-55). What happened is shown in a
 * toast, which outlives the row it came from.
 */
export function FriendsPage() {
  const { data, error, isError, isFetching, refetch } = useGetFriendshipsQuery(undefined, {
    refetchOnMountOrArgChange: true,
  });
  const [notice, setNotice] = useState<Notice | null>(null);

  const showDone = ({ message }: FriendActionResult) => {
    setNotice({ message: toastMessage(message), tone: 'status' });
  };
  const showError = (message: string) => {
    setNotice({ message: toastMessage(message), tone: 'error' });
  };

  let content;
  if (data !== undefined) {
    content = (
      <div className="friends-page__sections">
        <FriendSection
          kind="pending_incoming"
          title="friend requests"
          entries={data.incoming}
          countLabel={(count) => pluralize(count, 'request', 'requests')}
          emptyTitle="No friend requests right now."
          emptyText="When someone sends you a friend request, it appears here."
          onDone={showDone}
          onError={showError}
        />
        <FriendSection
          kind="friends"
          title="friends"
          entries={data.friends}
          countLabel={(count) => pluralize(count, 'friend', 'friends')}
          emptyTitle="You have not added any friends yet."
          emptyText="Use the search in the header to find people you know."
          onDone={showDone}
          onError={showError}
        />
        <FriendSection
          kind="pending_outgoing"
          title="sent requests"
          entries={data.outgoing}
          countLabel={(count) => pluralize(count, 'request', 'requests')}
          emptyTitle="No sent requests."
          emptyText="Requests you send wait here until they are answered."
          onDone={showDone}
          onError={showError}
        />
      </div>
    );
  } else if (isError) {
    content = (
      <ErrorState
        title="Your friends could not be loaded."
        message={errorMessage(error)}
        onRetry={() => {
          void refetch();
        }}
        retrying={isFetching}
      />
    );
  } else {
    content = <LoadingState label="loading friends…" />;
  }

  return (
    <div className="friends-page">
      <title>Friends · Let's chat!</title>
      <h1 className="friends-page__title">Friends</h1>
      {content}
      <Toast
        message={notice?.message ?? null}
        tone={notice?.tone ?? 'status'}
        onDismiss={() => {
          setNotice(null);
        }}
      />
    </div>
  );
}
