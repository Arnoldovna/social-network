import { randomUUID } from 'node:crypto';

import type { Locator, Page, WebSocketRoute } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInDarkMode } from './a11y.js';
import { SOCKET_PATH, socketHandshake } from './fixtures/socket.js';
import { expect, test, type E2EUser } from './fixtures/test.js';
import { fullName, uniqueText } from './fixtures/ui.js';

/**
 * The global chat (FEATURES §10) and the real-time plumbing behind it (F-107, F-111), with two or more real browsers
 * against the e2e stack. The chat room is shared by every test that runs at the same time (both Playwright projects,
 * parallel workers, ADR-0016), so every message carries a unique tag and assertions look only at this test's own
 * messages, never at counts of the whole room.
 */

/** `PAGE_LIMIT_DEFAULT` of the shared contract: the chat loads 20 messages per page (F-76, F-82). */
const CHAT_PAGE_SIZE = 20;

/** `CHAT_MAX` of the shared contract (F-78). */
const CHAT_MAX = 1000;

interface ChatMessageJson {
  id: number;
  body: string;
  createdAt: string;
  author: { id: number; firstName: string; lastName: string };
}

function chatLog(page: Page): Locator {
  return page.getByRole('log', { name: 'Chat messages' });
}

/** The row of the message whose text contains `text` (bodies are unique per test). */
function messageRow(page: Page, text: string): Locator {
  return chatLog(page).getByRole('listitem').filter({ hasText: text });
}

function messageField(page: Page): Locator {
  return page.getByRole('textbox', { name: 'message', exact: true });
}

function sendButton(page: Page): Locator {
  return page.getByRole('button', { name: 'send', exact: true });
}

/** Opens `/chat` and waits until the history is shown and the live socket is connected. */
async function openChat(page: Page): Promise<void> {
  const connected = socketHandshake(page);
  await page.goto('/chat');
  await expect(page.getByRole('heading', { level: 1, name: 'Chat' })).toBeVisible();
  await connected;
  await expect(chatLog(page)).toBeVisible();
}

/** Sends `text` with Enter and waits for the acknowledgement: the row shows the server's time, the field is empty. */
async function sendWithEnter(page: Page, text: string): Promise<void> {
  await messageField(page).fill(text);
  await messageField(page).press('Enter');
  await expect(messageRow(page, text).locator('time')).toBeVisible();
  await expect(messageField(page)).toHaveValue('');
}

/** The newest messages of the room as the API returns them (newest first). */
async function latestMessages(user: E2EUser, limit = 50): Promise<ChatMessageJson[]> {
  const response = await user.api.get(`/api/chat/messages?limit=${String(limit)}`);
  expect(response.status()).toBe(200);
  const page = (await response.json()) as { items: ChatMessageJson[] };
  return page.items;
}

/** The texts of all message bodies in the log, top to bottom. */
function bodiesInOrder(page: Page): Promise<string[]> {
  return chatLog(page).locator('.chat-message__body').allInnerTexts();
}

/** When the server stored a delivered message: the `datetime` of its row's `<time>` (shown once acknowledged). */
async function storedAt(row: Locator): Promise<number> {
  const dateTime = await row.locator('time').getAttribute('datetime');
  if (dateTime === null) throw new Error('the message row has no <time datetime>');
  return Date.parse(dateTime);
}

/** The stored time of the newest message the log shows (the bottom row). */
function newestShownAt(page: Page): Promise<number> {
  return storedAt(chatLog(page).getByRole('listitem').last());
}

function isScrolledToBottom(log: Locator): Promise<boolean> {
  // The same 48 px tolerance as use-stick-to-bottom (BOTTOM_THRESHOLD_PX), for sub-pixel rounding.
  return log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 48);
}

/** Lets the browser dispatch pending scroll events (they fire in the rendering step, before animation frames). */
async function afterNextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

/**
 * Puts the page's socket.io WebSocket behind a switch (Playwright `routeWebSocket`). Every connection is passed through
 * to the real server until `drop()` closes the live one: the client sees a lost connection and starts reconnecting.
 * While the switch is off, a reconnect attempt is held open without an answer, like a network that does not get
 * through; `restore()` connects the held attempt (or lets the next one through), so the client's own reconnect
 * completes. The page still opens the real WebSocket itself (`connectToServer`), so its origin, cookie and CSP apply as
 * without the route.
 *
 * A held attempt is not refused with a close: a mock that closes before opening fires no `error`, and socket.io-client
 * only gives up such an attempt after its 20 s connect timeout.
 */
async function switchableSocket(page: Page): Promise<{
  handshakes: () => number;
  /** A reconnect attempt arrived while the switch was off and waits for `restore()`. */
  hasHeldAttempt: () => boolean;
  drop: () => Promise<void>;
  restore: () => void;
}> {
  let online = true;
  let handshakes = 0;
  let live: WebSocketRoute | null = null;
  let held: WebSocketRoute | null = null;

  const passThrough = (socket: WebSocketRoute): void => {
    live = socket;
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === 'string' && message.startsWith('40')) handshakes += 1;
      socket.send(message);
    });
  };

  await page.routeWebSocket(
    (url) => url.pathname === SOCKET_PATH,
    (socket) => {
      if (online) passThrough(socket);
      else held = socket;
    },
  );

  return {
    handshakes: () => handshakes,
    hasHeldAttempt: () => held !== null,
    async drop() {
      online = false;
      const current = live;
      live = null;
      if (current !== null) await current.close({ code: 4000, reason: 'e2e: network down' });
    },
    restore() {
      online = true;
      const waiting = held;
      held = null;
      if (waiting !== null) passThrough(waiting);
    },
  };
}

test.describe('global chat', () => {
  test('F-111, B-07: a signed-in page connects its socket through nginx and the handshake is accepted', async ({
    userPage,
    baseURL,
  }) => {
    const connected = socketHandshake(userPage);
    await userPage.goto('/chat');
    const handshake = await connected;

    // Same origin as the page, through nginx, WebSocket transport only (ADR-0005, ADR-0008).
    const url = new URL(handshake.url);
    expect(url.host).toBe(new URL(baseURL ?? '').host);
    expect(url.pathname).toBe(SOCKET_PATH);
    expect(url.searchParams.get('transport')).toBe('websocket');
    // The namespace CONNECT was answered with a session id: the authenticated handshake was accepted, not `44…`.
    expect(handshake.frame).toMatch(/^40\{"sid":"[^"]+"/);
    await expect(userPage.getByText('Reconnecting…')).toHaveCount(0);
    await expectNoA11yViolations(userPage);
  });

  test('F-76, B-84: the message input is always there, also while loading and in an empty chat', async ({
    userPage,
    user,
  }) => {
    // The shared room is never empty on a used stack, so this test alone answers the history request with an empty
    // page (the real API's shape) and holds it until the loading state was checked. Sending still goes to the server.
    let releaseHistory = (): void => undefined;
    const historyHeld = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    await userPage.route(
      (url) => url.pathname === '/api/chat/messages',
      async (route) => {
        await historyHeld;
        await route.fulfill({ json: { items: [], nextCursor: null } });
      },
    );

    const connected = socketHandshake(userPage);
    await userPage.goto('/chat');
    await expect(userPage.getByRole('status').filter({ hasText: 'loading messages…' })).toBeVisible();
    await expect(messageField(userPage)).toBeEditable();
    await expect(sendButton(userPage)).toBeEnabled();

    releaseHistory();
    await expect(userPage.getByText('No messages yet.')).toBeVisible();
    await expect(messageField(userPage)).toBeEditable();
    await connected;

    // The first message of an empty chat can be sent (legacy rendered no input at all, B-84).
    const first = uniqueText('first message');
    await messageField(userPage).fill(first);
    await sendButton(userPage).click();
    await expect(messageRow(userPage, first).locator('time')).toBeVisible();
    await expect(userPage.getByText('No messages yet.')).toHaveCount(0);
    expect(
      (await latestMessages(user)).some((message) => message.body === first && message.author.id === user.id),
    ).toBe(true);
    await expectNoA11yViolations(userPage);
  });

  test('F-77, F-78, F-79: Enter sends, Shift+Enter breaks the line, and others see the persisted message live', async ({
    createUser,
    pageAs,
  }) => {
    const sender = await createUser({ firstName: 'Sana' });
    const reader = await createUser({ firstName: 'Ruben' });
    const senderPage = await pageAs(sender);
    const readerPage = await pageAs(reader);
    await openChat(senderPage);
    await openChat(readerPage);

    const firstLine = uniqueText('first line');
    const secondLine = uniqueText('second line');
    await messageField(senderPage).fill(firstLine);
    await messageField(senderPage).press('Shift+Enter');
    await messageField(senderPage).pressSequentially(secondLine);
    await expect(messageField(senderPage)).toHaveValue(`${firstLine}\n${secondLine}`);
    await messageField(senderPage).press('Enter');
    await expect(messageField(senderPage)).toHaveValue('');

    // The reader gets it live, as one message with the line break kept (F-78, F-79).
    const delivered = messageRow(readerPage, firstLine);
    await expect(delivered).toHaveCount(1);
    await expect(delivered.locator('.chat-message__body')).toHaveText(`${firstLine}\n${secondLine}`, {
      useInnerText: true,
    });

    // F-77: avatar, author name linked to the profile, text and time.
    await expect(delivered.getByRole('img', { name: `${fullName(sender)}'s profile picture` })).toBeVisible();
    const author = delivered.getByRole('link', { name: fullName(sender), exact: true });
    await expect(author).toHaveAttribute('href', `/users/${String(sender.id)}`);
    const time = delivered.locator('time');
    await expect(time).toBeVisible();

    // F-79, B-47: the message is the persisted row, its time is the server's `createdAt` with a server id.
    const stored = (await latestMessages(reader)).find((message) => message.body === `${firstLine}\n${secondLine}`);
    expect(stored, 'the message is in the history').toBeDefined();
    expect(stored?.author.id).toBe(sender.id);
    expect(Number.isInteger(stored?.id) && (stored?.id ?? 0) > 0).toBe(true);
    await expect(time).toHaveAttribute('datetime', new Date(stored?.createdAt ?? '').toISOString());

    // The sender's own tab gets both the ack and the broadcast and still shows the message once (de-duplicated by id).
    await expect(messageRow(senderPage, firstLine)).toHaveCount(1);
    await expect(messageRow(senderPage, firstLine).locator('time')).toBeVisible();

    // The "send" button works as well as Enter, in the other direction.
    const reply = uniqueText('reply with the button');
    await messageField(readerPage).fill(reply);
    await sendButton(readerPage).click();
    await expect(messageRow(senderPage, reply)).toHaveCount(1);
    await expect(
      messageRow(senderPage, reply).getByRole('link', { name: fullName(reader), exact: true }),
    ).toBeVisible();
    await expect(messageRow(readerPage, reply).locator('time')).toBeVisible();

    // F-76: oldest at the top, the newest at the bottom.
    const bodies = await bodiesInOrder(senderPage);
    const firstIndex = bodies.findIndex((body) => body.includes(firstLine));
    const replyIndex = bodies.findIndex((body) => body.includes(reply));
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(firstIndex);

    await expectNoA11yViolations(readerPage);
    await expectNoA11yViolationsInDarkMode(readerPage);
  });

  test('F-78: empty and over-long messages are not sent, 1,000 characters after trimming are', async ({
    userPage,
    user,
  }) => {
    await openChat(userPage);
    const ownMessages = async () => (await latestMessages(user)).filter((message) => message.author.id === user.id);

    // Enter in an empty field does nothing: no message, no line break, no error.
    await messageField(userPage).press('Enter');
    await expect(messageField(userPage)).toHaveValue('');
    await expect(userPage.getByText('Write a message first.')).toHaveCount(0);

    // Only spaces and line breaks count as empty.
    await messageField(userPage).fill('   \n  ');
    await sendButton(userPage).click();
    await expect(userPage.getByText('Write a message first.')).toBeVisible();
    await expect(messageField(userPage)).toHaveAttribute('aria-invalid', 'true');

    // One character too many is refused before anything is sent, and the count says by how much.
    const tooLong = 'x'.repeat(CHAT_MAX + 1);
    await messageField(userPage).fill(tooLong);
    await expect(userPage.getByText('1 character too many')).toBeVisible();
    await sendButton(userPage).click();
    await expect(userPage.getByText('Keep your message to 1,000 characters.')).toBeVisible();
    await expect(messageField(userPage)).toHaveValue(tooLong);
    expect(await ownMessages()).toEqual([]);

    // Exactly 1,000 characters once the surrounding spaces are trimmed are sent, trimmed.
    const tag = uniqueText('limit');
    const atLimit = tag + 'y'.repeat(CHAT_MAX - tag.length);
    await messageField(userPage).fill(`  ${atLimit}  `);
    await sendButton(userPage).click();
    await expect(messageRow(userPage, tag).locator('time')).toBeVisible();
    await expect(messageField(userPage)).toHaveValue('');
    await expect(userPage.getByText('Keep your message to 1,000 characters.')).toHaveCount(0);
    expect((await ownMessages()).map((message) => message.body)).toEqual([atLimit]);

    await expectNoA11yViolations(userPage);
  });

  test('F-80, B-83: an incoming message does not clear the draft', async ({ createUser, pageAs }) => {
    const writer = await createUser();
    const other = await createUser();
    const writerPage = await pageAs(writer);
    const otherPage = await pageAs(other);
    await openChat(writerPage);
    await openChat(otherPage);

    const draft = uniqueText('half-written draft');
    await messageField(writerPage).fill(draft);

    const incoming = uniqueText('incoming while typing');
    await sendWithEnter(otherPage, incoming);
    await expect(messageRow(writerPage, incoming)).toHaveCount(1);
    await expect(messageField(writerPage)).toHaveValue(draft);

    // The draft is still the one that gets sent, and only the own acknowledged message clears it.
    await messageField(writerPage).press('Enter');
    await expect(messageRow(otherPage, draft)).toHaveCount(1);
    await expect(messageField(writerPage)).toHaveValue('');
    await expectNoA11yViolations(writerPage);
  });

  test('F-81, B-85: the log follows new messages only at the bottom, otherwise a "new messages" pill appears', async ({
    createUser,
    pageAs,
  }) => {
    const reader = await createUser();
    const sender = await createUser();
    const senderPage = await pageAs(sender);
    await openChat(senderPage);
    // Tall messages, so the reader's log overflows whatever else the shared room holds.
    for (let index = 0; index < 3; index += 1) {
      const lines = Array.from({ length: 15 }, (_, line) => `line ${String(line + 1)}`).join('\n');
      await sendWithEnter(senderPage, `${uniqueText(`tall message ${String(index + 1)}`)}\n${lines}`);
    }

    const readerPage = await pageAs(reader);
    await openChat(readerPage);
    const log = chatLog(readerPage);
    expect(
      await log.evaluate((element) => element.scrollHeight > element.clientHeight * 1.5),
      'the log overflows',
    ).toBe(true);
    // The history starts at the newest message.
    await expect.poll(() => isScrolledToBottom(log)).toBe(true);

    // At the bottom: a new message scrolls into view, no pill.
    const followed = uniqueText('followed');
    await sendWithEnter(senderPage, followed);
    await expect(messageRow(readerPage, followed)).toHaveCount(1);
    await expect.poll(() => isScrolledToBottom(log)).toBe(true);
    const pill = readerPage.getByRole('button', { name: /new messages/ });
    await expect(pill).toHaveCount(0);

    // Scrolled up to read: the position is kept and the pill offers the way down.
    await log.evaluate((element) => {
      element.scrollTop = 0;
    });
    await afterNextFrames(readerPage);
    const unread = uniqueText('arrived while reading');
    await sendWithEnter(senderPage, unread);
    await expect(messageRow(readerPage, unread)).toHaveCount(1);
    await expect(pill).toBeVisible();
    expect(await log.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await isScrolledToBottom(log)).toBe(false);

    await pill.click();
    await expect.poll(() => isScrolledToBottom(log)).toBe(true);
    await expect(pill).toHaveCount(0);
    await expect(log).toBeFocused();
    await expectNoA11yViolations(readerPage);
  });

  test('F-82, F-76, F-85, B-42, B-73: older pages load on demand and a new client does not reset anyone else', async ({
    createUser,
    pageAs,
  }) => {
    const writer = await createUser();
    const reader = await createUser();
    const latecomer = await createUser();
    const writerPage = await pageAs(writer);
    await openChat(writerPage);

    const tag = randomUUID().slice(0, 8);
    const marker = `oldest marker ${tag}`;
    const fillers = Array.from({ length: CHAT_PAGE_SIZE }, (_, index) => `filler ${String(index + 1)} ${tag}`);
    await sendWithEnter(writerPage, marker);
    for (const filler of fillers) await sendWithEnter(writerPage, filler);

    // F-76: the first page holds the newest 20 messages, oldest at the top, so the marker (20 own messages back) is
    // not on it. The room is shared with parallel tests (the same test runs in both projects and sends 21 messages
    // too), so how many fillers are still on the newest page depends on what others wrote meanwhile. What holds
    // anyway: the page ends no earlier than the newest filler, and the fillers it shows are the newest ones, in order.
    const newestFillerAt = await storedAt(messageRow(writerPage, fillers.at(-1) ?? ''));
    const readerPage = await pageAs(reader);
    await openChat(readerPage);
    await expect(messageRow(readerPage, marker)).toHaveCount(0);
    expect(await newestShownAt(readerPage)).toBeGreaterThanOrEqual(newestFillerAt);
    const shownFillers = (await bodiesInOrder(readerPage)).filter((body) => body.endsWith(tag));
    expect(shownFillers).toEqual(fillers.slice(fillers.length - shownFillers.length));

    // F-82: "load older messages" adds the previous page above. Other tests may have written to the room in between,
    // which only pushes the marker further back, so pages are loaded until it is there.
    const loadOlder = readerPage.getByRole('button', { name: 'load older messages' });
    const rows = chatLog(readerPage).getByRole('listitem');
    for (let page = 0; page < 5 && (await messageRow(readerPage, marker).count()) === 0; page += 1) {
      const before = await rows.count();
      await loadOlder.click();
      await expect.poll(() => rows.count()).toBeGreaterThan(before);
    }
    await expect(messageRow(readerPage, marker)).toHaveCount(1);
    const withHistory = (await bodiesInOrder(readerPage)).filter((body) => body.endsWith(tag));
    expect(withHistory).toEqual([marker, ...fillers]);

    // F-85, B-42: another client connecting and opening the chat changes nothing in this reader's view.
    const loaded = await rows.count();
    const latecomerPage = await pageAs(latecomer);
    await openChat(latecomerPage);
    // The latecomer gets the newest page of its own (F-76), with the same guarantees as the reader's first page.
    await expect(messageRow(latecomerPage, marker)).toHaveCount(0);
    expect(await newestShownAt(latecomerPage)).toBeGreaterThanOrEqual(newestFillerAt);

    // A message after the new connection reaches both live, so any reset the connection caused would have arrived.
    const afterConnect = uniqueText('after the new connection');
    await sendWithEnter(writerPage, afterConnect);
    await expect(messageRow(readerPage, afterConnect)).toHaveCount(1);
    await expect(messageRow(latecomerPage, afterConnect)).toHaveCount(1);
    await expect(messageRow(readerPage, marker)).toHaveCount(1);
    expect(await rows.count()).toBeGreaterThan(loaded);

    await expectNoA11yViolations(readerPage);
    await expectNoA11yViolationsInDarkMode(readerPage);
  });

  test('F-107, F-79: a lost connection shows "Reconnecting…", a failed send can be retried, live updates resume', async ({
    createUser,
    pageAs,
  }) => {
    const offline = await createUser();
    const online = await createUser();
    const offlinePage = await pageAs(offline);
    const network = await switchableSocket(offlinePage);
    const onlinePage = await pageAs(online);
    await offlinePage.goto('/chat');
    await expect(offlinePage.getByRole('heading', { level: 1, name: 'Chat' })).toBeVisible();
    await expect.poll(() => network.handshakes()).toBe(1);
    await openChat(onlinePage);

    await network.drop();
    const banner = offlinePage.getByText('Reconnecting…');
    await expect(banner).toBeVisible();

    // Non-blocking: the page stays usable. A message sent now fails visibly and keeps its text in the field.
    const unsent = uniqueText('sent while offline');
    await messageField(offlinePage).fill(unsent);
    await messageField(offlinePage).press('Enter');
    const failed = messageRow(offlinePage, unsent);
    await expect(failed.getByText(/^Not sent — /)).toBeVisible();
    await expect(failed.getByRole('button', { name: 'retry' })).toBeVisible();
    await expect(messageField(offlinePage)).toHaveValue(unsent);
    await expectNoA11yViolations(offlinePage);

    // Something happens while this client is away.
    const missed = uniqueText('missed while offline');
    await sendWithEnter(onlinePage, missed);

    // socket.io-client tries again on its own; the attempt does not get through while the network is down.
    await expect.poll(() => network.hasHeldAttempt()).toBe(true);
    await expect(banner).toBeVisible();
    network.restore();
    await expect(banner).toHaveCount(0);
    expect(network.handshakes()).toBe(2);
    // The resync after the reconnect brings what the socket missed (F-107).
    await expect(messageRow(offlinePage, missed)).toHaveCount(1);
    await expect(messageRow(onlinePage, unsent)).toHaveCount(0);

    // "retry" delivers the failed message once; that also clears the field, which still held exactly its text.
    await failed.getByRole('button', { name: 'retry' }).click();
    await expect(failed.locator('time')).toBeVisible();
    await expect(failed.getByText(/^Not sent — /)).toHaveCount(0);
    await expect(messageField(offlinePage)).toHaveValue('');
    await expect(messageRow(onlinePage, unsent)).toHaveCount(1);

    // Live updates work again without a reload.
    const live = uniqueText('live after reconnect');
    await sendWithEnter(onlinePage, live);
    await expect(messageRow(offlinePage, live)).toHaveCount(1);
    await expectNoA11yViolations(offlinePage);
  });
});
