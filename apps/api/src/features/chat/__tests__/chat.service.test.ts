import { CHAT_MAX, ChatMessage, ChatPage, SendChatMessage } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS } from '../../../config/limits.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { createAvatarUrl, parseAvatarKey } from '../../../shared/media/media-url.js';
import { encodeCursor } from '../../../shared/pagination/cursor.js';
import { createMemorySocketEventLimiter } from '../../../shared/realtime/event-limiter.js';
import { createChatService, toChatMessage } from '../chat.service.js';
import { authorRow, chatRow, createFakeChatRepository, type FakeChatRepository } from './fakes.js';

/**
 * Rules of the chat service with an in-memory repository (ADR-0016): page shape, cursor handling and DTO mapping for
 * the history (F-76, F-82, B-72, B-73), the persisted message as the one DTO every client receives (F-79, B-47,
 * B-75), the `chat:send` payload contract (F-78, F-112) and the per-user budget the socket handler enforces (F-84).
 * The socket pipeline itself runs against the real server in `chat.socket.int.test.ts`.
 */

const avatarUrl = createAvatarUrl();
const ada = authorRow(1, { avatar: true });
const grace = authorRow(2, { firstName: 'Grace' });

function setup(options: { now?: () => Date } = {}): {
  repository: FakeChatRepository;
  service: ReturnType<typeof createChatService>;
} {
  const repository = createFakeChatRepository(options);
  repository.addAuthor(ada);
  repository.addAuthor(grace);
  return { repository, service: createChatService({ repository, avatarUrl }) };
}

/** `count` messages by `author`, one second apart, the newest last (ids ascending with time). */
function seedTimeline(repository: FakeChatRepository, count: number, author = ada): void {
  const start = Date.parse('2026-11-01T10:00:00.000Z');
  for (let index = 0; index < count; index++) {
    repository.seed(chatRow(index + 1, author, new Date(start + index * 1000)));
  }
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status, code });
}

describe('toChatMessage()', () => {
  const createdAt = new Date('2026-11-15T14:05:00.123Z');

  it('B-19: maps exactly the DTO fields; the avatar key and author id columns never leave the server', () => {
    const message = toChatMessage(chatRow(7, ada, createdAt, 'Hello'), avatarUrl);
    expect(message).toStrictEqual({
      id: 7,
      author: {
        id: ada.id,
        firstName: ada.firstName,
        lastName: ada.lastName,
        avatarUrl: `/api/users/${String(ada.id)}/avatar?v=${parseAvatarKey(ada.avatarKey ?? '')?.version ?? ''}`,
      },
      body: 'Hello',
      createdAt: '2026-11-15T14:05:00.123Z',
    });
    expect(ChatMessage.parse(message)).toStrictEqual(message);
  });

  it('F-108: createdAt is a UTC ISO string with milliseconds; no avatar is null', () => {
    const message = toChatMessage(chatRow(8, grace, createdAt), avatarUrl);
    expect(message.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(message.author.avatarUrl).toBeNull();
  });

  it('picks fields explicitly: a wider row (e.g. with an email) still yields the strict DTO', () => {
    const wideAuthor = { ...grace, email: 'grace@example.com', passwordHash: '$argon2id$...' };
    const message = toChatMessage(chatRow(9, wideAuthor, createdAt), avatarUrl);
    expect(ChatMessage.safeParse(message).success).toBe(true);
    expect(JSON.stringify(message)).not.toContain('example.com');
  });
});

describe('listMessages() (F-76, F-82, B-72, B-73)', () => {
  it('F-76: an empty chat is an empty last page', async () => {
    const { service } = setup();
    await expect(service.listMessages({ limit: 20 })).resolves.toStrictEqual({ items: [], nextCursor: null });
  });

  it('F-76: returns the newest `limit` messages, newest first, with a cursor to the older ones', async () => {
    const { repository, service } = setup();
    seedTimeline(repository, 25);
    const page = await service.listMessages({ limit: 20 });
    expect(page.items.map(({ id }) => id)).toStrictEqual(Array.from({ length: 20 }, (_, index) => 25 - index));
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(ChatPage.parse(page)).toStrictEqual(page);
  });

  it('asks the repository for one page and passes the decoded cursor as the keyset position', async () => {
    const { repository, service } = setup();
    seedTimeline(repository, 3);
    const cursor = encodeCursor({ createdAt: new Date('2026-11-01T10:00:01.000Z'), id: 2 });
    const page = await service.listMessages({ limit: 10, cursor });
    expect(repository.calls.listMessages).toStrictEqual([
      { limit: 10, after: { createdAt: new Date('2026-11-01T10:00:01.000Z'), id: 2 } },
    ]);
    expect(page).toStrictEqual({ items: [expect.objectContaining({ id: 1 })], nextCursor: null });
  });

  it('F-82, B-73: paging with nextCursor returns every message exactly once, in order', async () => {
    const { repository, service } = setup();
    seedTimeline(repository, 25);
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listMessages({ limit: 10, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toStrictEqual(Array.from({ length: 25 }, (_, index) => 25 - index));
    expect(repository.calls.listMessages).toHaveLength(3);
  });

  it('B-72: messages in the same millisecond are ordered by id, and none is skipped across pages (ADR-0014)', async () => {
    const { repository, service } = setup();
    const sameMillisecond = new Date('2026-11-15T14:05:00.000Z');
    for (const id of [3, 1, 2]) repository.seed(chatRow(id, ada, sameMillisecond));
    const first = await service.listMessages({ limit: 2 });
    expect(first.items.map(({ id }) => id)).toStrictEqual([3, 2]);
    const second = await service.listMessages({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(second).toStrictEqual({ items: [expect.objectContaining({ id: 1 })], nextCursor: null });
  });

  it('a full last page has no next cursor (the repository found no limit + 1 row)', async () => {
    const { repository, service } = setup();
    seedTimeline(repository, 10);
    await expect(service.listMessages({ limit: 10 })).resolves.toMatchObject({ nextCursor: null });
  });

  it.each([
    ['not base64url', 'not a cursor!'],
    ['base64url but not JSON', Buffer.from('hello').toString('base64url')],
    ['JSON of the wrong shape', Buffer.from(JSON.stringify({ t: 'yesterday', id: 1 })).toString('base64url')],
    [
      'an id above int32',
      Buffer.from(JSON.stringify({ t: '2026-11-15T14:05:00.000Z', id: 2 ** 31 })).toString('base64url'),
    ],
  ])('rejects a cursor that is %s as 400 invalid-cursor before querying', async (_label, cursor) => {
    const { repository, service } = setup();
    await expectAppError(service.listMessages({ limit: 20, cursor }), 400, 'invalid-cursor');
    expect(repository.calls.listMessages).toHaveLength(0);
  });

  it('propagates a repository failure unchanged (it becomes a generic 500 at the error handler)', async () => {
    const { repository, service } = setup();
    const failure = new Error('connection terminated');
    repository.failNext('listMessages', failure);
    await expect(service.listMessages({ limit: 20 })).rejects.toBe(failure);
  });
});

describe('send() (F-79, B-47, B-75)', () => {
  it('B-47: returns the persisted message: database id and timestamp, the stored author, the stored body', async () => {
    const dbClock = new Date('2026-11-15T14:05:00.321Z');
    const { repository, service } = setup({ now: () => dbClock });
    seedTimeline(repository, 4);

    const message = await service.send(ada.id, { body: 'Hello, chat' });

    expect(message).toStrictEqual(toChatMessage(chatRow(5, ada, dbClock, 'Hello, chat'), avatarUrl));
    expect(ChatMessage.parse(message)).toStrictEqual(message);
    expect(repository.messages.at(-1)).toMatchObject({ id: 5, body: 'Hello, chat' });
  });

  it('B-75: one repository call per message (insert returning + author join), no extra lookups', async () => {
    const { repository, service } = setup();
    await service.send(grace.id, { body: 'One round trip' });
    expect(repository.calls.insertMessage).toStrictEqual([{ authorId: grace.id, body: 'One round trip' }]);
    expect(repository.calls.listMessages).toHaveLength(0);
  });

  it('the author comes from the database row, not from the caller (a stale handshake summary cannot leak)', async () => {
    const { repository, service } = setup();
    repository.addAuthor({ ...grace, lastName: 'Renamed' });
    const message = await service.send(grace.id, { body: 'Hi' });
    expect(message.author.lastName).toBe('Renamed');
  });

  it('propagates a failed insert, so the socket pipeline acks internal and nothing is broadcast', async () => {
    const { repository, service } = setup();
    await expect(service.send(999, { body: 'From nobody' })).rejects.toMatchObject({ code: '23503' });
    expect(repository.messages).toHaveLength(0);
  });
});

describe('chat:send payload: SendChatMessage (F-78, F-112, B-48)', () => {
  it('F-78: trims the body before it is persisted', () => {
    expect(SendChatMessage.parse({ body: '  Hello\n' })).toStrictEqual({ body: 'Hello' });
  });

  it('F-78: keeps inner line breaks (Shift+Enter)', () => {
    expect(SendChatMessage.parse({ body: 'line one\nline two' })).toStrictEqual({ body: 'line one\nline two' });
  });

  it(`F-78: accepts exactly ${String(CHAT_MAX)} characters after trimming`, () => {
    const body = 'x'.repeat(CHAT_MAX);
    expect(SendChatMessage.parse({ body: `  ${body}  ` })).toStrictEqual({ body });
  });

  it.each([
    ['an empty body', { body: '' }],
    ['a whitespace-only body', { body: ' \n\t ' }],
    [`${String(CHAT_MAX + 1)} characters`, { body: 'x'.repeat(CHAT_MAX + 1) }],
    ['a number', { body: 42 }],
    ['an object body', { body: { text: 'hi' } }],
    ['a missing body', {}],
    ['a bare string payload', 'hello'],
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ body: 'hi' }]],
  ])('F-112: rejects %s', (_label, payload) => {
    expect(SendChatMessage.safeParse(payload).success).toBe(false);
  });
});

describe('chat:send budget: limits.chatSend per user (F-84)', () => {
  it('F-84: production allows 10 messages per 10 s per user', () => {
    expect(DEFAULT_LIMITS.chatSend).toStrictEqual({ limit: 10, windowMs: 10_000 });
  });

  it('F-84: the 11th message in the window is rejected with the time to the window end; others are unaffected', async () => {
    let now = 0;
    const limiter = createMemorySocketEventLimiter({ ...DEFAULT_LIMITS.chatSend, now: () => now });
    for (let sent = 0; sent < 10; sent++) {
      await expect(limiter.consume(String(ada.id))).resolves.toMatchObject({ allowed: true });
    }
    now = 4_000;
    await expect(limiter.consume(String(ada.id))).resolves.toStrictEqual({ allowed: false, retryAfterMs: 6_000 });
    await expect(limiter.consume(String(grace.id))).resolves.toMatchObject({ allowed: true });

    now = 10_000;
    await expect(limiter.consume(String(ada.id))).resolves.toMatchObject({ allowed: true });
  });
});
