import type { UserSummary } from '@app/shared';
import { useId } from 'react';
import { Link } from 'react-router';

import { fullName } from '../../../shared/lib/names';
import { profilePath } from '../../../shared/lib/paths';
import { tokenList } from '../../../shared/lib/token-list';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { RelativeTime } from '../../../shared/ui/RelativeTime';
import './ChatMessageItem.css';

/** A message of the viewer's that has no server acknowledgement yet (local state of the page, OVERVIEW §7). */
export type ChatDelivery =
  | { state: 'sending' }
  | {
      state: 'failed';
      /** Why it was not sent, as one sentence (the mapped `ApiError` message). */
      reason: string;
      onRetry: () => void;
      onDiscard: () => void;
    };

export interface ChatMessageItemProps {
  author: UserSummary;
  body: string;
  /** The server's `createdAt`; absent while the message is pending. */
  createdAt?: string;
  /** The viewer wrote it. */
  isOwn: boolean;
  /** Only for the viewer's own pending messages. */
  delivery?: ChatDelivery;
}

/**
 * One chat message as a maw list row (ADR-0015): avatar, author name linked to the profile and the time on the meta
 * line, the text below (F-77, B-99: legacy showed an avatar and a raw ISO string). The text keeps its line breaks
 * (Shift+Enter, F-78) and is rendered by React as text, never as HTML. A pending message says "sending…" instead of a
 * time; a failed one says "Not sent" with the reason and offers "retry" and "discard" (F-79).
 */
export function ChatMessageItem({ author, body, createdAt, isOwn, delivery }: ChatMessageItemProps) {
  const bodyId = useId();
  const failed = delivery?.state === 'failed';

  return (
    <li
      className={tokenList(
        'chat-message',
        isOwn && 'chat-message--own',
        delivery?.state === 'sending' && 'chat-message--sending',
        failed && 'chat-message--failed',
      )}
    >
      <Avatar
        className="chat-message__avatar"
        firstName={author.firstName}
        lastName={author.lastName}
        src={author.avatarUrl}
      />
      <div className="chat-message__content">
        <p className="chat-message__meta">
          <Link className="chat-message__author" to={profilePath(author.id)}>
            {fullName(author)}
          </Link>
          {createdAt === undefined ? (
            delivery?.state === 'sending' ? (
              <span className="chat-message__status">sending…</span>
            ) : null
          ) : (
            <RelativeTime className="chat-message__time" dateTime={createdAt} />
          )}
        </p>
        <p id={bodyId} className="chat-message__body">
          {body}
        </p>
        {failed ? (
          <div className="chat-message__failure">
            <p className="chat-message__reason">Not sent — {delivery.reason}</p>
            <div className="chat-message__actions">
              <Button aria-describedby={bodyId} onClick={delivery.onRetry}>
                retry
              </Button>
              <Button aria-describedby={bodyId} onClick={delivery.onDiscard}>
                discard
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}
