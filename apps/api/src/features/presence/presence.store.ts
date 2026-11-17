import type { RedisClient } from '../../shared/redis/redis.js';

/**
 * Who is online, kept in Redis (ADR-0009, F-91, B-44): per user a set of the open sockets
 * (`<keyPrefix>:presence:sockets:<userId>` = `<instanceId>:<socketId>` members) and one set of online user ids
 * (`<keyPrefix>:presence:online`). Sets instead of the legacy array make a socket count once and removal by value
 * instead of by index (B-43, B-45).
 *
 * Every method is one atomic Redis round trip (`MULTI` or a Lua script), so the presence decisions never depend on
 * the order in which concurrent connects and disconnects of one user reach the service.
 */
export interface PresenceStore {
  /**
   * Adds one socket of the user and puts the user into the online set, atomically. `cameOnline` is true only when
   * the user was not online before: a second tab, or a reload while the grace period still holds the user online,
   * leaves it false (F-87, F-88).
   */
  addSocket(userId: number, socketRef: string): Promise<{ sockets: number; cameOnline: boolean }>;
  /** Removes one socket of the user (idempotent) and returns how many of the user's sockets are still open. */
  removeSocket(userId: number, socketRef: string): Promise<number>;
  /**
   * The end of the grace period: removes the user from the online set **only if** no socket of theirs is open by
   * now, atomically. True when the user went offline, false when they reconnected (or were offline already).
   */
  markOfflineIfIdle(userId: number): Promise<boolean>;
  /** Every online user id (unordered; the users who are in their grace period included). */
  onlineUserIds(): Promise<number[]>;
  /**
   * Boot cleanup (ADR-0009): deletes every presence key of this namespace and only of this namespace. Every socket
   * from before a restart is gone and clients reconnect on their own. Returns the number of deleted keys.
   */
  clear(): Promise<number>;
}

/** The key layout of one namespace (DATA-MODEL.md, Redis keys). */
export function presenceKeys(keyPrefix: string) {
  const base = `${keyPrefix}:presence:`;
  return {
    sockets: (userId: number): string => `${base}sockets:${String(userId)}`,
    online: `${base}online`,
    /** SCAN pattern of this namespace: glob characters of the prefix are escaped, so it matches only literally. */
    pattern: `${base.replace(/[*?[\]\\]/g, '\\$&')}*`,
  } as const;
}

/**
 * KEYS[1] = the user's socket set, KEYS[2] = the online set, ARGV[1] = the user id. The check and the removal run as
 * one script, so a reconnect can never land between "no socket left" and "remove from online".
 */
const MARK_OFFLINE_IF_IDLE = `
if redis.call('SCARD', KEYS[1]) == 0 then
  return redis.call('SREM', KEYS[2], ARGV[1])
end
return 0
`;

/** SCAN page size of the boot cleanup; a hint to Redis, not a limit. */
const SCAN_COUNT = 200;

/** Online ids are only ever written by `addSocket`; anything that is not a positive integer is ignored, not trusted. */
function toUserId(member: string): number | null {
  const id = Number(member);
  return Number.isSafeInteger(id) && id > 0 && String(id) === member ? id : null;
}

export interface RedisPresenceStoreOptions {
  redis: RedisClient;
  /** `APP_SLUG` in production, `test-<uuid>` per test app (ADR-0009). */
  keyPrefix: string;
}

export function createRedisPresenceStore({ redis, keyPrefix }: RedisPresenceStoreOptions): PresenceStore {
  const keys = presenceKeys(keyPrefix);

  return {
    async addSocket(userId, socketRef) {
      const socketsKey = keys.sockets(userId);
      const [, sockets, added] = await redis
        .multi()
        .sAdd(socketsKey, socketRef)
        .sCard(socketsKey)
        .sAdd(keys.online, String(userId))
        .execTyped();
      return { sockets, cameOnline: added === 1 };
    },

    async removeSocket(userId, socketRef) {
      const socketsKey = keys.sockets(userId);
      const [, remaining] = await redis.multi().sRem(socketsKey, socketRef).sCard(socketsKey).execTyped();
      return remaining;
    },

    async markOfflineIfIdle(userId) {
      const removed = await redis.eval(MARK_OFFLINE_IF_IDLE, {
        keys: [keys.sockets(userId), keys.online],
        arguments: [String(userId)],
      });
      return removed === 1;
    },

    async onlineUserIds() {
      const members = await redis.sMembers(keys.online);
      return members.map(toUserId).filter((id) => id !== null);
    },

    async clear() {
      let deleted = 0;
      for await (const batch of redis.scanIterator({ MATCH: keys.pattern, COUNT: SCAN_COUNT })) {
        // SCAN may return an empty page; UNLINK frees the memory off the main thread.
        if (batch.length > 0) deleted += await redis.unlink(batch);
      }
      return deleted;
    },
  };
}
