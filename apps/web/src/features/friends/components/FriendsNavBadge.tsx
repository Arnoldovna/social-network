import { formatCount } from '../../../shared/lib/format-count';
import { VisuallyHidden } from '../../../shared/ui/VisuallyHidden';
import { incomingRequestsLabel } from '../friend-button-labels';
import { useGetFriendshipsQuery } from '../friends.api';
import './FriendsNavBadge.css';

/**
 * The number of friend requests waiting for an answer, beside the "friends" navigation link (F-52): a small rose field
 * with the count, read as "2 friend requests". It reads the one `getFriendships` cache, which `friendship:changed`
 * refetches, so a new request shows up in real time (B-92); answering a request lowers it at once (F-55).
 *
 * The live region stays mounted while the count is zero, so the first new request is announced politely. Nothing is
 * shown while the lists load or fail: a missing badge is the honest state.
 */
export function FriendsNavBadge() {
  const { data } = useGetFriendshipsQuery(undefined);
  const count = data?.incoming.length ?? 0;

  return (
    <span className="friends-nav-badge" role="status">
      {count === 0 ? null : (
        <span className="friends-nav-badge__count">
          <span aria-hidden="true">{formatCount(count)}</span>
          <VisuallyHidden>{incomingRequestsLabel(count)}</VisuallyHidden>
        </span>
      )}
    </span>
  );
}
