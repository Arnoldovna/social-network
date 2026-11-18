import { CHAT_MAX } from '@app/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ChatComposer, EMPTY_MESSAGE, TOO_LONG_MESSAGE } from '../components/ChatComposer';

/** A promise the test settles itself, to look at the composer while a send is still waiting for its ack. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Holds the draft like `ChatPage` does. Clearing it after an acknowledged send is the page's part and is tested with
 * the page (`ChatLog.test.tsx`); here the draft only ever changes by typing.
 */
function DraftOwner({ onSend }: { onSend: (body: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState('');
  return <ChatComposer draft={draft} onDraftChange={setDraft} onSend={onSend} />;
}

function setup(onSend: (body: string) => Promise<unknown> = vi.fn(() => Promise.resolve())) {
  const user = userEvent.setup();
  const result = render(<DraftOwner onSend={onSend} />);
  const field = screen.getByRole('textbox', { name: 'message' });
  const sendButton = screen.getByRole('button', { name: 'send' });
  return { ...result, user, field, sendButton, onSend };
}

describe('ChatComposer', () => {
  it('F-78: Enter sends the trimmed message', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const { user, field } = setup(onSend);

    await user.type(field, '  Is anyone going to the ceramics market on Saturday?  {Enter}');

    expect(onSend).toHaveBeenCalledExactlyOnceWith('Is anyone going to the ceramics market on Saturday?');
  });

  it('F-78: Shift+Enter starts a new line instead of sending', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const { user, field } = setup(onSend);

    await user.type(field, 'First line{Shift>}{Enter}{/Shift}second line');

    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue('First line\nsecond line');

    await user.click(screen.getByRole('button', { name: 'send' }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('First line\nsecond line');
  });

  it('F-78: an empty or whitespace-only message cannot be sent', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const { user, field, sendButton } = setup(onSend);

    await user.type(field, '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(sendButton);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(EMPTY_MESSAGE);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(expect.stringContaining(EMPTY_MESSAGE));

    // Typing again clears the error.
    await user.type(field, 'Hello');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('F-78: more than 1,000 characters after trimming is not sent and the count says how many are too many', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const { user, field } = setup(onSend);

    await user.click(field);
    await user.paste('a'.repeat(CHAT_MAX + 2));
    expect(screen.getByText('2 characters too many')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(TOO_LONG_MESSAGE);
    expect(field).toHaveValue('a'.repeat(CHAT_MAX + 2));
  });

  it('F-78: exactly 1,000 characters can be sent; the count only appears for long messages', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const { user, field } = setup(onSend);

    await user.type(field, 'Short');
    expect(screen.queryByText(/characters left/)).not.toBeInTheDocument();

    await user.clear(field);
    await user.paste('b'.repeat(CHAT_MAX));
    expect(screen.getByText('0 characters left')).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledExactlyOnceWith('b'.repeat(CHAT_MAX));
  });

  it('B-83: while the message waits for its ack, the text stays and a second send is blocked', async () => {
    const ack = deferred<undefined>();
    const onSend = vi.fn(() => ack.promise);
    const { user, field, sendButton } = setup(onSend);

    await user.type(field, 'See you at the station at nine{Enter}');

    expect(field).toHaveValue('See you at the station at nine');
    expect(sendButton).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledOnce();

    ack.resolve(undefined);
    await vi.waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
  });

  it('B-83: a failed send keeps the draft, also when the send rejects', async () => {
    const onSend = vi.fn(() => Promise.reject(new Error('socket gone')));
    const { user, field, sendButton } = setup(onSend);

    await user.type(field, 'Does the 14:05 train still run?{Enter}');

    await vi.waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    expect(field).toHaveValue('Does the 14:05 train still run?');
  });

  it('B-83: only typing changes the draft; re-rendering for an incoming message never does', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const onSend = vi.fn(() => Promise.resolve());
    const { rerender } = render(<ChatComposer draft="Half a thought" onDraftChange={onDraftChange} onSend={onSend} />);

    rerender(<ChatComposer draft="Half a thought" onDraftChange={onDraftChange} onSend={onSend} />);
    rerender(<ChatComposer draft="Half a thought" onDraftChange={onDraftChange} onSend={onSend} />);
    expect(screen.getByRole('textbox', { name: 'message' })).toHaveValue('Half a thought');
    expect(onDraftChange).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: 'message' }), '!');
    expect(onDraftChange).toHaveBeenCalledExactlyOnceWith('Half a thought!');
  });

  it('F-78: Enter that confirms an IME composition does not send', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const { user, field } = setup(onSend);

    await user.type(field, 'nihao');
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue('nihao');
  });

  it('labels the field and explains the keys', () => {
    const { field } = setup();

    expect(screen.getByRole('form', { name: 'Write a message' })).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription('Enter sends, Shift+Enter starts a new line.');
  });
});
