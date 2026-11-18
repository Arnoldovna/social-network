import { CHAT_MAX, SendChatMessage } from '@app/shared';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Button } from '../../../shared/ui/Button';
import { TextArea } from '../../../shared/ui/TextArea';
import './ChatComposer.css';

/** The character count appears once a message gets long; a short chat line does not need it. */
export const COUNT_VISIBLE_FROM = CHAT_MAX - 200;

export const EMPTY_MESSAGE = 'Write a message first.';
export const TOO_LONG_MESSAGE = 'Keep your message to 1,000 characters.';

export interface ChatComposerProps {
  /**
   * The text in the field. The page owns it (OVERVIEW §7 "Form drafts"), because a message delivered by "retry" in the
   * log must clear it as well as one sent from here (B-83).
   */
  draft: string;
  /** Called with the new text on every edit by the user, and only then. */
  onDraftChange: (draft: string) => void;
  /**
   * Sends the trimmed text and settles once the send did: the page clears the draft after the acknowledgement and
   * marks a failed message "Not sent" with "retry". Until it settles, no second send starts from here.
   */
  onSend: (body: string) => Promise<unknown>;
}

/**
 * The message input below the log, always rendered, also in an empty chat (F-76, B-84). Enter sends, Shift+Enter
 * starts a new line (F-78); an IME composition's Enter only confirms the composition. Text is 1–1,000 characters
 * after trimming, checked with the shared `SendChatMessage` schema before anything is sent.
 *
 * The draft is a controlled value that only the user's typing changes here: incoming messages re-render the page
 * around it without touching it (B-83, F-80). Clearing it after the own message was acknowledged is the page's job
 * (`ChatPage`), which also knows about a retry from the log. A failed send keeps the draft.
 */
export function ChatComposer({ draft, onDraftChange, onSend }: ChatComposerProps) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const length = draft.trim().length;

  async function submit(): Promise<void> {
    if (sending) {
      return;
    }
    const parsed = SendChatMessage.safeParse({ body: draft });
    if (!parsed.success) {
      setError(length === 0 ? EMPTY_MESSAGE : TOO_LONG_MESSAGE);
      return;
    }
    setError(undefined);
    setSending(true);
    try {
      await onSend(parsed.data.body);
    } catch {
      // The page reports a failed send in the log; a rejection is never left unhandled here either.
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (length === 0) {
      // Enter in an empty field does nothing: no message, no newline, no error to dismiss.
      return;
    }
    void submit();
  }

  return (
    <form
      className="chat-composer"
      aria-label="Write a message"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="chat-composer__row">
        <TextArea
          className="chat-composer__field"
          label="message"
          name="body"
          rows={2}
          autoComplete="off"
          value={draft}
          onChange={(event) => {
            onDraftChange(event.target.value);
            setError(undefined);
          }}
          onKeyDown={handleKeyDown}
          hint="Enter sends, Shift+Enter starts a new line."
          error={error}
          {...(length >= COUNT_VISIBLE_FROM ? { characterCount: { length, max: CHAT_MAX } } : {})}
        />
        <Button
          type="submit"
          variant="outlined"
          className="chat-composer__send"
          disabled={sending}
          aria-busy={sending ? true : undefined}
        >
          send
        </Button>
      </div>
    </form>
  );
}
