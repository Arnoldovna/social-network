import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WallRoomPayload, type UserSummary } from '@app/shared';
import express from 'express';
import { pino } from 'pino';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { NotFoundError } from '../../errors/app-error.js';
import { createRedisClient, type RedisClient } from '../../redis/redis.js';
import { bindAnonymousSession } from '../../security/csrf.js';
import { createSessionMiddleware, destroySession, establishSession, sessionKeyPrefix } from '../../security/session.js';
import { ok, onClientEvent } from '../ack.js';
import { createRedisSocketEventLimiter, type SocketEventLimiter } from '../event-limiter.js';
import { createRealtimePublisher } from '../publisher.js';
import { rooms } from '../rooms.js';
import { createSessionGuard } from '../session-guard.js';
import { attachSocketServer, createSocketServer, registerSocketHandlers } from '../socket-server.js';
import type { AppServer, SocketData, SocketRegistrar } from '../types.js';

/**
 * The realtime kernel end to end (ADR-0005, ADR-0008, API.md §3; F-111, F-112, B-07, B-38, B-48): the real socket.io
 * server with the real express-session middleware on the run's Redis 8, a socket.io-client over WebSocket only, and
 * a small Express app whose sign-in route does what the auth unit does (`establishSession`). Users come from an
 * in-memory loader, so this file needs no rows. Every kernel gets its own `test-<uuid>` prefix.
 */

const ORIGIN = 'http://127.0.0.1:5173';
const SESSION_SECRET = 'realtime-session-secret-with-32-chars!';
const silent = pino({ level: 'silent' });

const mira: UserSummary = { id: 1, firstName: 'Mira', lastName: 'Novak', avatarUrl: null };
const jonas: UserSummary = { id: 2, firstName: 'Jonas', lastName: 'Berg', avatarUrl: null };

let redis: RedisClient;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  redis = createRedisClient({ url: inject('redisUrl'), logger: silent });
  await redis.connect();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  await redis.close();
});

function testLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface KernelOptions {
  handshake?: { limit: number; windowMs: number };
  maxSocketsPerUser?: number;
  /** Extra registrars after the built-in test registrar. */
  registrars?: SocketRegistrar[];
  joinLimiter?: SocketEventLimiter;
}

/** The test registrar: `wall:join` with guard + limiter (a mutating event), `wall:leave` without either. */
function wallRegistrar(deps: {
  sessionGuard: ReturnType<typeof createSessionGuard>;
  limiter?: SocketEventLimiter | undefined;
  logger: ReturnType<typeof testLogger>;
}): SocketRegistrar {
  return (socket) => {
    onClientEvent(socket, 'wall:join', {
      schema: WallRoomPayload,
      sessionGuard: deps.sessionGuard,
      ...(deps.limiter ? { limiter: deps.limiter } : {}),
      logger: deps.logger,
      async handle({ userId }) {
        if (userId === 404) throw new NotFoundError('User');
        if (userId === 500) throw new Error('database password=hunter2 refused');
        await socket.join(rooms.wall(userId));
        return ok();
      },
    });
    onClientEvent(socket, 'wall:leave', {
      schema: WallRoomPayload,
      logger: deps.logger,
      async handle({ userId }) {
        await socket.leave(rooms.wall(userId));
        return ok();
      },
    });
  };
}

async function startKernel(options: KernelOptions = {}) {
  const prefix = `test-${randomUUID()}`;
  const logger = testLogger();
  const sessionMiddleware = createSessionMiddleware({
    redis,
    secret: SESSION_SECRET,
    secure: false,
    prefix,
    ttlDays: 1,
  });

  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware);
  app.post('/sign-in', async (req, res) => {
    await establishSession(req, (req.body as { userId: number }).userId);
    res.json({ sessionId: req.sessionID });
  });
  app.post('/anonymous', (req, res) => {
    bindAnonymousSession(req);
    res.status(204).end();
  });
  app.post('/sign-out', async (req, res) => {
    await destroySession(req);
    res.status(204).end();
  });

  const httpServer = createServer(app);
  const io: AppServer = createSocketServer({ allowedOrigins: [ORIGIN] });
  const sessionGuard = createSessionGuard({ io, redis, prefix, logger, intervalMs: 50 });
  const users = new Map([mira, jonas].map((user) => [user.id, user]));
  const { limit, windowMs } = options.handshake ?? { limit: 1_000, windowMs: 60_000 };
  registerSocketHandlers(io, {
    handshakeLimiter: createRedisSocketEventLimiter({ redis, prefix, name: 'ws-handshake', limit, windowMs }),
    trustedHops: 0,
    loadUser: (userId) => Promise.resolve(users.get(userId) ?? null),
    registrars: [wallRegistrar({ sessionGuard, limiter: options.joinLimiter, logger }), ...(options.registrars ?? [])],
    logger,
    ...(options.maxSocketsPerUser === undefined ? {} : { maxSocketsPerUser: options.maxSocketsPerUser }),
  });
  attachSocketServer(io, httpServer, sessionMiddleware);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;

  const clients: ClientSocket[] = [];
  cleanups.push(async () => {
    sessionGuard.stop();
    for (const client of clients) client.disconnect();
    await io.close(); // also closes httpServer
  });

  async function post(path: string, cookie?: string, body?: object): Promise<Response> {
    const headers = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
    const response = await fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    expect(response.ok).toBe(true);
    return response;
  }

  function cookieOf(response: Response): string {
    const [setCookie] = response.headers.getSetCookie();
    if (!setCookie) throw new Error('no session cookie');
    return setCookie.split(';')[0] ?? '';
  }

  return {
    io,
    prefix,
    logger,
    sessionGuard,
    publisher: createRealtimePublisher(io),
    async signIn(user: UserSummary) {
      const response = await post('/sign-in', undefined, { userId: user.id });
      const { sessionId } = (await response.json()) as { sessionId: string };
      return { cookie: cookieOf(response), sessionId };
    },
    async anonymousCookie() {
      return cookieOf(await post('/anonymous'));
    },
    signOut: (cookie: string) => post('/sign-out', cookie),
    /** A websocket-only client that never reconnects on its own. `origin: null` sends no Origin header. */
    client({ cookie, origin = ORIGIN }: { cookie?: string; origin?: string | null } = {}) {
      const extraHeaders = { ...(origin === null ? {} : { origin }), ...(cookie ? { cookie } : {}) };
      const client = connectClient(baseUrl, {
        transports: ['websocket'],
        extraHeaders,
        reconnection: false,
        forceNew: true,
      });
      clients.push(client);
      return client;
    },
  };
}

type Kernel = Awaited<ReturnType<typeof startKernel>>;

/** Resolves with 'connected' or the `connect_error`. */
function outcome(client: ClientSocket): Promise<'connected' | Error> {
  return new Promise((resolve) => {
    client.once('connect', () => {
      resolve('connected');
    });
    client.once('connect_error', resolve);
  });
}

async function connected(kernel: Kernel, user: UserSummary) {
  const session = await kernel.signIn(user);
  const client = kernel.client({ cookie: session.cookie });
  expect(await outcome(client)).toBe('connected');
  return { ...session, client };
}

function nextDisconnect(client: ClientSocket): Promise<string> {
  return new Promise((resolve) => client.once('disconnect', resolve));
}

function nextEvent(client: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => client.once(event, resolve));
}

async function emitWithAck(client: ClientSocket, event: string, payload: unknown): Promise<unknown> {
  const response: unknown = await client.timeout(5_000).emitWithAck(event, payload);
  return response;
}

describe('handshake: origin (F-111, B-07)', () => {
  it('accepts an allow-listed Origin', async () => {
    const kernel = await startKernel();
    const { cookie } = await kernel.signIn(mira);
    expect(await outcome(kernel.client({ cookie }))).toBe('connected');
  });

  it.each([
    ['a missing Origin', null],
    ['a foreign Origin', 'https://evil.example'],
    ['a different port of the same host', 'http://127.0.0.1:5174'],
  ])('rejects %s before the upgrade, even with a valid session', async (_label, origin) => {
    const kernel = await startKernel();
    const { cookie } = await kernel.signIn(mira);
    const result = await outcome(kernel.client({ cookie, origin }));
    expect(result).toBeInstanceOf(Error);
    expect(kernel.io.sockets.sockets.size).toBe(0);
  });
});

describe('handshake: authentication (F-111, B-38)', () => {
  it('rejects a socket without a session cookie as unauthorized', async () => {
    const kernel = await startKernel();
    const result = await outcome(kernel.client());
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('unauthorized');
  });

  it('rejects an anonymous (CSRF-bound, not signed-in) session', async () => {
    const kernel = await startKernel();
    const cookie = await kernel.anonymousCookie();
    expect(((await outcome(kernel.client({ cookie }))) as Error).message).toBe('unauthorized');
  });

  it('rejects the cookie of a session that was destroyed (logout)', async () => {
    const kernel = await startKernel();
    const { cookie } = await kernel.signIn(mira);
    await kernel.signOut(cookie);
    expect(((await outcome(kernel.client({ cookie }))) as Error).message).toBe('unauthorized');
  });

  it('rejects a session of a user that no longer exists', async () => {
    const kernel = await startKernel();
    const ghost: UserSummary = { id: 99, firstName: 'Gone', lastName: 'User', avatarUrl: null };
    const { cookie } = await kernel.signIn(ghost);
    expect(((await outcome(kernel.client({ cookie }))) as Error).message).toBe('unauthorized');
  });

  it('stores the loaded summary and the session id on the socket', async () => {
    const kernel = await startKernel();
    const { sessionId } = await connected(kernel, mira);
    const [socket] = await kernel.io.fetchSockets();
    expect(socket?.data).toStrictEqual({ user: mira, sessionId });
  });
});

describe('handshake: limits', () => {
  it('limits handshakes per IP and reports rate-limited with retryAfterMs', async () => {
    const kernel = await startKernel({ handshake: { limit: 2, windowMs: 60_000 } });
    const { cookie } = await kernel.signIn(mira);
    expect(await outcome(kernel.client({ cookie }))).toBe('connected');
    expect(await outcome(kernel.client({ cookie }))).toBe('connected');
    const rejected = await outcome(kernel.client({ cookie }));
    expect((rejected as Error).message).toBe('rate-limited');
    const data: unknown = Reflect.get(rejected as Error, 'data');
    expect(data).toStrictEqual({ retryAfterMs: expect.any(Number) as number });
  });

  it('counts unauthenticated handshakes too (the limiter runs first)', async () => {
    const kernel = await startKernel({ handshake: { limit: 1, windowMs: 60_000 } });
    expect(((await outcome(kernel.client())) as Error).message).toBe('unauthorized');
    expect(((await outcome(kernel.client())) as Error).message).toBe('rate-limited');
  });

  it('caps open sockets per user and frees the slot when one closes', async () => {
    const kernel = await startKernel({ maxSocketsPerUser: 2 });
    const first = await connected(kernel, mira);
    await connected(kernel, mira);
    const { cookie } = await kernel.signIn(mira);
    expect(((await outcome(kernel.client({ cookie }))) as Error).message).toBe('too-many-connections');

    // Another user is not affected by Mira's cap.
    await connected(kernel, jonas);

    first.client.disconnect();
    await vi.waitFor(() => {
      expect(kernel.io.sockets.adapter.rooms.get(rooms.user(mira.id))?.size).toBe(1);
    });
    expect(await outcome(kernel.client({ cookie }))).toBe('connected');
  });

  it('never lets concurrent handshakes of one user exceed the cap', async () => {
    const kernel = await startKernel({ maxSocketsPerUser: 3 });
    const { cookie } = await kernel.signIn(mira);
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(kernel.client({ cookie }))));
    expect(results.filter((result) => result === 'connected')).toHaveLength(3);
    expect(kernel.io.sockets.adapter.rooms.get(rooms.user(mira.id))?.size).toBe(3);
  });
});

describe('connection: rooms and registrars', () => {
  it('joins user, session and chat before the registrars run, which run in order', async () => {
    const calls: string[] = [];
    const seenRooms: string[][] = [];
    const kernel = await startKernel({
      registrars: [
        (socket) => {
          calls.push('first');
          seenRooms.push([...socket.rooms].filter((room) => room !== socket.id).sort());
        },
        () => calls.push('second'),
      ],
    });
    const { sessionId } = await connected(kernel, mira);
    expect(calls).toStrictEqual(['first', 'second']);
    expect(seenRooms).toStrictEqual([[rooms.chat, rooms.session(sessionId), rooms.user(mira.id)].sort()]);
  });

  it('closes a socket whose registrar throws instead of leaving it half registered', async () => {
    const kernel = await startKernel({
      registrars: [
        () => {
          throw new Error('registrar bug');
        },
      ],
    });
    const { cookie } = await kernel.signIn(mira);
    const client = kernel.client({ cookie });
    const disconnected = nextDisconnect(client);
    expect(await outcome(client)).toBe('connected');
    expect(await disconnected).toBe('io server disconnect');
    expect(kernel.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: mira.id }),
      'socket registrar failed',
    );
  });
});

describe('RealtimePublisher', () => {
  it('emitToRoom reaches only the sockets in that room', async () => {
    const kernel = await startKernel();
    const a = await connected(kernel, mira);
    const b = await connected(kernel, jonas);
    const bReceived = vi.fn();
    b.client.on('presence:left', bReceived);

    const received = nextEvent(a.client, 'presence:left');
    kernel.publisher.emitToRoom(rooms.user(mira.id), 'presence:left', { userId: 7 });
    expect(await received).toStrictEqual({ userId: 7 });

    // A sentinel on b's own room arrives after anything sent before it on the same connection.
    const sentinel = nextEvent(b.client, 'presence:joined');
    kernel.publisher.emitToRoom(rooms.user(jonas.id), 'presence:joined', mira);
    expect(await sentinel).toStrictEqual(mira);
    expect(bReceived).not.toHaveBeenCalled();
  });

  it('reaches every authenticated socket through rooms.chat', async () => {
    const kernel = await startKernel();
    const a = await connected(kernel, mira);
    const b = await connected(kernel, jonas);
    const message = { id: 1, author: mira, body: 'Hello', createdAt: new Date().toISOString() };
    const both = Promise.all([nextEvent(a.client, 'chat:message'), nextEvent(b.client, 'chat:message')]);
    kernel.publisher.emitToRoom(rooms.chat, 'chat:message', message);
    expect(await both).toStrictEqual([message, message]);
  });

  it('leaveRoom removes the sockets of one room from another (unfriending, OVERVIEW §8)', async () => {
    const kernel = await startKernel();
    const a = await connected(kernel, mira);
    expect(await emitWithAck(a.client, 'wall:join', { userId: jonas.id })).toStrictEqual({ ok: true });
    const wallEvents = vi.fn();
    a.client.on('wall:post-deleted', wallEvents);

    kernel.publisher.emitToRoom(rooms.wall(jonas.id), 'wall:post-deleted', { id: 1, wallOwnerId: jonas.id });
    await vi.waitFor(() => {
      expect(wallEvents).toHaveBeenCalledTimes(1);
    });

    kernel.publisher.leaveRoom(rooms.user(mira.id), rooms.wall(jonas.id));
    kernel.publisher.emitToRoom(rooms.wall(jonas.id), 'wall:post-deleted', { id: 2, wallOwnerId: jonas.id });
    const sentinel = nextEvent(a.client, 'presence:left');
    kernel.publisher.emitToRoom(rooms.user(mira.id), 'presence:left', { userId: 3 });
    await sentinel;
    expect(wallEvents).toHaveBeenCalledTimes(1);
  });

  it('disconnectSession closes only that session’s sockets (logout, F-20)', async () => {
    const kernel = await startKernel();
    const laptop = await connected(kernel, mira);
    const phone = await connected(kernel, mira);
    const laptopClosed = nextDisconnect(laptop.client);
    kernel.publisher.disconnectSession(laptop.sessionId);
    expect(await laptopClosed).toBe('io server disconnect');
    expect(phone.client.connected).toBe(true);
  });
});

describe('client events: onClientEvent pipeline (F-112, B-48)', () => {
  it('acks ok for a valid payload', async () => {
    const kernel = await startKernel();
    const { client } = await connected(kernel, mira);
    expect(await emitWithAck(client, 'wall:join', { userId: jonas.id })).toStrictEqual({ ok: true });
    expect(kernel.logger.debug).toHaveBeenCalledWith(
      { event: 'wall:join', socketId: expect.any(String) as string, userId: mira.id, ok: true, code: undefined },
      'socket event',
    );
  });

  it.each([
    ['a string id', { userId: '2' }],
    ['a missing id', {}],
    ['a negative id', { userId: -1 }],
    ['no object at all', 'wall'],
    ['null', null],
  ])('acks validation-failed for %s and keeps the socket open', async (_label, payload) => {
    const kernel = await startKernel();
    const { client } = await connected(kernel, mira);
    expect(await emitWithAck(client, 'wall:join', payload)).toStrictEqual({
      ok: false,
      error: { code: 'validation-failed', message: expect.any(String) as string },
    });
    expect(client.connected).toBe(true);
  });

  it('maps an AppError from the handler to its code and detail', async () => {
    const kernel = await startKernel();
    const { client } = await connected(kernel, mira);
    expect(await emitWithAck(client, 'wall:join', { userId: 404 })).toStrictEqual({
      ok: false,
      error: { code: 'not-found', message: 'User was not found.' },
    });
    expect(kernel.logger.error).not.toHaveBeenCalled();
  });

  it('acks internal for an unexpected error, logs it and leaks nothing', async () => {
    const kernel = await startKernel();
    const { client } = await connected(kernel, mira);
    expect(await emitWithAck(client, 'wall:join', { userId: 500 })).toStrictEqual({
      ok: false,
      error: { code: 'internal', message: 'An unexpected error occurred.' },
    });
    expect(kernel.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'wall:join', userId: mira.id, err: expect.any(Error) as Error }),
      'socket event failed',
    );
    expect(client.connected).toBe(true);
  });

  it('rate-limits per user with retryAfterMs after the parse (F-84)', async () => {
    const prefix = `test-${randomUUID()}`;
    const joinLimiter = createRedisSocketEventLimiter({ redis, prefix, name: 'wall-join', limit: 1, windowMs: 60_000 });
    const kernel = await startKernel({ joinLimiter });
    const { client } = await connected(kernel, mira);
    // An invalid payload is rejected before the limiter and does not use up the budget.
    await emitWithAck(client, 'wall:join', { userId: 'x' });
    expect(await emitWithAck(client, 'wall:join', { userId: jonas.id })).toStrictEqual({ ok: true });
    expect(await emitWithAck(client, 'wall:join', { userId: jonas.id })).toStrictEqual({
      ok: false,
      error: {
        code: 'rate-limited',
        message: expect.any(String) as string,
        retryAfterMs: expect.any(Number) as number,
      },
    });
  });

  it('ignores a missing ack callback safely and keeps serving the socket', async () => {
    const kernel = await startKernel();
    const { client } = await connected(kernel, mira);
    client.emit('wall:join', { userId: jonas.id });
    client.emit('wall:join');
    client.emit('wall:join', { userId: jonas.id }, 'not a callback');
    expect(await emitWithAck(client, 'wall:leave', { userId: jonas.id })).toStrictEqual({ ok: true });
    expect(kernel.logger.error).not.toHaveBeenCalled();
  });

  it('drops unknown events without an answer', async () => {
    const kernel = await startKernel();
    const { client } = await connected(kernel, mira);
    await expect(client.timeout(200).emitWithAck('admin:drop-tables', {})).rejects.toThrow();
    expect(client.connected).toBe(true);
  });

  it('closes the connection for a message above 16 KB (maxHttpBufferSize, B-48)', async () => {
    const kernel = await startKernel();
    const { client } = await connected(kernel, mira);
    const closed = nextDisconnect(client);
    client.emit('wall:join', { userId: jonas.id, padding: 'x'.repeat(20_000) });
    expect(await closed).toBe('transport close');
  });

  it('acks unauthorized and disconnects when the session is gone (per-event guard, ADR-0005)', async () => {
    const kernel = await startKernel();
    const { client, sessionId } = await connected(kernel, mira);
    await redis.del(sessionKeyPrefix(kernel.prefix) + sessionId);
    const closed = nextDisconnect(client);
    expect(await emitWithAck(client, 'wall:join', { userId: jonas.id })).toStrictEqual({
      ok: false,
      error: { code: 'unauthorized', message: expect.any(String) as string },
    });
    expect(await closed).toBe('io server disconnect');
  });

  it('does not guard non-mutating events (wall:leave is always ok)', async () => {
    const kernel = await startKernel();
    const { client, sessionId } = await connected(kernel, mira);
    await redis.del(sessionKeyPrefix(kernel.prefix) + sessionId);
    expect(await emitWithAck(client, 'wall:leave', { userId: jonas.id })).toStrictEqual({ ok: true });
  });
});

describe('SessionGuard sweep (ADR-0005)', () => {
  it('disconnects the sockets of ended sessions and keeps the others', async () => {
    const kernel = await startKernel();
    const alive = await connected(kernel, mira);
    const loggedOut = await connected(kernel, jonas);
    const expired = await connected(kernel, jonas);
    await kernel.signOut(loggedOut.cookie);
    await redis.del(sessionKeyPrefix(kernel.prefix) + expired.sessionId); // what a TTL expiry leaves behind

    const closed = Promise.all([nextDisconnect(loggedOut.client), nextDisconnect(expired.client)]);
    await expect(kernel.sessionGuard.sweep()).resolves.toStrictEqual({ checked: 3, disconnected: 2 });
    expect(await closed).toStrictEqual(['io server disconnect', 'io server disconnect']);
    expect(alive.client.connected).toBe(true);
  });

  it('reports nothing to do without sockets', async () => {
    const kernel = await startKernel();
    await expect(kernel.sessionGuard.sweep()).resolves.toStrictEqual({ checked: 0, disconnected: 0 });
  });

  it('shares one pass between overlapping calls', async () => {
    const kernel = await startKernel();
    await connected(kernel, mira);
    const first = kernel.sessionGuard.sweep();
    expect(kernel.sessionGuard.sweep()).toBe(first);
    await first;
  });

  it('start() sweeps periodically until stop()', async () => {
    const kernel = await startKernel();
    const { client, sessionId } = await connected(kernel, mira);
    kernel.sessionGuard.start();
    kernel.sessionGuard.start(); // idempotent: still one timer
    const closed = nextDisconnect(client);
    await redis.del(sessionKeyPrefix(kernel.prefix) + sessionId);
    expect(await closed).toBe('io server disconnect');
    kernel.sessionGuard.stop();

    const later = await connected(kernel, jonas);
    await redis.del(sessionKeyPrefix(kernel.prefix) + later.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(later.client.connected).toBe(true);
  });

  it('isAlive is false for a socket that never passed the handshake', async () => {
    const kernel = await startKernel();
    // socket.data before the handshake has filled it.
    await expect(kernel.sessionGuard.isAlive({ data: {} as SocketData })).resolves.toBe(false);
  });
});
