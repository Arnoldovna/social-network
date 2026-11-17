import type { WallPost } from '@app/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { errorMessage, hasErrorCode } from '../../../shared/api/problem';
import { useConfirm } from '../../../shared/lib/use-confirm';
import { fullName } from '../../../shared/lib/names';
import { useCurrentUser } from '../../../shared/session/use-current-user';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../../shared/ui/EmptyState';
import { ErrorState } from '../../../shared/ui/ErrorState';
import { LoadingState } from '../../../shared/ui/LoadingState';
import { VisuallyHidden } from '../../../shared/ui/VisuallyHidden';
import { useDeletePostMutation, useGetWallPostsInfiniteQuery, wallPostsOf } from '../wall.api';
import { WallComposer } from './WallComposer';
import { WallPostList } from './WallPostList';
import './Wall.css';

/** The props fixed in Phase 1c (BUILD-ORDER "Web feature exports"); the profile pages pass them from `getUser`. */
export interface WallProps {
  ownerId: number;
  ownerFirstName: string;
  /** `relationship.canViewWall` from the server: the owner and accepted friends (F-65, ADR-0011). */
  canView: boolean;
  /** `relationship.canPostOnWall` from the server (F-66, B-90). */
  canPost: boolean;
}

/**
 * A profile's wall (F-65–F-75). Who may read and write comes from the server's `relationship` flags, never from a
 * client-side friends lookup (B-90); without read access no request is made and the wall says how to get it (F-65).
 *
 * The posts live in their own subtree keyed by the owner's id, so moving from one profile to the next starts a fresh
 * view: loading, never the previous person's posts (B-91), and a fresh draft.
 */
export function Wall({ ownerId, ownerFirstName, canView, canPost }: WallProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  return (
    <section className="wall" aria-labelledby={headingId}>
      {/* Focus target after a deleted post, whose button is gone (tabIndex -1: focusable by script only). */}
      <h2 id={headingId} ref={headingRef} className="wall__title" tabIndex={-1}>
        wall
      </h2>
      {canView ? (
        <WallPosts
          key={ownerId}
          ownerId={ownerId}
          ownerFirstName={ownerFirstName}
          canPost={canPost}
          headingRef={headingRef}
        />
      ) : (
        <p className="wall__locked">Become friends with {ownerFirstName} to see their wall.</p>
      )}
    </section>
  );
}

interface WallPostsProps {
  ownerId: number;
  ownerFirstName: string;
  canPost: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
}

/** One polite announcement; a new `id` makes the same sentence count as new (two posts by the same person). */
interface Announcement {
  id: number;
  text: string;
}

function describeArrivals(arrivals: WallPost[]): string {
  const [only] = arrivals;
  return arrivals.length === 1 && only !== undefined
    ? `New post from ${fullName(only.author)}.`
    : `${String(arrivals.length)} new posts.`;
}

function WallPosts({ ownerId, ownerFirstName, canPost, headingRef }: WallPostsProps) {
  const viewer = useCurrentUser();
  const viewerId = viewer?.id ?? null;
  // `currentData` belongs to this owner only; `data` would briefly show another wall's posts (B-91).
  const {
    currentData,
    isError,
    error,
    isFetching,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useGetWallPostsInfiniteQuery(ownerId);
  const posts = wallPostsOf(currentData);

  const [deletePost] = useDeletePostMutation();
  const [focusRequests, setFocusRequests] = useState(0);
  const [announcement, setAnnouncement] = useState<Announcement>({ id: 0, text: '' });
  const announce = (text: string) => {
    setAnnouncement((previous) => ({ id: previous.id + 1, text }));
  };

  const confirmDelete = useConfirm<WallPost>(
    async (post) => {
      try {
        await deletePost({ id: post.id, ownerId }).unwrap();
      } catch (deleteError: unknown) {
        // Already deleted elsewhere: the post has left the cache, which is what the user asked for.
        if (!hasErrorCode(deleteError, 'post-not-found')) {
          throw deleteError;
        }
      }
    },
    {
      onConfirmed: () => {
        setFocusRequests((count) => count + 1);
        announce('Post deleted.');
      },
    },
  );

  // Runs in the commit that closes the dialog, after the dialog returned focus to the (vanishing) delete button.
  useEffect(() => {
    if (focusRequests > 0) {
      headingRef.current?.focus();
    }
  }, [focusRequests, headingRef]);

  /*
   * Posts from others that arrive while the wall is open are announced politely (B-111): the newest id grows. The
   * previous newest id is state from the last render (React's "storing information from previous renders"), so
   * loading the first page or older pages announces nothing, and own posts are announced by the composer.
   *
   * `undefined` means "not loaded yet" and `null` "loaded, but empty", so the first post on an empty wall counts as an
   * arrival like any other, while the first page arriving does not.
   */
  const newestId = currentData === undefined ? undefined : (posts[0]?.id ?? null);
  const [seenNewestId, setSeenNewestId] = useState(newestId);
  if (newestId !== seenNewestId) {
    setSeenNewestId(newestId);
    if (seenNewestId !== undefined && newestId !== undefined) {
      const arrivals = posts.filter(
        (post) => (seenNewestId === null || post.id > seenNewestId) && post.author.id !== viewerId,
      );
      if (arrivals.length > 0) {
        announce(describeArrivals(arrivals));
      }
    }
  }

  let content;
  if (currentData === undefined) {
    content = isError ? (
      <ErrorState
        title="The posts could not be loaded."
        message={errorMessage(error)}
        onRetry={() => {
          void refetch();
        }}
        retrying={isFetching}
      />
    ) : (
      <LoadingState label="loading posts…" />
    );
  } else if (posts.length === 0) {
    content = <EmptyState title="No posts yet." text={canPost ? 'Write the first one.' : undefined} />;
  } else {
    content = (
      <WallPostList
        posts={posts}
        viewerId={viewerId}
        onDelete={confirmDelete.request}
        hasOlder={hasNextPage}
        loadingOlder={isFetchingNextPage}
        loadOlderError={isFetchNextPageError ? errorMessage(error) : undefined}
        onLoadOlder={() => {
          void fetchNextPage();
        }}
      />
    );
  }

  return (
    <div className="wall__body">
      {canPost ? <WallComposer ownerId={ownerId} ownerFirstName={ownerFirstName} /> : null}
      {content}
      <VisuallyHidden as="div" role="status">
        <span key={announcement.id}>{announcement.text}</span>
      </VisuallyHidden>
      <ConfirmDialog
        {...confirmDelete.dialogProps}
        title="Delete this post?"
        message="It disappears from the wall for everyone. This cannot be undone."
        confirmLabel="delete post"
      />
    </div>
  );
}
