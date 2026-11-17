/**
 * The only place that builds socket.io room names (ADR-0008, OVERVIEW §8). Features never write a room string by
 * hand, so no feature depends on another feature's room format. Socket ids (also rooms in socket.io) are 20
 * base64url characters without a colon, so none of these names can collide with one.
 */

function positiveId(kind: string, id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RangeError(`${kind} must be a positive integer.`);
  }
  return String(id);
}

export const rooms = {
  /** Every open socket (tab, device) of one user: `user:<id>`. Also the per-user socket cap's counter. */
  user: (userId: number): string => `user:${positiveId('userId', userId)}`,
  /** Every open socket of one session: `session:<sid>`; logout and the session sweep close it. */
  session: (sessionId: string): string => {
    if (sessionId.length === 0) throw new RangeError('sessionId must not be empty.');
    return `session:${sessionId}`;
  },
  /** Everyone currently viewing a wall, joined only through the permission-checked `wall:join`: `wall:<ownerId>`. */
  wall: (ownerId: number): string => `wall:${positiveId('ownerId', ownerId)}`,
  /** Every authenticated socket (the chat room, F-79). */
  chat: 'chat',
} as const;
