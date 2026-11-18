import { CHAT_MAX, SocketError, WallRoomPayload } from '@app/shared';
import type { Ack, ChatMessage, ServerToClientEvents } from '@app/shared';
import { ws } from 'msw';

import { formatCount } from '../shared/lib/format-count';
import type { DemoBackend, RealtimeEmitter, RealtimeTarget } from './backend';
import { DemoProblem } from './problem';
import { SocketIoExtension } from './socket-io-extension';
import type { SocketIoPacket } from './socket-io-extension';

/** What a client -> server event acknowledges: `chat:send` adds the stored message. */
type EventAck = Ack<{ message?: ChatMessage }>;

/** A connected socket of the demo: how to send it a packet, whose session it is, which wall rooms it joined. */
export interface DemoSocket {
  send(packet: SocketIoPacket): void;
  readonly userId: number;
  readonly walls: Set<number>;
}

/** Hears every event the server sends, whether or not a socket receives it (the simulation reacts to them). */
export type EmitListener = (
  target: RealtimeTarget,
  event: keyof ServerToClientEvents,
  args: readonly unknown[],
) => void;

/**
 * The demo's Socket.IO server (ADR-0020): the rooms of API.md §3 over the sockets connected through the msw WebSocket
 * link. `emit` is what the backend calls after a change; `handle` answers the client -> server events with
 * acknowledgements exactly like the API's handlers (payloads checked with the shared schemas, errors as `SocketError`).
 */
export class DemoSocketServer implements RealtimeEmitter {
  readonly #sockets = new Set<DemoSocket>();
  readonly #listeners = new Set<EmitListener>();
  #backend: DemoBackend | null = null;

  /** Set once both exist (the backend needs the emitter, the server needs the backend). */
  attach(backend: DemoBackend): void {
    this.#backend = backend;
  }

  onEmit(listener: EmitListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit<Event extends keyof ServerToClientEvents>(
    target: RealtimeTarget,
    event: Event,
    ...args: Parameters<ServerToClientEvents[Event]>
  ): void {
    for (const socket of this.#sockets) {
      const receives =
        target.kind === 'all' ||
        (target.kind === 'user' && socket.userId === target.userId) ||
        (target.kind === 'wall' && socket.walls.has(target.ownerId));
      if (receives) socket.send({ type: 'event', event, args });
    }
    for (const listener of this.#listeners) listener(target, event, args);
  }

  leaveWall(userId: number, ownerId: number): void {
    for (const socket of this.#sockets) {
      if (socket.userId === userId) socket.walls.delete(ownerId);
    }
  }

  endSession(userId: number): void {
    for (const socket of [...this.#sockets]) {
      if (socket.userId !== userId) continue;
      socket.send({ type: 'disconnect' });
      this.#sockets.delete(socket);
    }
  }

  /**
   * The handshake (`40`): a socket connects only with a session, otherwise `connect_error: unauthorized`, as the
   * API's `authenticateSocket` middleware answers (the client then treats the session as gone, ADR-0012).
   */
  connect(send: (packet: SocketIoPacket) => void): DemoSocket | null {
    const userId = this.#backend?.sessionUserId() ?? null;
    if (userId === null) {
      send({ type: 'connect_error', message: 'unauthorized' });
      return null;
    }
    const socket: DemoSocket = { send, userId, walls: new Set() };
    this.#sockets.add(socket);
    send({ type: 'connect' });
    return socket;
  }

  disconnect(socket: DemoSocket): void {
    this.#sockets.delete(socket);
  }

  /** One client -> server event; the result goes back through the acknowledgement, if the client asked for one. */
  async handle(socket: DemoSocket, event: string, payload: unknown): Promise<EventAck> {
    const backend = this.#backend;
    // The per-event session guard: the session that connected must still be the current one.
    if (backend === null) {
      return failure('internal', 'The demo is not ready.');
    }
    if (backend.sessionUserId() !== socket.userId) {
      return failure('unauthorized', 'Please log in again.');
    }
    switch (event) {
      case 'chat:send':
        try {
          return { ok: true, message: await backend.sendChat(payload) };
        } catch (error) {
          if (error instanceof DemoProblem && error.code === 'validation-failed') {
            return failure('validation-failed', `Write a message of 1 to ${formatCount(CHAT_MAX)} characters.`);
          }
          throw error;
        }
      case 'wall:join': {
        const parsed = WallRoomPayload.safeParse(payload);
        if (!parsed.success) return failure('validation-failed', 'The wall id is invalid.');
        const access = backend.canJoinWall(parsed.data.userId);
        if (access === 'not-found') return failure('not-found', 'This user does not exist.');
        if (access === 'forbidden') return failure('forbidden', 'Only friends can follow this wall.');
        socket.walls.add(parsed.data.userId);
        return { ok: true };
      }
      case 'wall:leave': {
        const parsed = WallRoomPayload.safeParse(payload);
        if (parsed.success) socket.walls.delete(parsed.data.userId);
        return { ok: true };
      }
      default:
        return failure('validation-failed', 'Unknown event.');
    }
  }
}

function failure(code: SocketError['code'], message: string): EventAck {
  return { ok: false, error: SocketError.parse({ code, message }) };
}

/**
 * The WebSocket address the app's socket.io-client connects to: same origin (`ws:`/`wss:`). msw strips the
 * `/socket.io/` path prefix from Socket.IO URLs before matching, so the link is the origin's root.
 */
export function socketLinkUrl(pageUrl: string): string {
  const url = new URL('/', pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** The msw WebSocket link of the page's own origin, speaking Socket.IO through `SocketIoExtension`, serving `server`. */
export function createSocketHandler(server: DemoSocketServer, pageUrl: string = window.location.href) {
  const link = ws.link(socketLinkUrl(pageUrl), { extensions: [new SocketIoExtension()] });
  return link.addEventListener('connection', ({ client }) => {
    let socket: DemoSocket | null = null;
    const send = (packet: SocketIoPacket) => {
      client.send(packet);
    };
    client.addEventListener('message', (event) => {
      const packet = event.data;
      if (packet.type === 'connect') {
        socket = server.connect(send);
        return;
      }
      if (packet.type === 'disconnect') {
        if (socket !== null) server.disconnect(socket);
        socket = null;
        return;
      }
      if (packet.type !== 'event' || socket === null) return;
      const current = socket;
      const ackId = packet.id;
      void server
        .handle(current, packet.event, packet.args[0])
        .catch((error: unknown) => {
          // eslint-disable-next-line no-console -- the demo has no server log; the browser console is where its failures can be diagnosed
          console.error('demo socket event failed', error);
          return failure('internal', 'Something went wrong.');
        })
        .then((result) => {
          if (ackId !== undefined) send({ type: 'ack', id: ackId, args: [result] });
        });
    });
    client.addEventListener('close', () => {
      if (socket !== null) server.disconnect(socket);
      socket = null;
    });
  });
}
