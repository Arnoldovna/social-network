import { AVATAR_FIELD, AVATAR_MAX_PIXELS, AVATAR_MAX_SIDE_PX, AVATAR_MIME_TYPES } from '@app/shared';
import sharp, { type FormatEnum, type Metadata } from 'sharp';

import { UnsupportedMediaTypeError, ValidationError } from '../errors/app-error.js';

/** Every stored avatar is a square WebP of this size (FEATURES Appendix C, ADR-0010 §3). */
export const AVATAR_SIZE_PX = 512;
export const AVATAR_WEBP_QUALITY = 80;
export const AVATAR_CONTENT_TYPE = 'image/webp';
/** At most this many `processAvatar` calls decode at the same time in this process (ADR-0010 §3). */
export const AVATAR_PROCESSING_SLOTS = 2;

/*
 * Process-wide libvips settings, applied once when the upload pipeline is loaded (at start-up, through the
 * composition root's imports). They are global by nature: libvips has one operation cache and one thread pool per
 * process. Without the cache, decoded images are not kept after a request; one thread per image keeps the peak
 * memory of the two allowed jobs predictable inside the container's `mem_limit` (ADR-0010 §3, OVERVIEW §9).
 */
sharp.cache(false);
sharp.concurrency(1);

/** The libvips loaders that may decode an avatar; any other format (SVG, TIFF, PDF, HEIF, …) is refused. */
const DECODABLE_FORMATS: ReadonlySet<keyof FormatEnum> = new Set(['jpeg', 'png', 'webp', 'gif']);
/** sharp's message when `limitInputPixels` stops a decode; only reachable when a header lies about its size. */
const PIXEL_LIMIT_MESSAGE = 'Input image exceeds pixel limit';

export interface ProcessedAvatar {
  buffer: Buffer;
  contentType: typeof AVATAR_CONTENT_TYPE;
}

type Task<T> = () => Promise<T>;

/**
 * A FIFO semaphore: at most `max` tasks run at once, later ones wait in arrival order. A finished task hands its slot
 * directly to the next waiter, so a newly arriving task can never overtake the queue. The slot is released whether
 * the task resolves or rejects.
 */
export function createConcurrencyLimit(max: number): <T>(task: Task<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer.');
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/*
 * Process-wide on purpose (ADR-0010 §3): the bound protects this process's memory, so every app instance in it (for
 * example several test apps in one Vitest worker) must share the same two slots.
 */
const withProcessingSlot = createConcurrencyLimit(AVATAR_PROCESSING_SLOTS);

function unsupported(): UnsupportedMediaTypeError {
  return new UnsupportedMediaTypeError(AVATAR_MIME_TYPES);
}

function tooLarge(message: string): ValidationError {
  return new ValidationError([{ location: 'file', path: AVATAR_FIELD, message }], { status: 422 });
}

const TOO_WIDE_OR_TALL = `The image must be at most ${String(AVATAR_MAX_SIDE_PX)} × ${String(AVATAR_MAX_SIDE_PX)} pixels.`;
const TOO_MANY_PIXELS = `The image must have at most ${String(AVATAR_MAX_PIXELS / 1_000_000)} megapixels.`;

async function readHeader(buffer: Buffer): Promise<Metadata> {
  try {
    // Header only, nothing is decoded. No pixel limit here: the checks below must report "too large" with the real
    // dimensions, not "unsupported" because sharp refused to read the header.
    return await sharp(buffer, { limitInputPixels: false }).metadata();
  } catch {
    throw unsupported();
  }
}

/** Decompression-bomb guard before any pixel is decoded: 422 for oversized dimensions (ADR-0010 §3). */
function assertDecodable(metadata: Metadata): void {
  if (!DECODABLE_FORMATS.has(metadata.format)) throw unsupported();
  const width = metadata.width;
  // Animated GIF/WebP: one frame is decoded (`pages: 1`), so the frame's height is what counts.
  const height = metadata.pageHeight ?? metadata.height;
  if (width > AVATAR_MAX_SIDE_PX || height > AVATAR_MAX_SIDE_PX) throw tooLarge(TOO_WIDE_OR_TALL);
  if (width * height > AVATAR_MAX_PIXELS) throw tooLarge(TOO_MANY_PIXELS);
}

async function render(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { limitInputPixels: AVATAR_MAX_PIXELS, failOn: 'error', pages: 1 })
      .autoOrient() // apply the EXIF orientation before the metadata is dropped (same as `.rotate()` without angle)
      .resize(AVATAR_SIZE_PX, AVATAR_SIZE_PX, { fit: 'cover' })
      .webp({ quality: AVATAR_WEBP_QUALITY }) // no `keepMetadata()`: EXIF, GPS, XMP and ICC are not written
      .toBuffer();
  } catch (error) {
    // The pixel limit also covers a header that understated the size; every other decoder error is a broken file.
    if (error instanceof Error && error.message.includes(PIXEL_LIMIT_MESSAGE)) throw tooLarge(TOO_MANY_PIXELS);
    throw unsupported();
  }
}

/**
 * Turns a sniffed upload into the stored avatar (ADR-0010 §3): reads the header, rejects more than
 * `AVATAR_MAX_SIDE_PX` per side or `AVATAR_MAX_PIXELS` in total with 422 `validation-failed` (`location: 'file'`)
 * before decoding, then decodes the first frame under the same pixel limit, orients it by EXIF, crops it to a
 * 512 × 512 square and re-encodes it as WebP without metadata. Undecodable input is 415 `unsupported-media-type`.
 * At most `AVATAR_PROCESSING_SLOTS` calls run at once in the process; further calls wait their turn.
 */
export function processAvatar(buffer: Buffer): Promise<ProcessedAvatar> {
  return withProcessingSlot(async () => {
    assertDecodable(await readHeader(buffer));
    return { buffer: await render(buffer), contentType: AVATAR_CONTENT_TYPE };
  });
}
