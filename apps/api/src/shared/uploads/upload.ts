import { AVATAR_MIME_TYPES, type AvatarMimeType } from '@app/shared';
import type { RequestHandler } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import multer from 'multer';

import { FileRequiredError, UnsupportedMediaTypeError } from '../errors/app-error.js';

/**
 * Multipart parser of `PUT /api/me/avatar` (ADR-0010 §1). Memory storage keeps the bytes off disk (B-31, B-34) so
 * they can be sniffed before anything is persisted; the limits are what protects memory: exactly one part, which
 * must be the file in `field`, of at most `maxBytes`.
 *
 * Every violation reaches the error handler as a `MulterError`: `LIMIT_FILE_SIZE` becomes 413 `file-too-large`
 * (B-32), any other field, a second file or a file under another name 400 `invalid-request` (shared/http/problem.ts).
 * A request without a file passes through with `req.file` unset; `sniffImage` turns that into 400 `file-required`.
 */
export function avatarUpload(field: string, maxBytes: number): RequestHandler {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 },
  }).single(field);
}

export interface SniffedImage {
  buffer: Buffer;
  mime: AvatarMimeType;
}

function isAvatarMimeType(mime: string): mime is AvatarMimeType {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Trusts the magic bytes, never the client's `Content-Type` or filename (B-29, B-30). No file, or an empty one, is
 * 400 `file-required` (B-33); anything that is not JPEG, PNG, WebP or GIF is 415 `unsupported-media-type`.
 *
 * The object key is not decided here: the stored avatar is always the re-encoded WebP from `processAvatar`, keyed by
 * `newAvatarKey(userId)` (shared/media/media-url.ts).
 */
export async function sniffImage(file: Express.Multer.File | undefined): Promise<SniffedImage> {
  if (!file || file.buffer.length === 0) throw new FileRequiredError();
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !isAvatarMimeType(detected.mime)) throw new UnsupportedMediaTypeError(AVATAR_MIME_TYPES);
  return { buffer: file.buffer, mime: detected.mime };
}
