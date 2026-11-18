import { CHAT_MAX, ChatMessage } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { connectAs, recordEvents, waitFor, waitForDisconnect } from '../../../../test/socket.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { chatMessages } from '../../../db/schema/index.js';
import { rooms } from '../../../shared/realtime/rooms.js';
import { sessionKeyPrefix } from '../../../shared/security/session.js';
import {
  chatMessageCount,
  createSocketTracker,
  fetchAllChatPages,
  sendChat,
  sendChatOk,
  signedInChatter,
} from './fixtures.js';

/**
 * `chat:send` and `chat:message` against the real app and socket.io server on an ephemeral port (ADR-0008, API.md §3):
 * persisted rows as payloads (F-79, B-47, B-75), validation through the ack (F-78, F-112, B-48), no broadcast on
 * connect (F-85, B-42) and the per-event session check (ADR-0005). Assertions only look at the test's own authors.
 */

let testApp: TestApp;
const sockets = createSocketTracker();

beforeAll(async () => {
  testApp = await createTestApp();
});

afterEach(() => {
  sockets.closeAll();
});

afterAll(async () => {
  await testApp.close();
});

async function connectedChatter() {
  const chatter = await signedInChatter(testApp, { avatar: true });
  return { ...chatter, socket: await sockets.connect(testApp, chatter.agent) };
}

describe('chat:send -> chat:message (F-78, F-79, B-47, B-75)', () => {
  it('F-79: the sender gets an ok ack and every connected user, the sender included, gets the same message', async () => {
    const ada = await connectedChatter();
    const grace = await connectedChatter();
    const ownFilter = { filter: (message: ChatMessage) => message.author.id === ada.user.id };
    const atAda = waitFor(ada.socket, 'chat:message', ownFilter);
    const atGrace = waitFor(grace.socket, 'chat:message', ownFilter);

    const message = await sendChatOk(ada.socket, '  Hello, everyone  ');

    expect(message).toStrictEqual({
      id: expect.any(Number) as number,
      author: {
        id: ada.user.id,
        firstName: ada.user.firstName,
        lastName: ada.user.lastName,
        avatarUrl: expect.stringMatching(new RegExp(`^/api/users/${String(ada.user.id)}/avatar\\?v=`)) as string,
      },
      body: 'Hello, everyone',
      createdAt: expect.any(String) as string,
    });
    await expect(atAda).resolves.toStrictEqual(message);
    await expect(atGrace).resolves.toStrictEqual(message);
  });

  it('B-47: id and createdAt are the persisted row’s, the body is stored trimmed', async () => {
    const ada = await connectedChatter();
    const message = await sendChatOk(ada.socket, '\n Persisted \t');
    const [row] = await testApp.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, message.id), eq(chatMessages.authorId, ada.user.id)));
    expect(row).toBeDefined();
    expect(row?.body).toBe('Persisted');
    expect(message.createdAt).toBe(row?.createdAt.toISOString());
  });

  it('F-78: keeps inner line breaks and accepts exactly 1,000 characters after trimming', async () => {
    const ada = await connectedChatter();
    await expect(sendChatOk(ada.socket, 'line one\nline two')).resolves.toMatchObject({ body: 'line one\nline two' });
    const longest = 'x'.repeat(CHAT_MAX);
    await expect(sendChatOk(ada.socket, `  ${longest}  `)).resolves.toMatchObject({ body: longest });
  });

  it('F-82: a sent message is the newest entry of the HTTP history', async () => {
    const ada = await connectedChatter();
    const message = await sendChatOk(ada.socket, 'In the history');
    const history = (await fetchAllChatPages(ada.agent, 50)).flatMap((page) => page.items);
    expect(history.find(({ author }) => author.id === ada.user.id)).toStrictEqual(message);
  });

  it('B-75: the payload is complete (author summary joined in the insert statement)', async () => {
    const ada = await connectedChatter();
    const message = await sendChatOk(ada.socket, 'Complete');
    expect(ChatMessage.parse(message)).toStrictEqual(message);
    const [fromHistory] = (await fetchAllChatPages(ada.agent, 50))
      .flatMap((page) => page.items)
      .filter(({ id }) => id === message.id);
    expect(fromHistory?.author).toStrictEqual(message.author);
  });
});

describe('chat:send validation (F-78, F-112, B-48)', () => {
  it.each([
    ['an empty body', { body: '' }],
    ['a whitespace-only body', { body: '   \n ' }],
    [`${String(CHAT_MAX + 1)} characters`, { body: 'x'.repeat(CHAT_MAX + 1) }],
    ['a number body', { body: 42 }],
    ['an object body', { body: { html: '<b>hi</b>' } }],
    ['a missing body', {}],
    ['a bare string', 'hello'],
    ['null', null],
    ['an array', [{ body: 'hi' }]],
  ])(
    'acks validation-failed for %s; nothing is stored or broadcast, the socket stays usable',
    async (_label, payload) => {
      const ada = await connectedChatter();
      const grace = await connectedChatter();
      const atGrace = recordEvents(grace.socket, 'chat:message');

      expect(await sendChat(ada.socket, payload)).toStrictEqual({
        ok: false,
        error: { code: 'validation-failed', message: expect.any(String) as string },
      });
      expect(ada.socket.connected).toBe(true);
      expect(await chatMessageCount(testApp.db, ada.user.id)).toBe(0);

      // Ordered by a real delivery instead of a sleep: the next valid message is the only one grace sees.
      const delivered = waitFor(grace.socket, 'chat:message', { filter: ({ author }) => author.id === ada.user.id });
      const message = await sendChatOk(ada.socket, 'Valid after invalid');
      await delivered;
      expect(atGrace.filter(({ author }) => author.id === ada.user.id)).toStrictEqual([message]);
    },
  );

  it('B-48: a message above 16 KB closes the connection; nothing is stored, other users stay connected', async () => {
    const ada = await connectedChatter();
    const grace = await connectedChatter();
    const closed = waitForDisconnect(ada.socket);
    ada.socket.emit('chat:send', { body: 'x'.repeat(20_000) }, () => undefined);
    expect(await closed).toBe('transport close');
    expect(await chatMessageCount(testApp.db, ada.user.id)).toBe(0);
    expect(grace.socket.connected).toBe(true);
    await expect(sendChatOk(grace.socket, 'Still here')).resolves.toMatchObject({ body: 'Still here' });
  });
});

describe('chat:send is reachable only from the app (B-28, ADR-0005)', () => {
  it('B-28: a cross-site page holding the signed-in cookie cannot open the socket, so it cannot send', async () => {
    const victim = await signedInChatter(testApp);
    const reader = await connectedChatter();
    const received = recordEvents(reader.socket, 'chat:message');

    // The socket carries the session cookie but no CSRF token, so the origin allow-list is what stops a forged page.
    await expect(
      connectAs(victim.agent, { baseUrl: testApp.baseUrl, origin: 'https://attacker.example' }),
    ).rejects.toThrow();
    await expect(connectAs(victim.agent, { baseUrl: testApp.baseUrl, origin: null })).rejects.toThrow();
    expect(await chatMessageCount(testApp.db, victim.user.id)).toBe(0);

    // Control: the same cookie from the app's origin connects and sends; the reader gets exactly that message.
    const socket = await sockets.connect(testApp, victim.agent);
    const delivered = waitFor(reader.socket, 'chat:message', {
      filter: (message) => message.author.id === victim.user.id,
    });
    const sent = await sendChatOk(socket, 'From the app itself');
    await expect(delivered).resolves.toStrictEqual(sent);
    expect(received.filter((message) => message.author.id === victim.user.id)).toStrictEqual([sent]);
    expect(await chatMessageCount(testApp.db, victim.user.id)).toBe(1);
  });
});

describe('connecting broadcasts nothing (F-85, B-42)', () => {
  it('B-42: a new client connecting sends no chat event to the others; history stays per client over HTTP', async () => {
    const ada = await connectedChatter();
    const atAda = recordEvents(ada.socket, 'chat:message');

    const grace = await connectedChatter();
    const secondTab = await sockets.connect(testApp, grace.agent);
    expect(secondTab.connected).toBe(true);

    // The first event ada receives after both connects is grace's own message, nothing replayed before it.
    const delivered = waitFor(ada.socket, 'chat:message', { filter: ({ author }) => author.id === grace.user.id });
    const message = await sendChatOk(grace.socket, 'First real event');
    await delivered;
    expect(atAda).toStrictEqual([message]);
  });
});

describe('session lifetime (ADR-0005)', () => {
  it('acks unauthorized and disconnects when the session is gone; nothing is stored or broadcast', async () => {
    const ada = await connectedChatter();
    const grace = await connectedChatter();
    const atGrace = recordEvents(grace.socket, 'chat:message');
    const [serverSocket] = await testApp.io.in(rooms.user(ada.user.id)).fetchSockets();
    expect(serverSocket).toBeDefined();
    await testApp.redis.del(sessionKeyPrefix(testApp.prefix) + (serverSocket?.data.sessionId ?? ''));

    const closed = waitForDisconnect(ada.socket);
    expect(await sendChat(ada.socket, { body: 'After logout' })).toStrictEqual({
      ok: false,
      error: { code: 'unauthorized', message: expect.any(String) as string },
    });
    expect(await closed).toBe('io server disconnect');
    expect(await chatMessageCount(testApp.db, ada.user.id)).toBe(0);

    const delivered = waitFor(grace.socket, 'chat:message', { filter: ({ author }) => author.id === grace.user.id });
    await sendChatOk(grace.socket, 'Ordering marker');
    await delivered;
    expect(atGrace.filter(({ author }) => author.id === ada.user.id)).toHaveLength(0);
  });
});
