import type { ClientToServerEvents, ServerToClientEvents, UserSummary } from '@app/shared';
import type { Server, Socket } from 'socket.io';

/**
 * Typed socket.io surface of the API (API.md §3, ADR-0008). The event maps come from `packages/shared/src/realtime.ts`,
 * so server and client cannot drift apart. Client -> server payloads are `unknown` there on purpose: every handler
 * has to `safeParse` them (F-112, B-48).
 */

/** What the handshake (`socket-auth.ts`) stores on every accepted socket; read-only for feature handlers. */
export interface SocketData {
  /** Loaded once during the handshake (no per-event user lookup, B-75). Public fields only (B-19). */
  user: UserSummary;
  /** The express-session id of the handshake; `rooms.session(sessionId)` and the `SessionGuard` key on it. */
  sessionId: string;
}

/** No server-to-server events: v1 runs one API instance (ADR-0008). */
type InterServerEvents = never;

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * A feature's socket handlers (`features/<x>/<x>.socket.ts`), returned from its `index.ts` and called once per
 * accepted connection by `socket-server.ts`, in order (presence first). Must not throw; it only registers listeners.
 */
export type SocketRegistrar = (socket: AppSocket, io: AppServer) => void;

/**
 * The port through which HTTP-side services (auth, friends, wall) reach connected clients (ADR-0008). Room names
 * come only from `rooms.*` in `rooms.ts`. Implemented by `createRealtimePublisher` in `publisher.ts`; unit tests pass
 * a recording fake.
 */
export interface RealtimePublisher {
  /** Emits a server -> client event to every connected socket in `room`. */
  emitToRoom<E extends keyof ServerToClientEvents>(
    room: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  /** Makes every socket in `socketsInRoom` leave `room`, e.g. `leaveRoom(rooms.user(a), rooms.wall(b))`. */
  leaveRoom(socketsInRoom: string, room: string): void;
  /** Closes every socket of a session (logout, F-20); the client sees `io server disconnect`. */
  disconnectSession(sessionId: string): void;
}

/** The `connect_error` message of a rejected handshake; the contract lives in `@app/shared` (API.md §3). */
export type { HandshakeErrorCode } from '@app/shared';

/**
 * Loads the public summary of the handshake's user (one query per connection). `null` when the user does not exist
 * (any more), which rejects the handshake as `unauthorized`. Provided by the composition root, because `shared/`
 * may not touch the database (ESLint boundaries; SQL lives in repositories).
 */
export type UserSummaryLoader = (userId: number) => Promise<UserSummary | null>;
