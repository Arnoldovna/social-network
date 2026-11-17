import { crc32, deflateSync } from 'node:zlib';

import { AVATAR_FIELD, AVATAR_MAX_PIXELS, AVATAR_MAX_SIDE_PX } from '@app/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { type AppError, UnsupportedMediaTypeError, ValidationError } from '../../errors/app-error.js';
import {
  AVATAR_CONTENT_TYPE,
  AVATAR_PROCESSING_SLOTS,
  AVATAR_SIZE_PX,
  createConcurrencyLimit,
  processAvatar,
} from '../process-image.js';

// --- fixtures, generated at runtime (ADR-0010: no committed binaries) -------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A tiny, well-formed PNG whose IHDR declares `width × height` (8-bit RGB) but whose IDAT holds no pixel rows. The
 * header is all `metadata()` reads; decoding it would allocate `width × height × 3` bytes before failing.
 */
function headerOnlyPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(0))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function solid(width: number, height: number, background: string) {
  return sharp({ create: { width, height, channels: 3, background } });
}

/** 200 × 100: red left half, blue right half. */
async function splitImage() {
  const blueHalf = await solid(100, 100, '#0000ff').png().toBuffer();
  return solid(200, 100, '#ff0000').composite([{ input: blueHalf, left: 100, top: 0 }]);
}

async function pixel(webp: Buffer, x: number, y: number) {
  const { data, info } = await sharp(webp).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset] ?? -1, g: data[offset + 1] ?? -1, b: data[offset + 2] ?? -1 };
}

const isRed = ({ r, g, b }: { r: number; g: number; b: number }) => r > 200 && g < 60 && b < 60;
const isBlue = ({ r, g, b }: { r: number; g: number; b: number }) => r < 60 && g < 60 && b > 200;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

async function expectTooLarge(buffer: Buffer, message: string) {
  const error = await rejection(processAvatar(buffer));
  expect(error).toBeInstanceOf(ValidationError);
  const appError = error as AppError;
  expect(appError.status).toBe(422);
  expect(appError.code).toBe('validation-failed');
  expect(appError.extensions['errors']).toEqual([{ location: 'file', path: AVATAR_FIELD, message }]);
}

async function expectUnsupported(buffer: Buffer) {
  const error = await rejection(processAvatar(buffer));
  expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
  expect((error as AppError).status).toBe(415);
  expect((error as AppError).code).toBe('unsupported-media-type');
}

const SIDE_MESSAGE = 'The image must be at most 8192 × 8192 pixels.';
const PIXELS_MESSAGE = 'The image must have at most 25 megapixels.';

// --- tests ---------------------------------------------------------------------------------------------------------------

describe('processAvatar: output (FEATURES Appendix C, ADR-0010 §3)', () => {
  it.each([
    ['JPEG', () => solid(800, 600, '#336699').jpeg().toBuffer()],
    ['PNG', () => solid(300, 900, '#336699').png().toBuffer()],
    ['WebP', () => solid(64, 64, '#336699').webp().toBuffer()],
    ['GIF', () => solid(40, 20, '#336699').gif().toBuffer()],
  ])('re-encodes a %s to a 512 × 512 WebP', async (_format, make) => {
    const result = await processAvatar(await make());

    expect(result.contentType).toBe(AVATAR_CONTENT_TYPE);
    const meta = await sharp(result.buffer).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: AVATAR_SIZE_PX, height: AVATAR_SIZE_PX });
  });

  it('applies the EXIF orientation, then strips EXIF (incl. GPS) and ICC metadata', async () => {
    // Orientation 6 = displayed rotated 90° clockwise: the red left half ends up on top.
    const input = await (
      await splitImage()
    )
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Copyright: 'someone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 8/1 0/1' } },
      })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const { buffer } = await processAvatar(input);

    const meta = await sharp(buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(isRed(await pixel(buffer, 256, 40))).toBe(true);
    expect(isBlue(await pixel(buffer, 256, 470))).toBe(true);
  });

  it('crops to a centred square (fit: cover) instead of letterboxing', async () => {
    // Without orientation the halves stay side by side: red on the left, blue on the right, no border.
    const { buffer } = await processAvatar(await (await splitImage()).png().toBuffer());

    expect(isRed(await pixel(buffer, 20, 256))).toBe(true);
    expect(isBlue(await pixel(buffer, 490, 256))).toBe(true);
    expect(isRed(await pixel(buffer, 20, 2))).toBe(true);
  });

  it('keeps only the first frame of an animated GIF', async () => {
    const frames = await Promise.all(
      ['#ff0000', '#0000ff', '#00ff00'].map((colour) => solid(100, 80, colour).png().toBuffer()),
    );
    const animated = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(3);

    const { buffer } = await processAvatar(animated);

    const meta = await sharp(buffer).metadata();
    expect(meta.pages ?? 1).toBe(1);
    expect(meta).toMatchObject({ width: AVATAR_SIZE_PX, height: AVATAR_SIZE_PX });
    expect(isRed(await pixel(buffer, 256, 256))).toBe(true);
  });
});

describe('processAvatar: decompression-bomb guard (ADR-0010 §3)', () => {
  it('rejects a 65-byte PNG declaring 16000 × 16000 px with 422 from the header, without decoding it', async () => {
    const bomb = headerOnlyPng(16_000, 16_000);
    expect(bomb.length).toBeLessThan(100);
    expect(await sharp(bomb, { limitInputPixels: false }).metadata()).toMatchObject({ width: 16_000, height: 16_000 });
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();

    // The side-length message proves the header check answered; the decoder's pixel limit would report megapixels.
    await expectTooLarge(bomb, SIDE_MESSAGE);

    // A decode would need 16000 × 16000 × 3 bytes = 768 MB; the header check needs next to nothing.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(64 * 1024 * 1024);
  });

  it.each([
    [AVATAR_MAX_SIDE_PX + 1, 10],
    [10, AVATAR_MAX_SIDE_PX + 1],
  ])('rejects %i × %i px (one side over 8192) with 422', async (width, height) => {
    await expectTooLarge(headerOnlyPng(width, height), SIDE_MESSAGE);
  });

  it('rejects more than 25 Mpx with 422 even when both sides are within 8192 px', async () => {
    const height = Math.floor(AVATAR_MAX_PIXELS / AVATAR_MAX_SIDE_PX) + 1; // 8192 × 3052 = 25 001 984 px
    await expectTooLarge(headerOnlyPng(AVATAR_MAX_SIDE_PX, height), PIXELS_MESSAGE);
  });

  it('lets exactly-in-bounds dimensions through to the decoder (8192 × 3051 px, 8192 px side)', async () => {
    const height = Math.floor(AVATAR_MAX_PIXELS / AVATAR_MAX_SIDE_PX); // 8192 × 3051 = 24 993 792 px
    // The header passes; the empty pixel data then fails in the decoder, which is 415, not 422.
    await expectUnsupported(headerOnlyPng(AVATAR_MAX_SIDE_PX, height));
  });
});

describe('processAvatar: undecodable input is 415', () => {
  it('rejects bytes that are no image at all', async () => {
    await expectUnsupported(Buffer.from('<!doctype html><script>alert(1)</script>'));
  });

  it('rejects a PNG whose pixel data is corrupt (failOn: error)', async () => {
    const valid = await solid(64, 64, '#336699').png().toBuffer();
    const corrupt = Buffer.concat([valid.subarray(0, 60), Buffer.alloc(40, 0xff), valid.subarray(100)]);
    await expectUnsupported(corrupt);
  });

  it.each([
    ['SVG', () => Promise.resolve(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))],
    ['TIFF', () => solid(10, 10, '#336699').tiff().toBuffer()],
    ['AVIF', () => solid(10, 10, '#336699').avif().toBuffer()],
  ])('refuses %s even though libvips could decode it', async (_format, make) => {
    await expectUnsupported(await make());
  });
});

describe('processAvatar: process-wide limits (ADR-0010 §3)', () => {
  it('runs libvips without its operation cache and with one thread per image', () => {
    expect(sharp.concurrency()).toBe(1);
    const cache = sharp.cache();
    expect(cache.memory.max).toBe(0);
    expect(cache.files.max).toBe(0);
    expect(cache.items.max).toBe(0);
  });

  it('allows two concurrent jobs and completes every queued call', async () => {
    expect(AVATAR_PROCESSING_SLOTS).toBe(2);
    const input = await solid(120, 90, '#336699').png().toBuffer();

    const results = await Promise.all(Array.from({ length: 6 }, () => processAvatar(input)));

    expect(results).toHaveLength(6);
    for (const result of results) expect(result.contentType).toBe(AVATAR_CONTENT_TYPE);
  });

  it('frees the slot of a failed job', async () => {
    const bad = Buffer.from('not an image');
    await Promise.all(Array.from({ length: 4 }, () => expectUnsupported(bad)));

    const result = await processAvatar(await solid(10, 10, '#336699').png().toBuffer());
    expect(result.contentType).toBe(AVATAR_CONTENT_TYPE);
  });
});

describe('createConcurrencyLimit', () => {
  interface Gate {
    promise: Promise<void>;
    open(): void;
    fail(error: Error): void;
  }
  function gate(): Gate {
    let open!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    return { promise, open, fail };
  }
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('never runs more than `max` tasks at once and starts waiters in arrival order', async () => {
    const limit = createConcurrencyLimit(2);
    const gates = Array.from({ length: 5 }, gate);
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    const all = Promise.all(
      gates.map((g, index) =>
        limit(async () => {
          started.push(index);
          running++;
          peak = Math.max(peak, running);
          await g.promise;
          running--;
          return index;
        }),
      ),
    );
    await flush();
    expect(started).toEqual([0, 1]);

    gates[1]?.open();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    for (const g of gates) g.open();
    expect(await all).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('hands the slot of a rejected task to the next waiter and passes the rejection on', async () => {
    const limit = createConcurrencyLimit(1);
    const first = gate();
    const failing = limit(() => first.promise);
    const next = limit(() => Promise.resolve('next'));

    first.fail(new Error('boom'));

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
  });

  it('does not let a newcomer overtake the queue when a slot is handed over', async () => {
    const limit = createConcurrencyLimit(1);
    const first = gate();
    const order: string[] = [];
    const a = limit(async () => {
      await first.promise;
      order.push('a');
    });
    const b = limit(() => {
      order.push('b');
      return Promise.resolve();
    });

    first.open();
    await a;
    const c = limit(() => {
      order.push('c');
      return Promise.resolve();
    });
    await Promise.all([b, c]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects max = %s', (max) => {
    expect(() => createConcurrencyLimit(max)).toThrow(RangeError);
  });
});
