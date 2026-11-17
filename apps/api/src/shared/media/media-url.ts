import { randomUUID } from 'node:crypto';

/**
 * Builds the public `avatarUrl` of a user from the stored object key (ADR-0010 §8, B-05). The DB stores keys only;
 * every DTO that carries an `avatarUrl` (users, friendships, wall, chat, presence) gets it from this function.
 */
export type AvatarUrl = (userId: number, avatarKey: string | null) => string | null;

/**
 * `avatars/<userId>/<uuid>.webp`, the only shape `users.avatar_key` accepts (DATA-MODEL check constraint). The uuid is
 * lowercase, as `randomUUID()` produces it.
 */
const AVATAR_KEY_PATTERN =
  /^avatars\/([1-9]\d{0,9})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/;

export interface AvatarKey {
  userId: number;
  /** The key's uuid: the `v` of the avatar URL and the `ETag` of the avatar route. */
  version: string;
}

/** Parses a stored avatar key; `null` for anything that is not a server-generated key. */
export function parseAvatarKey(key: string): AvatarKey | null {
  const match = AVATAR_KEY_PATTERN.exec(key);
  if (!match?.[1] || !match[2]) return null;
  return { userId: Number(match[1]), version: match[2] };
}

/**
 * A fresh, server-generated object key for a user's re-encoded avatar (always WebP). The client's filename and
 * type never reach the key (B-30, FEATURES Appendix C).
 */
export function newAvatarKey(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new RangeError('userId must be a positive integer.');
  return `avatars/${String(userId)}/${randomUUID()}.webp`;
}

/**
 * The stable per-user avatar route with the current key's uuid as cache buster:
 * `/api/users/<id>/avatar?v=<uuid>`, or `null` without an avatar. The route always serves the user's *current*
 * object, so an old URL held in any cache can be stale but never broken (ADR-0010 §8, F-37).
 *
 * A key that does not belong to `userId` or does not have the server's shape cannot come from the database (check
 * constraint, keys built by `newAvatarKey`); it throws instead of publishing a URL that would point elsewhere.
 */
export function createAvatarUrl(): AvatarUrl {
  return (userId, avatarKey) => {
    if (avatarKey === null) return null;
    const parsed = parseAvatarKey(avatarKey);
    if (parsed?.userId !== userId) {
      throw new Error(`Avatar key of user ${String(userId)} does not match the server's key pattern.`);
    }
    return `/api/users/${String(userId)}/avatar?v=${parsed.version}`;
  };
}
