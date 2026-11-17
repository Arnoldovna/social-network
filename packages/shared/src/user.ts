import { z } from 'zod';

/** Upper bound of the bio after trimming (F-29). The web app's live counter uses the same constant. */
export const BIO_MAX = 1000;
export const NAME_MAX = 100;
export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/**
 * The public shape of a user wherever another user is shown (author, friend, search hit, presence).
 * Every response DTO is a `z.strictObject` at every nesting level, so an extra field such as `email` fails
 * `Schema.parse()` in the integration tests anywhere in the tree (B-19, F-43, F-90).
 */
export const UserSummary = z.strictObject({
  id: z.number().int().positive(),
  firstName: z.string(),
  lastName: z.string(),
  /** `/api/users/<id>/avatar?v=<uuid>` or `null` (ADR-0010). */
  avatarUrl: z.string().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;

/** `.extend()` keeps the strictness of `UserSummary` (proven by dto-strictness.test.ts). */
export const PublicUser = UserSummary.extend({ bio: z.string().nullable() });
export type PublicUser = z.infer<typeof PublicUser>;

/** The signed-in user: the public fields only, no email and no timestamps (F-21). */
export const Me = PublicUser;
export type Me = PublicUser;

// F-07: required, trimmed, 1–100 characters.
export const FirstName = z.string().trim().min(1, 'Please enter your first name.').max(NAME_MAX);
export const LastName = z.string().trim().min(1, 'Please enter your last name.').max(NAME_MAX);

/** F-08: trimmed and lower-cased before the format check; no TLD length rule, `+` addressing allowed. */
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX)
  .pipe(z.email('Please enter a valid email address.'));

/** F-09 as amended by ADR-0002/ADR-0006: 12–256 characters, no composition rules, never trimmed. */
export const Password = z.string().min(PASSWORD_MIN, 'Use at least 12 characters.').max(PASSWORD_MAX);

/** F-29: trimmed, at most 1,000 characters; an empty bio is stored as `null`. */
export const Bio = z
  .string()
  .trim()
  .max(BIO_MAX, 'Keep your bio under 1,000 characters.')
  .transform((value) => (value === '' ? null : value));
