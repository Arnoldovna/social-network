import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoBackend } from '../backend';
import { DemoSocketServer } from '../realtime';
import type { SocketIoPacket } from '../socket-io-extension';
import { CHAT_REPLIES, DEFAULT_TIMING, startSimulation } from '../simulation';
import { DEMO_PASSWORD } from '../state';
import { connectOrFail, createTestBackend, fakeUuid, MIRA_EMAIL, NOW } from './fakes';

const MIRA = 1;
const NOAH = 4;

async function simulated() {
  const test = await createTestBackend();
  const server = new DemoSocketServer();
  const backend = new DemoBackend({
    state: test.state,
    persistence: test.persistence,
    realtime: server,
    measureImage: () => Promise.resolve(null),
    now: () => NOW,
    randomUUID: fakeUuid,
  });
  server.attach(backend);
  await backend.login({ email: MIRA_EMAIL, password: DEMO_PASSWORD });
  // A fixed sequence instead of Math.random, so the test always picks the same people.
  let step = 0;
  const random = () => {
    step += 1;
    return (step * 0.37) % 1;
  };
  const stop = startSimulation({ backend, server, random });
  // Connected after the start, so only what happens later is recorded.
  const received: SocketIoPacket[] = [];
  const socket = connectOrFail(server, (packet) => received.push(packet));
  const events = (name: string) =>
    received.filter(
      (packet): packet is Extract<SocketIoPacket, { type: 'event' }> =>
        packet.type === 'event' && packet.event === name,
    );
  return { backend, server, socket, stop, events, state: test.state };
}

describe('simulated people of the demo (ADR-0020)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with a few people online, never the visitor', async () => {
    const { backend, stop } = await simulated();

    const online = backend.presence().items;

    expect(online.length).toBeGreaterThanOrEqual(DEFAULT_TIMING.minOnline);
    expect(online.map((user) => user.id)).not.toContain(MIRA);
    stop();
  });

  it('lets people come online and go offline over time, announced with presence events (F-87)', async () => {
    const { events, stop } = await simulated();

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.presenceMs[1] * 6);

    const changes = events('presence:joined').length + events('presence:left').length;
    expect(changes).toBeGreaterThanOrEqual(6);
    stop();
  });

  it('answers a chat message of the visitor once, from someone online, after a short delay', async () => {
    const { server, socket, events, backend, stop } = await simulated();
    const onlineIds = backend.presence().items.map((user) => user.id);

    await server.handle(socket, 'chat:send', { body: 'Anyone up for a walk?' });
    await server.handle(socket, 'chat:send', { body: 'Around four?' });
    expect(events('chat:message')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.replyMs[0] - 1);
    expect(events('chat:message')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.replyMs[1]);

    const replies = events('chat:message').slice(2);
    expect(replies).toHaveLength(1);
    const reply = replies[0]?.args[0] as { author: { id: number }; body: string };
    expect(onlineIds).toContain(reply.author.id);
    expect(CHAT_REPLIES).toContain(reply.body);
    stop();
  });

  it('accepts the visitor’s friend request after a few seconds (F-52)', async () => {
    const { backend, events, stop } = await simulated();

    await backend.sendFriendRequest({ userId: NOAH });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.acceptMs[1]);

    expect(events('friendship:changed').map((packet) => packet.args[0])).toEqual([
      { userId: NOAH, state: 'pending_outgoing' },
      { userId: NOAH, state: 'friends' },
    ]);
    expect(backend.profile(String(NOAH)).relationship.state).toBe('friends');
    stop();
  });

  it('stops every timer', async () => {
    const { server, socket, events, stop } = await simulated();
    await server.handle(socket, 'chat:send', { body: 'Last one' });

    stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.presenceMs[1] * 4);

    expect(events('chat:message')).toHaveLength(1);
    expect(events('presence:joined')).toHaveLength(0);
    expect(events('presence:left')).toHaveLength(0);
  });
});
