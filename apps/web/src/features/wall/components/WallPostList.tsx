import { canDeleteWallPost } from '@app/shared';
import type { WallPost as WallPostData } from '@app/shared';

import { Button } from '../../../shared/ui/Button';
import { FieldError } from '../../../shared/ui/FieldError';
import { WallPost } from './WallPost';
import './WallPostList.css';

export interface WallPostListProps {
  /** Newest first (F-70). */
  posts: WallPostData[];
  /** The signed-in viewer, for the delete policy; `null` shows no delete buttons. */
  viewerId: number | null;
  onDelete: (post: WallPostData) => void;
  /** The server returned a cursor for older posts. */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** The sentence to show when the last "load older posts" failed; the button stays to try again. */
  loadOlderError: string | undefined;
  onLoadOlder: () => void;
}

/**
 * The posts of one wall, newest first, as an ordered list of rows, with a "load older posts" button below while the
 * server has more (F-70, ADR-0014: a button, not infinite scroll, so keyboard users reach everything after the list).
 * Each post's delete button follows the shared policy, the same function the server runs (F-71, B-90).
 */
export function WallPostList({
  posts,
  viewerId,
  onDelete,
  hasOlder,
  loadingOlder,
  loadOlderError,
  onLoadOlder,
}: WallPostListProps) {
  return (
    <div className="wall-post-list">
      <ol className="wall-post-list__items">
        {posts.map((post) => (
          <li key={post.id} className="wall-post-list__item">
            <WallPost
              post={post}
              canDelete={viewerId !== null && canDeleteWallPost(viewerId, post)}
              onDelete={onDelete}
            />
          </li>
        ))}
      </ol>
      {hasOlder ? (
        <div className="wall-post-list__more">
          {/* aria-disabled instead of disabled: a disabled button drops focus to the page, this one keeps it while
              the older page loads, so keyboard users stay where they were. */}
          <Button
            variant="outlined"
            className="wall-post-list__load"
            onClick={loadingOlder ? undefined : onLoadOlder}
            aria-disabled={loadingOlder ? true : undefined}
            aria-busy={loadingOlder ? true : undefined}
          >
            {loadingOlder ? 'loading older posts…' : 'load older posts'}
          </Button>
          <FieldError>{loadOlderError}</FieldError>
        </div>
      ) : null}
    </div>
  );
}
