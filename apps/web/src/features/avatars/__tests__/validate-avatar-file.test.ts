import { AVATAR_MAX_BYTES, AVATAR_MAX_PIXELS, AVATAR_MAX_SIDE_PX, AVATAR_MIME_TYPES } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { invalidResponseError, networkError, toApiError } from '../../../shared/api/problem';
import {
  AVATAR_ACCEPT,
  AVATAR_FILE_HINT,
  AVATAR_FILE_MESSAGES,
  uploadErrorMessage,
  validateAvatarDimensions,
  validateAvatarFile,
} from '../validate-avatar-file';

/** Only `size` and `type` are read, so no real bytes are needed for the size boundaries. */
function fileLike(type: string, size: number): Pick<File, 'size' | 'type'> {
  return { type, size };
}

describe('validateAvatarFile (F-36, F-38)', () => {
  it.each(AVATAR_MIME_TYPES)('accepts %s up to exactly 2 MB', (type) => {
    expect(validateAvatarFile(fileLike(type, 1))).toEqual({ ok: true });
    expect(validateAvatarFile(fileLike(type, AVATAR_MAX_BYTES))).toEqual({ ok: true });
  });

  it('refuses a file one byte over 2 MB with the F-38 sentence', () => {
    expect(validateAvatarFile(fileLike('image/png', AVATAR_MAX_BYTES + 1))).toEqual({
      ok: false,
      problem: 'tooLarge',
      message: 'The image must be 2 MB or smaller.',
    });
  });

  it.each(['image/svg+xml', 'image/heic', 'application/pdf', 'text/html', ''])(
    'refuses the type "%s" with the F-38 sentence',
    (type) => {
      expect(validateAvatarFile(fileLike(type, 1024))).toEqual({
        ok: false,
        problem: 'unsupportedType',
        message: 'Please choose a JPEG, PNG, WebP or GIF image.',
      });
    },
  );

  it('names the type before the size when both are wrong', () => {
    expect(validateAvatarFile(fileLike('application/pdf', AVATAR_MAX_BYTES * 3))).toMatchObject({
      problem: 'unsupportedType',
    });
  });

  it('refuses an empty file (the server would answer file-required, B-33)', () => {
    expect(validateAvatarFile(fileLike('image/png', 0))).toEqual({
      ok: false,
      problem: 'empty',
      message: AVATAR_FILE_MESSAGES.empty,
    });
  });

  it('works on a real File', () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'me.png', { type: 'image/png' });

    expect(validateAvatarFile(file)).toEqual({ ok: true });
  });
});

describe('validateAvatarDimensions (ADR-0010 pixel guard)', () => {
  it('accepts up to 8192 px per side within 25 megapixels', () => {
    expect(validateAvatarDimensions(1, 1)).toEqual({ ok: true });
    expect(validateAvatarDimensions(AVATAR_MAX_SIDE_PX, 3000)).toEqual({ ok: true });
    expect(validateAvatarDimensions(5000, 5000)).toEqual({ ok: true });
  });

  it.each([
    [AVATAR_MAX_SIDE_PX + 1, 1],
    [1, AVATAR_MAX_SIDE_PX + 1],
    [5000, 5001],
    [16000, 16000],
  ])('refuses %i × %i px', (width, height) => {
    expect(validateAvatarDimensions(width, height)).toEqual({
      ok: false,
      problem: 'tooManyPixels',
      message: 'The image must be at most 8192 × 8192 pixels.',
    });
  });

  it('uses the shared total limit', () => {
    expect(AVATAR_MAX_PIXELS).toBe(25_000_000);
    expect(validateAvatarDimensions(5000, AVATAR_MAX_PIXELS / 5000)).toEqual({ ok: true });
  });
});

describe('uploadErrorMessage (F-38, B-97)', () => {
  it('gives the server file errors the same sentences as the browser checks', () => {
    expect(uploadErrorMessage(toApiError(415, undefined))).toBe(AVATAR_FILE_MESSAGES.unsupportedType);
    expect(uploadErrorMessage(toApiError(413, undefined))).toBe(AVATAR_FILE_MESSAGES.tooLarge);
    expect(uploadErrorMessage(toApiError(422, undefined))).toBe(AVATAR_FILE_MESSAGES.tooManyPixels);
    expect(uploadErrorMessage(toApiError(400, { type: 'x', title: 'x', status: 400 }))).toBe(
      'This request could not be processed. Reload the page and try again.',
    );
  });

  it('uses the app-wide sentence for everything else', () => {
    expect(uploadErrorMessage(networkError())).toBe(
      'The server could not be reached. Check your connection and try again.',
    );
    expect(uploadErrorMessage(toApiError(429, undefined))).toBe('Too many requests. Wait a moment and try again.');
    expect(uploadErrorMessage(toApiError(500, undefined))).toBe('Something went wrong on our side. Please try again.');
    expect(uploadErrorMessage(invalidResponseError(200))).toBe(
      'The server sent an unexpected answer. Please try again.',
    );
  });

  it('never shows a thrown bug verbatim', () => {
    expect(uploadErrorMessage({ name: 'TypeError', message: 'x is undefined' })).toBe(
      'Something went wrong on our side. Please try again.',
    );
  });
});

describe('copy from the shared limits', () => {
  it('accepts exactly the four types in the file picker', () => {
    expect(AVATAR_ACCEPT).toBe('image/jpeg,image/png,image/webp,image/gif');
  });

  it('states the limits in the hint', () => {
    expect(AVATAR_FILE_HINT).toBe('JPEG, PNG, WebP or GIF, up to 2 MB. It is cropped to a square.');
  });
});
