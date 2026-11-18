import { WebSocketExtension } from 'msw/ws';
import type { WebSocketData } from 'msw/ws';

/**
 * A Socket.IO packet as the demo's mocked server sees it (default namespace only, JSON payloads only: the app sends no
 * binary data). `id` is the acknowledgement id of an event that expects an answer.
 */
export type SocketIoPacket =
  | { type: 'connect'; sid?: string }
  | { type: 'connect_error'; message: string }
  | { type: 'disconnect' }
  | { type: 'event'; event: string; args: unknown[]; id?: number }
  | { type: 'ack'; id: number; args: unknown[] };

/**
 * The client sends no heartbeat of its own in Engine.IO 4; it only answers the server's pings. A mocked server that
 * never pings would be dropped after `pingInterval + pingTimeout`, so the open packet announces an interval that never
 * runs out in a browsing session (about 12 days, still below the 2^31 - 1 ms limit of `setTimeout`).
 */
const PING_INTERVAL_MS = 2 ** 30;
const PING_TIMEOUT_MS = 20_000;

/** Engine.IO packet types (protocol v4). */
const ENGINE_OPEN = '0';
const ENGINE_MESSAGE = '4';

/** Socket.IO packet types (protocol v5). */
const SOCKET_CONNECT = '0';
const SOCKET_DISCONNECT = '1';
const SOCKET_EVENT = '2';
const SOCKET_ACK = '3';
const SOCKET_CONNECT_ERROR = '4';

/** `4` (Engine.IO message), the Socket.IO type, an optional ack id, then the JSON payload. */
const MESSAGE_FRAME = /^4([0-4])(\d*)(.*)$/s;

function randomSid(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Decodes one raw client frame into a packet; anything the demo does not speak (pongs, binary, namespaces) is dropped. */
export function decodeSocketIoFrame(data: WebSocketData): SocketIoPacket | undefined {
  if (typeof data !== 'string') return undefined;
  const match = MESSAGE_FRAME.exec(data);
  if (match === null) return undefined;
  const [, type, idText = '', payload = ''] = match;
  // Only the default namespace exists (`40/admin,` and the like are ignored, as the API registers no namespace).
  if (payload.startsWith('/')) return undefined;
  switch (type) {
    case SOCKET_CONNECT:
      return { type: 'connect' };
    case SOCKET_DISCONNECT:
      return { type: 'disconnect' };
    case SOCKET_EVENT: {
      const parsed = parseJson(payload);
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return undefined;
      const [event, ...args] = parsed as [string, ...unknown[]];
      return idText === '' ? { type: 'event', event, args } : { type: 'event', event, args, id: Number(idText) };
    }
    default:
      return undefined;
  }
}

/** Encodes one packet of the mocked server as a raw frame. */
export function encodeSocketIoPacket(packet: SocketIoPacket): string {
  switch (packet.type) {
    case 'connect':
      return `${ENGINE_MESSAGE}${SOCKET_CONNECT}${JSON.stringify({ sid: packet.sid ?? randomSid() })}`;
    case 'connect_error':
      return `${ENGINE_MESSAGE}${SOCKET_CONNECT_ERROR}${JSON.stringify({ message: packet.message })}`;
    case 'disconnect':
      return `${ENGINE_MESSAGE}${SOCKET_DISCONNECT}`;
    case 'event':
      return `${ENGINE_MESSAGE}${SOCKET_EVENT}${JSON.stringify([packet.event, ...packet.args])}`;
    case 'ack':
      return `${ENGINE_MESSAGE}${SOCKET_ACK}${String(packet.id)}${JSON.stringify(packet.args)}`;
  }
}

/** The Engine.IO open packet: WebSocket only, no upgrades, a heartbeat that never runs out (see PING_INTERVAL_MS). */
export function engineOpenFrame(): string {
  return `${ENGINE_OPEN}${JSON.stringify({
    sid: randomSid(),
    upgrades: [],
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
    maxPayload: 1_000_000,
  })}`;
}

/**
 * A thin Socket.IO server endpoint for msw 3's WebSocket interception (ADR-0020). msw intercepts the browser's
 * `WebSocket`; this extension speaks the two protocols on top of it, so the app's unchanged socket.io-client connects
 * to the in-browser demo exactly as to the real API:
 * - Engine.IO: the open packet when the mocked connection opens (`connect`); client pongs are swallowed.
 * - Socket.IO: frames are decoded into `SocketIoPacket`s for the `connection` listener, and the packets it sends are
 *   encoded back (`client.send({ type: 'event', … })`).
 *
 * The connect handshake (`40`) reaches the listener as `{ type: 'connect' }`, so the demo decides like the real server
 * whether the session may connect (`connect` or `connect_error: unauthorized`).
 *
 * Why not `@mswjs/socket.io-binding`: its last release (0.2.0) declares `msw ^2` as a peer and builds on the 2.x
 * interceptors, while this project uses msw 3, whose `WebSocketExtension` is exactly the hook such a binding needs.
 */
export class SocketIoExtension extends WebSocketExtension<SocketIoPacket> {
  encode(message: SocketIoPacket): string {
    return encodeSocketIoPacket(message);
  }

  decode(data: WebSocketData): SocketIoPacket | undefined {
    return decodeSocketIoFrame(data);
  }

  override connect(): string {
    return engineOpenFrame();
  }
}
