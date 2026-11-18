import { describe, expect, it } from 'vitest';

import { DemoBackend } from '../backend';
import { DemoSocketServer, socketLinkUrl } from '../realtime';
import { decodeSocketIoFrame, encodeSocketIoPacket, engineOpenFrame } from '../socket-io-extension';
import type { SocketIoPacket } from '../socket-io-extension';
import { DEMO_PASSWORD } from '../state';
import { connectOrFail, createTestBackend, fakeUuid, MIRA_EMAIL, NOW } from './fakes';

describe('Socket.IO framing of the demo socket (ADR-0020)', () => {
  it('opens the Engine.IO session for WebSocket only, with a heartbeat that never runs out', () => {
    const frame = engineOpenFrame();
    expect(frame.startsWith('0')).toBe(true);
    const open = JSON.parse(frame.slice(1)) as { upgrades: unknown[]; pingInterval: number; pingTimeout: number };
    expect(open.upgrades).toEqual([]);
    // Below the 2^31 - 1 ms limit of setTimeout, which socket.io-client sets to interval + timeout.
    expect(open.pingInterval + open.pingTimeout).toBeLessThan(2 ** 31 - 1);
    expect(open.pingInterval).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('decodes the client frames socket.io-client sends', () => {
    expect(decodeSocketIoFrame('40')).toEqual({ type: 'connect' });
    expect(decodeSocketIoFrame('41')).toEqual({ type: 'disconnect' });
    expect(decodeSocketIoFrame('42["wall:leave",{"userId":2}]')).toEqual({
      type: 'event',
      event: 'wall:leave',
      args: [{ userId: 2 }],
    });
    expect(decodeSocketIoFrame('4217["chat:send",{"body":"hi"}]')).toEqual({
      type: 'event',
      event: 'chat:send',
      args: [{ body: 'hi' }],
      id: 17,
    });
  });

  it('drops pongs, binary data, broken JSON and other namespaces', () => {
    expect(decodeSocketIoFrame('3')).toBeUndefined();
    expect(decodeSocketIoFrame(new ArrayBuffer(4))).toBeUndefined();
    expect(decodeSocketIoFrame('42["chat:send",')).toBeUndefined();
    expect(decodeSocketIoFrame('42[1,2]')).toBeUndefined();
    expect(decodeSocketIoFrame('40/admin,')).toBeUndefined();
  });

  it('encodes the server packets', () => {
    expect(encodeSocketIoPacket({ type: 'connect', sid: 'abc' })).toBe('40{"sid":"abc"}');
    expect(encodeSocketIoPacket({ type: 'connect_error', message: 'unauthorized' })).toBe(
      '44{"message":"unauthorized"}',
    );
    expect(encodeSocketIoPacket({ type: 'event', event: 'presence:left', args: [{ userId: 4 }] })).toBe(
      '42["presence:left",{"userId":4}]',
    );
    expect(encodeSocketIoPacket({ type: 'ack', id: 17, args: [{ ok: true }] })).toBe('4317[{"ok":true}]');
  });
});

function socketRecorder() {
  const sent: SocketIoPacket[] = [];
  return { sent, send: (packet: SocketIoPacket) => sent.push(packet) };
}

async function serverWithBackend({ signedIn }: { signedIn: boolean }) {
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
  if (signedIn) await backend.login({ email: MIRA_EMAIL, password: DEMO_PASSWORD });
  return { server, backend };
}

describe('the demo socket link', () => {
  it('listens on the page’s own origin, ws or wss like the page (msw strips the /socket.io/ prefix itself)', () => {
    expect(socketLinkUrl('https://arnoldovna.github.io/social-network/chat')).toBe('wss://arnoldovna.github.io/');
    expect(socketLinkUrl('http://127.0.0.1:4180/social-network/')).toBe('ws://127.0.0.1:4180/');
  });
});

describe('DemoSocketServer (API.md §3)', () => {
  it('refuses the handshake without a session, like authenticateSocket', async () => {
    const { server } = await serverWithBackend({ signedIn: false });
    const client = socketRecorder();

    expect(server.connect(client.send)).toBeNull();
    expect(client.sent).toEqual([{ type: 'connect_error', message: 'unauthorized' }]);
  });

  it('acknowledges chat:send with the stored message and sends chat:message to every socket', async () => {
    const { server } = await serverWithBackend({ signedIn: true });
    const sender = socketRecorder();
    const other = socketRecorder();
    const senderSocket = connectOrFail(server, sender.send);
    server.connect(other.send);

    const ack = await server.handle(senderSocket, 'chat:send', { body: 'Hello from the demo' });

    expect(ack).toMatchObject({ ok: true, message: { body: 'Hello from the demo', author: { id: 1 } } });
    for (const client of [sender, other]) {
      expect(client.sent.at(-1)).toMatchObject({ type: 'event', event: 'chat:message' });
    }
  });

  it('answers invalid payloads and forbidden walls through the acknowledgement (F-112, B-39)', async () => {
    const { server } = await serverWithBackend({ signedIn: true });
    const socket = connectOrFail(server, socketRecorder().send);

    expect(await server.handle(socket, 'chat:send', { body: '' })).toMatchObject({
      ok: false,
      error: { code: 'validation-failed' },
    });
    expect(await server.handle(socket, 'wall:join', { userId: '2' })).toMatchObject({
      ok: false,
      error: { code: 'validation-failed' },
    });
    expect(await server.handle(socket, 'wall:join', { userId: 4 })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await server.handle(socket, 'wall:join', { userId: 999 })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('sends wall events only to sockets in that wall’s room (F-72, B-40)', async () => {
    const { server, backend } = await serverWithBackend({ signedIn: true });
    const inRoom = socketRecorder();
    const elsewhere = socketRecorder();
    const roomSocket = connectOrFail(server, inRoom.send);
    server.connect(elsewhere.send);
    expect(await server.handle(roomSocket, 'wall:join', { userId: 2 })).toEqual({ ok: true });

    await backend.createPost('2', { body: 'For Tomás' });

    expect(inRoom.sent.at(-1)).toMatchObject({ type: 'event', event: 'wall:post-created' });
    expect(elsewhere.sent.some((packet) => packet.type === 'event' && packet.event === 'wall:post-created')).toBe(
      false,
    );
  });

  it('closes the sockets of a session on logout and takes an ex-friend out of the wall room', async () => {
    const { server, backend } = await serverWithBackend({ signedIn: true });
    const client = socketRecorder();
    const socket = connectOrFail(server, client.send);
    expect(await server.handle(socket, 'wall:join', { userId: 2 })).toEqual({ ok: true });

    await backend.removeFriendship('2');
    expect(socket.walls.has(2)).toBe(false);

    await backend.logout();
    expect(client.sent.at(-1)).toEqual({ type: 'disconnect' });
  });

  it('acks unauthorized once the session ended, like the per-event session guard', async () => {
    const { server, backend } = await serverWithBackend({ signedIn: true });
    const socket = connectOrFail(server, socketRecorder().send);

    await backend.logout();

    expect(await server.handle(socket, 'chat:send', { body: 'too late' })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
  });
});
