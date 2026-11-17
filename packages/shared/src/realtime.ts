import { z } from 'zod';

import type { ChatMessage } from './chat.js';
import type { FriendshipChange } from './friendships.js';
import { Id } from './ids.js';
import type { UserSummary } from './user.js';
import type { WallPost } from './wall.js';

/** Error codes of socket acknowledgements (API.md §3). Handlers never throw to socket.io. */
export const SocketErrorCode = z.enum([
  'validation-failed',
  'rate-limited',
  'unauthorized',
  'forbidden',
  'not-found',
  'internal',
]);
export type SocketErrorCode = z.infer<typeof SocketErrorCode>;

export const SocketError = z.object({
  code: SocketErrorCode,
  message: z.string(),
  retryAfterMs: z.number().int().optional(),
});
export type SocketError = z.infer<typeof SocketError>;

/**
 * The `message` of a rejected socket handshake, which socket.io-client reports as `connect_error` (API.md §3).
 * `internal` covers an unexpected failure (Redis or Postgres unreachable); the cause is logged, never sent.
 */
export const HandshakeErrorCode = z.enum(['rate-limited', 'unauthorized', 'too-many-connections', 'internal']);
export type HandshakeErrorCode = z.infer<typeof HandshakeErrorCode>;

/** Acknowledgement of every client -> server event. */
export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: SocketError };

/** Payload of `wall:join` and `wall:leave`: the wall owner's id as a JSON number. */
export const WallRoomPayload = z.object({ userId: Id });
export type WallRoomPayload = z.infer<typeof WallRoomPayload>;

/**
 * Client -> server events. Payloads are `unknown` on purpose: the server must `safeParse` them with the schemas
 * above (`SendChatMessage`, `WallRoomPayload`) before using them (F-112, B-48).
 */
export interface ClientToServerEvents {
  'chat:send': (payload: unknown, ack: (res: Ack<{ message: ChatMessage }>) => void) => void;
  'wall:join': (payload: unknown, ack: (res: Ack) => void) => void;
  'wall:leave': (payload: unknown, ack: (res: Ack) => void) => void;
}

/** Server -> client events. */
export interface ServerToClientEvents {
  'chat:message': (message: ChatMessage) => void;
  'wall:post-created': (post: WallPost) => void;
  'wall:post-deleted': (payload: { id: number; wallOwnerId: number }) => void;
  'presence:joined': (user: UserSummary) => void;
  'presence:left': (payload: { userId: number }) => void;
  'friendship:changed': (change: FriendshipChange) => void;
}
