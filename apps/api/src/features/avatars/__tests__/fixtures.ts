import { crc32, deflateSync } from 'node:zlib';

import sharp from 'sharp';

/**
 * Upload fixtures, generated at runtime instead of committed binaries (ADR-0010 "Consequences"): real images in every
 * allowed format, a JPEG with EXIF, HTML disguised as a PNG, an oversized body and a decompression-bomb header.
 */

/** A solid-colour image of `width × height` as a sharp pipeline, ready for any output format. */
function solid(width: number, height: number, background = '#c0392b') {
  return sharp({ create: { width, height, channels: 3, background } });
}

export const jpegImage = (width = 640, height = 480): Promise<Buffer> => solid(width, height).jpeg().toBuffer();
export const pngImage = (width = 300, height = 200): Promise<Buffer> => solid(width, height).png().toBuffer();
export const webpImage = (width = 256, height = 256): Promise<Buffer> => solid(width, height).webp().toBuffer();
export const gifImage = (width = 64, height = 64): Promise<Buffer> => solid(width, height).gif().toBuffer();

/** Recognisable EXIF text that must never survive the re-encode (B-30, Appendix C "strip EXIF/GPS"). */
export const EXIF_MARKER = 'avatar-test-exif-marker';

/** A JPEG carrying an EXIF `IFD0` block with `EXIF_MARKER` as copyright and artist. */
export const jpegWithExif = (): Promise<Buffer> =>
  solid(400, 300)
    .withExif({ IFD0: { Copyright: EXIF_MARKER, Artist: EXIF_MARKER } })
    .jpeg()
    .toBuffer();

/** The legacy stored-XSS payload (B-30): an HTML page uploaded as `x.png` with `Content-Type: image/png`. */
export const htmlDisguisedAsPng = (): Buffer =>
  Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>\n', 'utf8');

/**
 * `bytes` of data starting with the PNG signature, so only the size limit can reject it (multer stops it while
 * streaming, before anything is sniffed). Default 3 MB, above the 2 MB `AVATAR_MAX_BYTES` and below nginx's 3 MB cap.
 */
export function oversizedFile(bytes = 3 * 1024 * 1024): Buffer {
  const file = Buffer.alloc(bytes, 0x5a);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(file);
  return file;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A tiny, well-formed PNG (valid CRCs) whose IHDR declares `width × height` 8-bit RGB pixels but whose IDAT holds no
 * rows: a decompression bomb in a few dozen bytes. Only its header may ever be read (ADR-0010 §3).
 */
export function headerOnlyPng(width = 16_000, height = 16_000): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(0))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** `avatars/<userId>/<uuid>.webp`, the only key shape the server ever stores (B-30, DATA-MODEL). */
export const avatarKeyPattern = (userId: number): RegExp =>
  new RegExp(`^avatars/${String(userId)}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$`);

/** `/api/users/<userId>/avatar?v=<uuid>` (ADR-0010 §8). */
export const avatarUrlPattern = (userId: number): RegExp =>
  new RegExp(`^/api/users/${String(userId)}/avatar\\?v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
