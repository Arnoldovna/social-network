import type { ChatMessage, UserSummary } from '@app/shared';

import { Button } from '../../../shared/ui/Button';
import { EmptyState } from '../../../shared/ui/EmptyState';
import { FieldError } from '../../../shared/ui/FieldError';
import { useFitWholeRows } from '../use-fit-whole-rows';
import { useStickToBottom } from '../use-stick-to-bottom';
import { ChatMessageItem } from './ChatMessageItem';
import './ChatLog.css';

/** One of the viewer's messages on its way to the server, keyed by a client id until the ack replaces it (F-79). */
export interface PendingChatMessage {
  clientId: string;
  /** Trimmed, as it was sent. */
  body: string;
  status: 'sending' | 'failed';
  /** Set when `status` is `failed`. */
  reason?: string;
}

export interface OlderMessages {
  /** The last loaded page has a `nextCursor`. */
  hasMore: boolean;
  isLoading: boolean;
  isError: boolean;
  onLoad: () => void;
}

export interface ChatLogProps {
  /** Confirmed messages, oldest first (F-76). */
  messages: ChatMessage[];
  /** The viewer's messages without an ack yet, in the order they were sent; shown after the confirmed ones. */
  pending: PendingChatMessage[];
  /** The viewer: the author of pending messages and the owner of "own" messages. */
  currentUser: UserSummary | null;
  older: OlderMessages;
  onRetry: (message: PendingChatMessage) => void;
  onDiscard: (clientId: string) => void;
}

const messageKey = (message: ChatMessage) => `m-${String(message.id)}`;
const pendingKey = (message: PendingChatMessage) => `p-${message.clientId}`;

/**
 * The chat history as a live log (F-83, B-111): a `role="log"` region with `aria-live="polite"`, so screen readers
 * announce new messages without interrupting. It is its own scroll container and keyboard-scrollable (`tabIndex=0`),
 * with "load older messages" above it (F-82, a button instead of infinite scroll, ADR-0014) and the "new messages"
 * pill below it while the reader is scrolled up (F-81). While an older page loads the region is `aria-busy`, so the
 * page of history added on top is not read out as if it were new.
 */
export function ChatLog({ messages, pending, currentUser, older, onRetry, onDiscard }: ChatLogProps) {
  const shownPending = currentUser === null ? [] : pending;
  const oldest = messages[0];
  const newestPending = shownPending.at(-1);
  const newestMessage = messages.at(-1);
  const newestKey =
    newestPending === undefined
      ? newestMessage === undefined
        ? null
        : messageKey(newestMessage)
      : pendingKey(newestPending);
  const newestIsOwn =
    newestPending !== undefined || (newestMessage !== undefined && newestMessage.author.id === currentUser?.id);

  const { ref, onScroll, hasNewBelow, scrollToBottom } = useStickToBottom<HTMLDivElement>({
    oldestKey: oldest === undefined ? null : messageKey(oldest),
    newestKey,
    itemCount: messages.length + shownPending.length,
    followNewest: newestIsOwn,
  });

  const isEmpty = messages.length === 0 && shownPending.length === 0;
  useFitWholeRows(ref, !isEmpty);

  return (
    <div className="chat-log">
      {older.hasMore ? (
        <div className="chat-log__older">
          <Button onClick={older.onLoad} disabled={older.isLoading} aria-busy={older.isLoading ? true : undefined}>
            {older.isLoading ? 'loading older messages…' : 'load older messages'}
          </Button>
          {older.isError ? <FieldError>Older messages could not be loaded. Try again.</FieldError> : null}
        </div>
      ) : messages.length > 0 ? (
        <p className="chat-log__start">This is the beginning of the chat.</p>
      ) : null}

      <div
        ref={ref}
        className="chat-log__scroller"
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        aria-busy={older.isLoading ? true : undefined}
        // A scroll container must be reachable by keyboard to be scrolled without a pointer (WCAG 2.1.1).
        tabIndex={0}
        onScroll={onScroll}
      >
        {isEmpty ? (
          <EmptyState title="No messages yet." text="Write the first one below." />
        ) : (
          <ol className="chat-log__list">
            {messages.map((message) => (
              <ChatMessageItem
                key={messageKey(message)}
                author={message.author}
                body={message.body}
                createdAt={message.createdAt}
                isOwn={message.author.id === currentUser?.id}
              />
            ))}
            {currentUser === null
              ? null
              : shownPending.map((message) => (
                  <ChatMessageItem
                    key={pendingKey(message)}
                    author={currentUser}
                    body={message.body}
                    isOwn
                    delivery={
                      message.status === 'sending'
                        ? { state: 'sending' }
                        : {
                            state: 'failed',
                            reason: message.reason ?? 'Please try again.',
                            onRetry: () => {
                              onRetry(message);
                            },
                            onDiscard: () => {
                              onDiscard(message.clientId);
                            },
                          }
                    }
                  />
                ))}
          </ol>
        )}
      </div>

      {hasNewBelow ? (
        <div className="chat-log__new">
          <Button
            variant="outlined"
            onClick={() => {
              scrollToBottom();
              // The pill disappears; focus goes to the log it just scrolled instead of falling back to the page.
              ref.current?.focus();
            }}
          >
            new messages <span aria-hidden="true">↓</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
