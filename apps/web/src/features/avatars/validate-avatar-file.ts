import { AVATAR_MAX_BYTES, AVATAR_MAX_PIXELS, AVATAR_MAX_SIDE_PX, AVATAR_MIME_TYPES } from '@app/shared';
import type { AvatarMimeType } from '@app/shared';

import { AVATAR_MAX_SIZE_LABEL, errorMessage, isApiError, messageFor } from '../../shared/api/problem';

/*
 * The client-side mirror of the upload rules (F-36, FEATURES Appendix C, ADR-0010). The server stays the authority: it
 * sniffs magic bytes and decodes the header, so these checks only spare the user a 2 MB round trip for a file that
 * cannot pass, and give every rejection the same sentence whether the browser or the API found it (F-38).
 */

/**
 * The user-facing sentences of every way a chosen file can be refused (F-38 fixes the first two). The type and size
 * sentences are the API client's own for 415 and 413 (`problem.ts`), so the browser's refusal and the server's read
 * the same and there is one copy of each.
 */
export const AVATAR_FILE_MESSAGES = {
  unsupportedType: messageFor('unsupported-media-type'),
  tooLarge: messageFor('file-too-large'),
  empty: 'This file is empty. Please choose another image.',
  tooManyPixels: `The image must be at most ${String(AVATAR_MAX_SIDE_PX)} × ${String(AVATAR_MAX_SIDE_PX)} pixels.`,
} as const;

/** One line for the file field's hint, from the same limits. */
export const AVATAR_FILE_HINT = `JPEG, PNG, WebP or GIF, up to ${AVATAR_MAX_SIZE_LABEL}. It is cropped to a square.`;

/** The `accept` attribute of the file input: the allowed types only, so the picker filters before validation. */
export const AVATAR_ACCEPT = AVATAR_MIME_TYPES.join(',');

export type AvatarFileProblem = keyof typeof AVATAR_FILE_MESSAGES;

export type AvatarFileCheck = { ok: true } | { ok: false; problem: AvatarFileProblem; message: string };

const VALID: AvatarFileCheck = { ok: true };

function refuse(problem: AvatarFileProblem): AvatarFileCheck {
  return { ok: false, problem, message: AVATAR_FILE_MESSAGES[problem] };
}

function isAllowedType(type: string): type is AvatarMimeType {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * Checks what the browser knows about a chosen file before anything is uploaded: not empty, an allowed type and at
 * most `AVATAR_MAX_BYTES`. The type is the browser's guess from the extension; an empty or unknown type is refused,
 * because every browser reports the four allowed formats. A renamed file with the wrong bytes passes here and is
 * answered 415 by the server, which `uploadErrorMessage` turns into the same sentence.
 */
export function validateAvatarFile(file: Pick<File, 'size' | 'type'>): AvatarFileCheck {
  if (file.size === 0) {
    return refuse('empty');
  }
  if (!isAllowedType(file.type)) {
    return refuse('unsupportedType');
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return refuse('tooLarge');
  }
  return VALID;
}

/**
 * The server's decompression-bomb guard (ADR-0010), checked on the preview's natural size: at most
 * `AVATAR_MAX_SIDE_PX` per side and `AVATAR_MAX_PIXELS` in total.
 */
export function validateAvatarDimensions(width: number, height: number): AvatarFileCheck {
  const tooWide = width > AVATAR_MAX_SIDE_PX || height > AVATAR_MAX_SIDE_PX;
  return tooWide || width * height > AVATAR_MAX_PIXELS ? refuse('tooManyPixels') : VALID;
}

/**
 * The sentence for a failed `PUT /api/me/avatar` (F-38, B-97). A 415 (a renamed file) and a 413 already carry the
 * client checks' sentences (see `AVATAR_FILE_MESSAGES`). A missing file and a 422 (the pixel guard; API.md: its only
 * field error is `location: 'file'`) get the dialog's own wording. Everything else (network, 429, 500, `csrf-invalid`)
 * uses the app-wide message.
 */
export function uploadErrorMessage(error: unknown): string {
  if (!isApiError(error)) {
    return errorMessage(error);
  }
  switch (error.code) {
    case 'file-required':
      return AVATAR_FILE_MESSAGES.empty;
    case 'validation-failed':
      return AVATAR_FILE_MESSAGES.tooManyPixels;
    default:
      return error.message;
  }
}
