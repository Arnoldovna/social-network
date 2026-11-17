/** Largest accepted avatar file: 2 MB (FEATURES Appendix C, ADR-0002). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Allowed types, decided by magic bytes on the server, never by the client's `Content-Type` (ADR-0010). */
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

/** The single multipart field of `PUT /api/me/avatar`. */
export const AVATAR_FIELD = 'avatar';

/** Decompression-bomb guards, checked from the image header before decoding (ADR-0010). */
export const AVATAR_MAX_SIDE_PX = 8192;
export const AVATAR_MAX_PIXELS = 25_000_000;
