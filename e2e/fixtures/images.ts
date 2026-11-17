import { crc32, deflateSync } from 'node:zlib';

/**
 * In-memory upload payloads for the avatar journeys (F-37, F-38; B-29, B-30, B-32, B-33). Nothing is read from disk,
 * nothing is a photo of a person: valid images are solid colour squares without metadata. Every payload has the shape
 * Playwright's `locator.setInputFiles()` and the `multipart` option of `APIRequestContext` accept.
 *
 * Limits mirror `packages/shared/src/uploads.ts` (API.md §1, Appendix C). They are restated here because the root
 * workspace, where e2e lives, does not depend on `@app/shared`; a drift shows up as a failing avatar spec.
 */

export interface UploadFile {
  /** Client-side file name; the API never uses it (B-30), specs vary it to prove that. */
  name: string;
  /** The type the client claims; the API trusts only the magic bytes (B-29). */
  mimeType: string;
  buffer: Buffer;
}

/** `AVATAR_MAX_BYTES`: the API answers larger files with 413 `file-too-large` (B-32). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** `client_max_body_size 3m` in `apps/web/nginx.conf`: nginx itself answers larger bodies with the same problem. */
export const PROXY_MAX_BODY_BYTES = 3 * 1024 * 1024;
/** `AVATAR_MAX_SIDE_PX`: a wider or taller image is 422 `validation-failed` with `location: 'file'`. */
export const AVATAR_MAX_SIDE_PX = 8192;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour RGB
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method 0
  ihdr.writeUInt8(0, 12); // no interlace
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr)]);
}

export interface PngOptions {
  width?: number;
  height?: number;
  /** Fill colour as `[r, g, b]`, 0..255 each. Different colours give different bytes, so specs can tell avatars apart. */
  rgb?: readonly [number, number, number];
}

/** A valid, decodable PNG of one solid colour, encoded here so its size and dimensions are exact. */
export function pngBuffer({ width = 64, height = 64, rgb = [196, 40, 90] }: PngOptions = {}): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`PNG dimensions must be positive integers, got ${String(width)}x${String(height)}`);
  }
  if (rgb.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new RangeError(`PNG colour channels must be integers 0..255, got ${rgb.join(',')}`);
  }
  // Every scanline starts with filter type 0 (None), followed by width RGB triplets.
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const scanlines = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    pngHeader(width, height),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Generated once with sharp 0.35 (the API's decoder) from a 16x16 solid colour
// (`sharp({ create }).toFormat(f).toBuffer()`), so they carry no EXIF/XMP metadata. Re-generate the same way if one
// ever stops decoding; never paste images from elsewhere.
const JPEG_16_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCPACqv/9k=';
const WEBP_16_BASE64 = 'UklGRjIAAABXRUJQVlA4ICYAAABQAQCdASoQABAAAUAmJaAABAAAAP7v/ZP//cHH/9wcf/3Bx+vAAA==';
const GIF_16_BASE64 = 'R0lGODlhEAAQAIAAAExpccQoWiH5BAUAAAAALAAAAAAQABAAAAIOjI+py+0Po5y02ouzPgUAOw==';

/** One valid file per allowed type (`AVATAR_MIME_TYPES`: JPEG, PNG, WebP, GIF). Fresh buffers on every call. */
export function validAvatars(): Record<'png' | 'jpeg' | 'webp' | 'gif', UploadFile> {
  return {
    png: { name: 'avatar.png', mimeType: 'image/png', buffer: pngBuffer() },
    jpeg: { name: 'avatar.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_16_BASE64, 'base64') },
    webp: { name: 'avatar.webp', mimeType: 'image/webp', buffer: Buffer.from(WEBP_16_BASE64, 'base64') },
    gif: { name: 'avatar.gif', mimeType: 'image/gif', buffer: Buffer.from(GIF_16_BASE64, 'base64') },
  };
}

/** A valid PNG avatar; pass a colour to get distinguishable uploads (e.g. replacing an avatar, F-39). */
export function pngAvatar(options: PngOptions = {}, name = 'avatar.png'): UploadFile {
  return { name, mimeType: 'image/png', buffer: pngBuffer(options) };
}

/** HTML with a script, named and typed as a PNG: must be 415 by magic bytes and never stored (B-29, B-30). */
export function htmlDisguisedAsPng(): UploadFile {
  return {
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<!doctype html><title>x</title><script>document.title = "xss"</script>\n', 'utf8'),
  };
}

/** A plain text file declared as text: 415 (not an image at all, F-38). */
export function textFile(): UploadFile {
  return { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image\n', 'utf8') };
}

/** Starts like a PNG (signature + IHDR) but has no image data: passes sniffing, fails decoding, so 415. */
export function truncatedPng(): UploadFile {
  return { name: 'broken.png', mimeType: 'image/png', buffer: pngHeader(64, 64) };
}

/** A PNG one pixel wider than the side limit: decodable and small, but 422 `validation-failed` (ADR-0010). */
export function tooWidePng(): UploadFile {
  return { name: 'wide.png', mimeType: 'image/png', buffer: pngBuffer({ width: AVATAR_MAX_SIDE_PX + 1, height: 1 }) };
}

/** A PNG signature padded with zeros to exactly `bytes`; sized to hit a limit before any decoding happens. */
function paddedPng(bytes: number, name: string): UploadFile {
  const buffer = Buffer.alloc(bytes);
  PNG_SIGNATURE.copy(buffer);
  return { name, mimeType: 'image/png', buffer };
}

/** One byte over `AVATAR_MAX_BYTES` but under the proxy limit: the API's multer answers 413 (B-32). */
export function oversizedForApi(): UploadFile {
  return paddedPng(AVATAR_MAX_BYTES + 1, 'too-large.png');
}

/** Over nginx's `client_max_body_size`: never reaches the API, nginx answers the same 413 problem+json. */
export function oversizedForProxy(): UploadFile {
  return paddedPng(PROXY_MAX_BODY_BYTES + 1024, 'far-too-large.png');
}
