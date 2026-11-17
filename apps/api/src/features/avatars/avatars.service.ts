import type { Readable } from 'node:stream';

import type { Me } from '@app/shared';

import { toPublicUser } from '../../db/selections.js';
import type { Actor } from '../../shared/auth/guards.js';
import { NotFoundError, UnauthorizedError } from '../../shared/errors/app-error.js';
import { type AvatarUrl, newAvatarKey, parseAvatarKey } from '../../shared/media/media-url.js';
import type { ObjectStorage } from '../../shared/storage/object-storage.js';
import { AVATAR_CONTENT_TYPE, type ProcessedAvatar } from '../../shared/uploads/process-image.js';
import type { SniffedImage } from '../../shared/uploads/upload.js';
import type { AvatarsRepository } from './avatars.repository.js';

/** The one logger method the service uses; pino's `Logger` satisfies it. */
export interface WarnLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface AvatarsServiceDeps {
  repository: AvatarsRepository;
  storage: ObjectStorage;
  avatarUrl: AvatarUrl;
  /** Header check, bounded decode and WebP re-encode: `processAvatar` in production (ADR-0010 §3). */
  processImage: (buffer: Buffer) => Promise<ProcessedAvatar>;
  logger: WarnLogger;
}

/** The user's current avatar object, resolved from the database (ADR-0010 §8). */
export interface CurrentAvatar {
  key: string;
  /** The key's uuid: the `v` of `avatarUrl` and the route's `ETag`. */
  version: string;
}

export interface AvatarImage extends CurrentAvatar {
  body: Readable;
  contentType: string;
}

/**
 * The SDK's `NoSuchKey` (GetObject) and `NotFound` (HEAD) errors, and the fake storage's equivalent: the object is
 * gone. Matched by name, so the service does not depend on the AWS SDK's classes.
 */
const MISSING_OBJECT_ERRORS: ReadonlySet<string> = new Set(['NoSuchKey', 'NotFound']);

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && MISSING_OBJECT_ERRORS.has(error.name);
}

export type AvatarsService = ReturnType<typeof createAvatarsService>;

export function createAvatarsService({ repository, storage, avatarUrl, processImage, logger }: AvatarsServiceDeps) {
  /** Best effort: a leftover object is never served (only the current key is), so a failure is a warning only. */
  async function deleteQuietly(key: string, reason: string): Promise<void> {
    try {
      await storage.delete(key);
    } catch (error) {
      logger.warn({ err: error, key }, `could not delete ${reason} avatar object`);
    }
  }

  async function findCurrent(userId: number): Promise<CurrentAvatar> {
    const row = await repository.findAvatarKey(userId);
    if (!row?.avatarKey) throw new NotFoundError('Avatar');
    const parsed = parseAvatarKey(row.avatarKey);
    // `users_avatar_key_chk` only admits server-made keys of the row's own id; anything else is a broken invariant.
    if (parsed?.userId !== userId) throw new Error(`Stored avatar key of user ${String(userId)} is malformed.`);
    return { key: row.avatarKey, version: parsed.version };
  }

  async function read(current: CurrentAvatar): Promise<AvatarImage | undefined> {
    try {
      const object = await storage.get(current.key);
      return { ...current, body: object.body, contentType: object.contentType ?? AVATAR_CONTENT_TYPE };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  return {
    /**
     * `PUT /api/me/avatar` after sniffing (ADR-0010): re-encode under the pixel limits, store the WebP under a fresh
     * server-made key, swap the key atomically, then delete the replaced object (F-39, B-36). Validation and
     * processing happen before anything is stored (B-35). A failed `put` leaves the database untouched; a failed
     * swap removes the new object again, so no orphan is left (B-34). Returns the signed-in user with the new
     * `avatarUrl` (B-62).
     */
    async replaceAvatar(actor: Actor, image: SniffedImage): Promise<Me> {
      const processed = await processImage(image.buffer);
      const key = newAvatarKey(actor.userId);
      await storage.put(key, processed.buffer, processed.contentType);

      let swap: Awaited<ReturnType<AvatarsRepository['swapAvatarKey']>>;
      try {
        swap = await repository.swapAvatarKey(actor.userId, key);
      } catch (error) {
        await deleteQuietly(key, 'unreferenced new');
        throw error;
      }
      if (!swap) {
        // The session outlived its account: nothing references the new object.
        await deleteQuietly(key, 'unreferenced new');
        throw new UnauthorizedError();
      }

      if (swap.oldKey !== null && swap.oldKey !== key) await deleteQuietly(swap.oldKey, 'replaced');
      return toPublicUser(swap.user, avatarUrl);
    },

    /** The user's current avatar key and version; 404 for an unknown user or a user without an avatar. */
    findCurrent,

    /**
     * Opens the object of `current` (from `findCurrent`). When it is gone because a concurrent upload replaced and
     * deleted it in between, the newer avatar is served instead; a key without an object is a 404, never a 500.
     */
    async open(userId: number, current: CurrentAvatar): Promise<AvatarImage> {
      const image = await read(current);
      if (image) return image;
      const latest = await findCurrent(userId);
      const newer = latest.key === current.key ? undefined : await read(latest);
      if (!newer) throw new NotFoundError('Avatar');
      return newer;
    },
  };
}
