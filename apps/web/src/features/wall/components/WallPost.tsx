import type { WallPost as WallPostData } from '@app/shared';
import { useId } from 'react';
import { Link } from 'react-router';

import { fullName } from '../../../shared/lib/names';
import { profilePath } from '../../../shared/lib/paths';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { RelativeTime } from '../../../shared/ui/RelativeTime';
import { VisuallyHidden } from '../../../shared/ui/VisuallyHidden';
import './WallPost.css';

export interface WallPostProps {
  post: WallPostData;
  /** From the shared policy `canDeleteWallPost` (author or wall owner, F-71, B-90); the server enforces it again. */
  canDelete: boolean;
  /** Asks for the confirmation; the caller owns the dialog. */
  onDelete: (post: WallPostData) => void;
}

/**
 * One post as a maw row (ADR-0015): the author's avatar and linked name, a relative timestamp in `<time datetime>`
 * with the absolute date as its title, and the text (F-69, B-99). Text only, so there is no image besides the avatar
 * (F-68 dropped, B-71). The text is rendered as text, line breaks kept, never as HTML.
 *
 * The author's name is the post's heading, so screen-reader users can jump from post to post; "delete post" carries
 * the author's name for assistive technology, because every post has the same visible label.
 */
export function WallPost({ post, canDelete, onDelete }: WallPostProps) {
  const headingId = useId();
  const authorName = fullName(post.author);

  return (
    <article className="wall-post" aria-labelledby={headingId}>
      <Avatar
        firstName={post.author.firstName}
        lastName={post.author.lastName}
        src={post.author.avatarUrl}
        size="medium"
        className="wall-post__avatar"
      />
      <div className="wall-post__content">
        <header className="wall-post__header">
          <h3 id={headingId} className="wall-post__author">
            <Link className="wall-post__author-link" to={profilePath(post.author.id)}>
              {authorName}
            </Link>
          </h3>
          <RelativeTime dateTime={post.createdAt} className="wall-post__time" />
        </header>
        <p className="wall-post__body">{post.body}</p>
        {canDelete ? (
          <Button
            className="wall-post__delete"
            onClick={() => {
              onDelete(post);
            }}
          >
            delete post<VisuallyHidden> by {authorName}</VisuallyHidden>
          </Button>
        ) : null}
      </div>
    </article>
  );
}
