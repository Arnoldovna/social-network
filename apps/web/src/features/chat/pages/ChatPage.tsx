import { useMemo, useState } from 'react';

import { errorMessage } from '../../../shared/api/problem';
import { useCurrentUser } from '../../../shared/session/use-current-user';
import { ErrorState } from '../../../shared/ui/ErrorState';
import { LoadingState } from '../../../shared/ui/LoadingState';
import { useGetChatMessagesInfiniteQuery, useSendChatMessageMutation } from '../chat.api';
import { ChatComposer } from '../components/ChatComposer';
import { ChatLog } from '../components/ChatLog';
import type { PendingChatMessage } from '../components/ChatLog';
import './ChatPage.css';

/** Replaces the entry with the same client id in place, or appends a new one. */
function upsertPending(list: PendingChatMessage[], entry: PendingChatMessage): PendingChatMessage[] {
  return list.some((item) => item.clientId === entry.clientId)
    ? list.map((item) => (item.clientId === entry.clientId ? entry : item))
    : [...list, entry];
}

/**
 * `/chat`, the one global room (F-76–F-83, F-85). History comes over HTTP, 20 messages per page, newest page first and
 * shown oldest at the top; live messages arrive through the socket into the same cache (`chat.api.ts`). Opening the
 * page only fetches this client's own history, so it never resets anyone else's view (F-85, legacy re-broadcast the
 * last messages to everyone on every connection).
 *
 * Sending: the message shows at once as "sending…" (local state with a client id, OVERVIEW §7), is replaced by the
 * confirmed message on ack (F-79), or stays as "Not sent" with "retry" and "discard". Sending the same text again from
 * the composer reuses that failed entry, so a message never appears twice.
 *
 * The draft lives here, not in the composer: every acknowledged message, sent from the composer or by "retry" in the
 * log, clears it while it still holds exactly that text (B-83). A failed send keeps the text in the field, so without
 * this a successful retry would leave it there for a second Enter to send again.
 *
 * The composer is rendered in every state, also while the history loads, fails or is empty (F-76, B-84).
 */
export function ChatPage() {
  const currentUser = useCurrentUser();
  const {
    data,
    isError,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useGetChatMessagesInfiniteQuery(undefined);
  const [sendChatMessage] = useSendChatMessageMutation();
  const [pending, setPending] = useState<PendingChatMessage[]>([]);
  const [draft, setDraft] = useState('');

  // The API pages newest first; the log reads oldest first (F-76).
  const messages = useMemo(
    () => (data === undefined ? [] : data.pages.flatMap((page) => page.items).reverse()),
    [data],
  );

  async function send(body: string, clientId?: string): Promise<void> {
    const id =
      clientId ??
      pending.find((entry) => entry.status === 'failed' && entry.body === body)?.clientId ??
      crypto.randomUUID();
    setPending((list) => upsertPending(list, { clientId: id, body, status: 'sending' }));
    try {
      await sendChatMessage(body).unwrap();
    } catch (sendError: unknown) {
      const reason = errorMessage(sendError);
      setPending((list) => upsertPending(list, { clientId: id, body, status: 'failed', reason }));
      return;
    }
    setPending((list) => list.filter((entry) => entry.clientId !== id));
    // Only while the field still holds exactly this text: whatever was typed while it was on its way survives.
    setDraft((current) => (current.trim() === body ? '' : current));
  }

  let history;
  if (data !== undefined) {
    history = (
      <ChatLog
        messages={messages}
        pending={pending}
        currentUser={currentUser}
        older={{
          hasMore: hasNextPage,
          isLoading: isFetchingNextPage,
          isError: isFetchNextPageError,
          onLoad: () => {
            void fetchNextPage();
          },
        }}
        onRetry={(entry) => {
          void send(entry.body, entry.clientId);
        }}
        onDiscard={(clientId) => {
          setPending((list) => list.filter((entry) => entry.clientId !== clientId));
        }}
      />
    );
  } else if (isError) {
    history = (
      <ErrorState
        title="The chat could not be loaded."
        message={errorMessage(error)}
        onRetry={() => {
          void refetch();
        }}
        retrying={isFetching}
      />
    );
  } else {
    history = <LoadingState label="loading messages…" />;
  }

  return (
    <div className="chat-page">
      <title>Chat · Let's chat!</title>
      <header className="chat-page__header">
        <h1 className="chat-page__title">Chat</h1>
        <p className="chat-page__intro">
          One room for everyone on Let's chat. Every member can read what you write here.
        </p>
      </header>
      <section className="chat-page__history" aria-label="Message history">
        {history}
      </section>
      <ChatComposer draft={draft} onDraftChange={setDraft} onSend={send} />
    </div>
  );
}
