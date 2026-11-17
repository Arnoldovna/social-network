import type { ChatMessage, ChatPage as ChatPageDto, UserSummary } from '@app/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA, signInAs } from '../../../shared/api/__tests__/fixtures';
import { apiUrl, http, HttpResponse, problemResponse, server } from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { ChatLog } from '../components/ChatLog';
import type { PendingChatMessage } from '../components/ChatLog';
import { ChatPage } from '../pages/ChatPage';

/*
 * The socket of the tab is replaced by a fake that records `chat:send` and lets the test deliver `chat:message` like
 * the server's broadcast. Everything else (RTK Query cache, MSW for `GET /api/chat/messages`) is real.
 */
type Listener = (payload: unknown) => void;

const fakeSocket = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  const socket = {
    connected: true,
    emitWithAck: vi.fn<(event: string, payload: unknown) => Promise<unknown>>(),
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return socket;
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return socket;
    },
    timeout(_ms: number) {
      return { emitWithAck: socket.emitWithAck };
    },
    /** What the server's `io.to(rooms.chat).emit(...)` does for this client. */
    deliver(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    reset() {
      listeners.clear();
      socket.connected = true;
      socket.emitWithAck.mockReset();
    },
  };
  return socket;
});

vi.mock('../../../shared/realtime/socket', () => ({ getSocket: () => fakeSocket }));

afterEach(() => {
  fakeSocket.reset();
});

const MIRA_SUMMARY: UserSummary = {
  id: MIRA.id,
  firstName: MIRA.firstName,
  lastName: MIRA.lastName,
  avatarUrl: MIRA.avatarUrl,
};
const JONAS: UserSummary = { id: 2, firstName: 'Jonas', lastName: 'Weber', avatarUrl: null };
const ADA: UserSummary = {
  id: 3,
  firstName: 'Ada',
  lastName: 'Brennan',
  avatarUrl: '/api/users/3/avatar?v=0b7e9f52-4c1d-4a3e-9f6b-2d8c5e1a7f30',
};

function message(id: number, author: UserSummary, body: string, minute: number): ChatMessage {
  return { id, author, body, createdAt: new Date(Date.UTC(2026, 10, 17, 9, minute)).toISOString() };
}

const HISTORY = [
  message(11, JONAS, 'Morning! Who brought the good coffee to the studio?', 2),
  message(12, ADA, 'That was me. Help yourselves, there is plenty.', 4),
  message(13, MIRA_SUMMARY, 'Thank you, Ada. The glaze tests are out of the kiln.', 6),
];

/** Newest first, as the API pages them. */
function page(items: ChatMessage[], nextCursor: string | null = null): ChatPageDto {
  return { items: [...items].reverse(), nextCursor };
}

function texts(log: HTMLElement): string[] {
  return within(log)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.chat-message__body')?.textContent ?? '');
}

/** happy-dom does no layout; the log gets a fixed geometry so scroll positions can be asserted. */
function giveGeometry(element: HTMLElement, geometry: { scrollHeight: number; clientHeight: number }) {
  let scrollTop = 0;
  const state = { ...geometry };
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => state.scrollHeight },
    clientHeight: { configurable: true, get: () => state.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, state.scrollHeight - state.clientHeight));
      },
    },
  });
  return state;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('ChatLog', () => {
  type LogProps = ComponentProps<typeof ChatLog>;

  function logProps(overrides: Partial<LogProps> = {}): LogProps {
    return {
      messages: HISTORY,
      pending: [],
      currentUser: MIRA_SUMMARY,
      older: { hasMore: false, isLoading: false, isError: false, onLoad: vi.fn() },
      onRetry: vi.fn(),
      onDiscard: vi.fn(),
      ...overrides,
    };
  }

  function renderLog(overrides: Partial<LogProps> = {}) {
    const user = userEvent.setup();
    const result = render(<ChatLog {...logProps(overrides)} />, { wrapper: MemoryRouter });
    return { ...result, user, log: screen.getByRole('log', { name: 'Chat messages' }) };
  }

  it('F-83, B-111: the messages are a polite live log that can be scrolled by keyboard', () => {
    const { log } = renderLog();

    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('tabindex', '0');
    expect(texts(log)).toHaveLength(3);
  });

  it('B-99, F-77: every message shows avatar, author name linked to the profile, text and a <time>', () => {
    const { log } = renderLog();
    const [, adasMessage] = within(log).getAllByRole('listitem');
    if (adasMessage === undefined) {
      throw new Error('expected a second message');
    }

    expect(within(adasMessage).getByRole('img', { name: "Ada Brennan's profile picture" })).toBeInTheDocument();
    expect(within(adasMessage).getByRole('link', { name: 'Ada Brennan' })).toHaveAttribute('href', '/users/3');
    expect(within(adasMessage).getByText('That was me. Help yourselves, there is plenty.')).toBeInTheDocument();
    const time = adasMessage.querySelector('time');
    expect(time).toHaveAttribute('datetime', '2026-11-17T09:04:00.000Z');
    expect(time).toHaveAttribute('title', expect.stringMatching(/^17 Nov 2026, \d\d:04$/));
    // Initials stand in for a missing picture, still with the alt text.
    expect(within(log).getByRole('img', { name: "Jonas Weber's profile picture" })).toHaveTextContent('JW');
  });

  it('keeps line breaks and renders markup in a message as plain text', () => {
    const { log } = renderLog({
      messages: [message(21, JONAS, 'Line one\n<b>not bold</b>', 10)],
    });

    const body = log.querySelector('.chat-message__body');
    expect(body?.textContent).toBe('Line one\n<b>not bold</b>');
    expect(log.querySelector('b')).toBeNull();
  });

  it('F-82: "load older messages" asks for the previous page; at the start the log says so', async () => {
    const onLoad = vi.fn();
    const { user, rerender } = renderLog({ older: { hasMore: true, isLoading: false, isError: false, onLoad } });

    await user.click(screen.getByRole('button', { name: 'load older messages' }));
    expect(onLoad).toHaveBeenCalledOnce();

    rerender(<ChatLog {...logProps({ older: { hasMore: true, isLoading: true, isError: false, onLoad } })} />);
    expect(screen.getByRole('button', { name: 'loading older messages…' })).toBeDisabled();
    // The added history is not announced as new messages.
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');

    rerender(<ChatLog {...logProps({ older: { hasMore: true, isLoading: false, isError: true, onLoad } })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Older messages could not be loaded. Try again.');

    rerender(<ChatLog {...logProps()} />);
    expect(screen.queryByRole('button', { name: /older messages/ })).not.toBeInTheDocument();
    expect(screen.getByText('This is the beginning of the chat.')).toBeInTheDocument();
  });

  it('B-85: an empty chat renders without a crash, and the first message is followed into view', () => {
    const { log, rerender } = renderLog({ messages: [] });
    expect(within(log).getByText('No messages yet.')).toBeInTheDocument();

    const geometry = giveGeometry(log, { scrollHeight: 300, clientHeight: 300 });
    geometry.scrollHeight = 900;
    rerender(<ChatLog {...logProps({ messages: [message(30, JONAS, 'Is this thing on?', 20)] })} />);

    expect(log.scrollTop).toBe(600);
    expect(texts(log)).toEqual(['Is this thing on?']);
  });

  it('B-85, F-81: a new message scrolls into view only when the reader is at the bottom', () => {
    const { log, rerender } = renderLog();
    const geometry = giveGeometry(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 600;
    fireEvent.scroll(log);

    geometry.scrollHeight = 1100;
    rerender(<ChatLog {...logProps({ messages: [...HISTORY, message(14, JONAS, 'Can I see them later?', 8)] })} />);

    expect(log.scrollTop).toBe(700);
    expect(screen.queryByRole('button', { name: /new messages/ })).not.toBeInTheDocument();
  });

  it('B-85, F-81: scrolled up, a new message leaves the position alone and shows the "new messages" pill', async () => {
    const { log, user, rerender } = renderLog();
    const geometry = giveGeometry(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 120;
    fireEvent.scroll(log);

    geometry.scrollHeight = 1100;
    rerender(<ChatLog {...logProps({ messages: [...HISTORY, message(14, JONAS, 'Can I see them later?', 8)] })} />);

    expect(log.scrollTop).toBe(120);
    await user.click(screen.getByRole('button', { name: /new messages/ }));

    expect(log.scrollTop).toBe(700);
    expect(log).toHaveFocus();
    expect(screen.queryByRole('button', { name: /new messages/ })).not.toBeInTheDocument();
  });

  it('F-81: the reader reaching the bottom by scrolling hides the pill', () => {
    const { log, rerender } = renderLog();
    const geometry = giveGeometry(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 0;
    fireEvent.scroll(log);
    geometry.scrollHeight = 1100;
    rerender(<ChatLog {...logProps({ messages: [...HISTORY, message(14, ADA, 'Count me in.', 8)] })} />);
    expect(screen.getByRole('button', { name: /new messages/ })).toBeInTheDocument();

    log.scrollTop = 700;
    fireEvent.scroll(log);

    expect(screen.queryByRole('button', { name: /new messages/ })).not.toBeInTheDocument();
  });

  it("F-81: the reader's own new message is followed even when scrolled up", () => {
    const { log, rerender } = renderLog();
    const geometry = giveGeometry(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 50;
    fireEvent.scroll(log);

    geometry.scrollHeight = 1080;
    const sending: PendingChatMessage = { clientId: 'c-1', body: 'On my way.', status: 'sending' };
    rerender(<ChatLog {...logProps({ pending: [sending] })} />);

    expect(log.scrollTop).toBe(680);
    expect(within(log).getByText('sending…')).toBeInTheDocument();
  });

  it('F-82: older messages added on top keep the messages in view where they were', () => {
    const older = [message(9, ADA, 'Kiln is on from seven.', 0), message(10, JONAS, 'Noted, thanks.', 1)];
    const { log, rerender } = renderLog();
    const geometry = giveGeometry(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 600;
    fireEvent.scroll(log);
    log.scrollTop = 100;
    fireEvent.scroll(log);

    geometry.scrollHeight = 1400;
    rerender(<ChatLog {...logProps({ messages: [...older, ...HISTORY] })} />);

    expect(log.scrollTop).toBe(500);
    expect(texts(log)[0]).toBe('Kiln is on from seven.');
    expect(screen.queryByRole('button', { name: /new messages/ })).not.toBeInTheDocument();
  });

  it('F-79: a failed message says "Not sent" with the reason and offers retry and discard', async () => {
    const failed: PendingChatMessage = {
      clientId: 'c-2',
      body: 'Photos are in the shared folder.',
      status: 'failed',
      reason: 'Too many requests. Wait a moment and try again.',
    };
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const { log, user } = renderLog({ pending: [failed], onRetry, onDiscard });

    const item = within(log).getAllByRole('listitem').at(-1);
    if (item === undefined) {
      throw new Error('expected the failed message');
    }
    expect(item).toHaveTextContent('Not sent — Too many requests. Wait a moment and try again.');
    expect(within(item).getByRole('link', { name: 'Mira Novak' })).toBeInTheDocument();

    const retry = within(item).getByRole('button', { name: 'retry' });
    expect(retry).toHaveAccessibleDescription('Photos are in the shared folder.');
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(failed);

    await user.click(within(item).getByRole('button', { name: 'discard' }));
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('c-2');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('ChatPage', () => {
  async function renderPage() {
    const { store } = createTestStore();
    await signInAs(store);
    const view = renderWithProviders(<ChatPage />, { store, path: '/chat', initialEntries: ['/chat'] });
    return { ...view, field: screen.getByRole('textbox', { name: 'Message' }) };
  }

  function serveHistory(pages: Record<string, ChatPageDto>) {
    const requests: URL[] = [];
    server.use(
      http.get(apiUrl('/chat/messages'), ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        const result = pages[url.searchParams.get('cursor') ?? 'first'];
        return result === undefined ? problemResponse(400, 'invalid-cursor') : HttpResponse.json(result);
      }),
    );
    return requests;
  }

  it('B-84, F-76: an empty chat still shows the message input', async () => {
    serveHistory({ first: page([]) });
    await renderPage();

    expect(await screen.findByText('No messages yet.')).toBeInTheDocument();
    expect(screen.getByText('Write the first one below.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'send' })).toBeEnabled();
    expect(screen.getByRole('heading', { level: 1, name: 'Chat' })).toBeInTheDocument();
    expect(document.title).toBe("Chat · Let's chat!");
  });

  it('F-76: the newest 20 messages are shown oldest at the top; the input is there while loading', async () => {
    const requests = serveHistory({ first: page(HISTORY) });
    await renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('loading messages…');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();

    const log = await screen.findByRole('log', { name: 'Chat messages' });
    expect(texts(log)).toEqual(HISTORY.map((entry) => entry.body));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get('limit')).toBe('20');
    expect(requests[0]?.searchParams.has('cursor')).toBe(false);
  });

  it('F-85: opening the chat only loads its own history and sends nothing over the socket', async () => {
    serveHistory({ first: page(HISTORY) });
    await renderPage();
    await screen.findByRole('log');

    expect(fakeSocket.emitWithAck).not.toHaveBeenCalled();
    expect(fakeSocket.listenerCount('chat:message')).toBe(1);
  });

  it('F-82: "load older messages" loads the previous page with the cursor and adds it on top', async () => {
    const older = [message(9, ADA, 'Kiln is on from seven.', 0), message(10, JONAS, 'Noted, thanks.', 1)];
    const requests = serveHistory({ first: page(HISTORY, 'cursor-after-11'), 'cursor-after-11': page(older) });
    const { user } = await renderPage();
    const log = await screen.findByRole('log');

    await user.click(screen.getByRole('button', { name: 'load older messages' }));

    await vi.waitFor(() => {
      expect(texts(log)).toEqual([...older, ...HISTORY].map((entry) => entry.body));
    });
    expect(requests[1]?.searchParams.get('cursor')).toBe('cursor-after-11');
    expect(screen.queryByRole('button', { name: 'load older messages' })).not.toBeInTheDocument();
    expect(screen.getByText('This is the beginning of the chat.')).toBeInTheDocument();
  });

  it('F-80, B-83: an incoming message appears live and leaves the draft alone', async () => {
    serveHistory({ first: page(HISTORY) });
    const { user, field } = await renderPage();
    const log = await screen.findByRole('log');

    await user.type(field, 'I was just about to say');
    fakeSocket.deliver('chat:message', message(14, JONAS, 'Can I see them later?', 8));

    expect(await within(log).findByText('Can I see them later?')).toBeInTheDocument();
    expect(field).toHaveValue('I was just about to say');
  });

  it('F-79: a sent message shows as "sending…", then once with its server id, also when the broadcast arrives', async () => {
    serveHistory({ first: page(HISTORY) });
    const confirmed = message(14, MIRA_SUMMARY, 'Glaze results tomorrow.', 9);
    let acknowledge: (value: unknown) => void = () => undefined;
    fakeSocket.emitWithAck.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { user, field } = await renderPage();
    const log = await screen.findByRole('log');

    await user.type(field, 'Glaze results tomorrow.{Enter}');

    expect(fakeSocket.emitWithAck).toHaveBeenCalledExactlyOnceWith('chat:send', { body: 'Glaze results tomorrow.' });
    expect(within(log).getByText('sending…')).toBeInTheDocument();
    expect(field).toHaveValue('Glaze results tomorrow.');

    fakeSocket.deliver('chat:message', confirmed);
    acknowledge({ ok: true, message: confirmed });

    await vi.waitFor(() => {
      expect(within(log).queryByText('sending…')).not.toBeInTheDocument();
    });
    expect(within(log).getAllByText('Glaze results tomorrow.')).toHaveLength(1);
    expect(texts(log).at(-1)).toBe('Glaze results tomorrow.');
    expect(field).toHaveValue('');
  });

  it('F-79: a rejected message is marked "Not sent", keeps the draft and can be retried without a duplicate', async () => {
    serveHistory({ first: page(HISTORY) });
    const confirmed = message(15, MIRA_SUMMARY, 'Studio closes at six today.', 10);
    fakeSocket.emitWithAck
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'rate-limited', message: 'Too many chat messages', retryAfterMs: 4000 },
      })
      .mockResolvedValueOnce({ ok: true, message: confirmed });
    const { user, field } = await renderPage();
    const log = await screen.findByRole('log');

    await user.type(field, 'Studio closes at six today.{Enter}');

    expect(
      await within(log).findByText('Not sent — Too many requests. Wait a moment and try again.'),
    ).toBeInTheDocument();
    expect(field).toHaveValue('Studio closes at six today.');

    await user.click(within(log).getByRole('button', { name: 'retry' }));

    await vi.waitFor(() => {
      expect(within(log).queryByText(/Not sent/)).not.toBeInTheDocument();
    });
    expect(within(log).getAllByText('Studio closes at six today.')).toHaveLength(1);
    expect(fakeSocket.emitWithAck).toHaveBeenCalledTimes(2);
    // The retry delivered the text the draft had kept: Enter must not be able to send it a second time.
    expect(field).toHaveValue('');
    await user.click(field);
    await user.keyboard('{Enter}');
    expect(fakeSocket.emitWithAck).toHaveBeenCalledTimes(2);
  });

  it('B-83: text typed while the message was on its way survives the ack', async () => {
    serveHistory({ first: page(HISTORY) });
    const confirmed = message(16, MIRA_SUMMARY, 'Back in five', 11);
    let acknowledge: (value: unknown) => void = () => undefined;
    fakeSocket.emitWithAck.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { user, field } = await renderPage();
    const log = await screen.findByRole('log');

    await user.type(field, 'Back in five{Enter}');
    await user.type(field, ' minutes');
    acknowledge({ ok: true, message: confirmed });

    await vi.waitFor(() => {
      expect(within(log).queryByText('sending…')).not.toBeInTheDocument();
    });
    expect(field).toHaveValue('Back in five minutes');
  });

  it('F-79: sending the failed text again from the input reuses the failed entry; discard removes it', async () => {
    serveHistory({ first: page(HISTORY) });
    fakeSocket.emitWithAck.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'Internal error' },
    });
    const { user, field } = await renderPage();
    const log = await screen.findByRole('log');

    await user.type(field, 'Anyone seen my apron?{Enter}');
    await within(log).findByText(/Not sent/);
    await user.click(field);
    await user.keyboard('{Enter}');

    await vi.waitFor(() => {
      expect(fakeSocket.emitWithAck).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(within(log).getByRole('button', { name: 'retry' })).toBeInTheDocument();
    });
    expect(within(log).getAllByText('Anyone seen my apron?')).toHaveLength(1);

    await user.click(within(log).getByRole('button', { name: 'discard' }));
    expect(within(log).queryByText('Anyone seen my apron?')).not.toBeInTheDocument();
    expect(field).toHaveValue('Anyone seen my apron?');
  });

  it('F-79: without a live connection the message is not sent and says why', async () => {
    serveHistory({ first: page(HISTORY) });
    fakeSocket.connected = false;
    const { user, field } = await renderPage();
    const log = await screen.findByRole('log');

    await user.type(field, 'Hello?{Enter}');

    expect(
      await within(log).findByText('Not sent — The server could not be reached. Check your connection and try again.'),
    ).toBeInTheDocument();
    expect(fakeSocket.emitWithAck).not.toHaveBeenCalled();
  });

  it('F-105: a failed history load offers "try again" and keeps the input', async () => {
    let fail = true;
    server.use(
      http.get(apiUrl('/chat/messages'), () =>
        fail ? problemResponse(500, 'internal') : HttpResponse.json(page(HISTORY)),
      ),
    );
    const { user } = await renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('The chat could not be loaded.');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole('button', { name: 'try again' }));

    const log = await screen.findByRole('log');
    expect(texts(log)).toHaveLength(3);
  });

  it('ignores a malformed live event instead of breaking the history', async () => {
    serveHistory({ first: page(HISTORY) });
    await renderPage();
    const log = await screen.findByRole('log');

    fakeSocket.deliver('chat:message', { id: 'x', body: 42 });
    fakeSocket.deliver('chat:message', HISTORY[0]);

    expect(texts(log)).toEqual(HISTORY.map((entry) => entry.body));
  });
});
