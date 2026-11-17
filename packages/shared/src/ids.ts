import { z } from 'zod';

/** Largest value of a Postgres `integer` (int32) primary key. */
export const ID_MAX = 2_147_483_647;

/**
 * Ids in JSON bodies and socket payloads: a real JSON number, never coerced (`true`, `[7]` and `"7"` are rejected).
 * `z.coerce.number()` would accept all of them, plus `"0x1F"` and `"1e3"` (ADR-0003, F-112).
 */
export const Id = z.number().int().positive().max(ID_MAX);
export type Id = z.infer<typeof Id>;

/**
 * Ids in path params: plain decimal digits without a leading zero, then the same range check as `Id`.
 * `"abc"`, `"0"`, `"07"`, `"1e3"`, `"0x1F"`, `" 7"` and values above int32 are rejected, so the API answers
 * 400 `invalid-request` instead of passing a malformed value to SQL (B-55, F-42).
 */
export const IdParam = z
  .string()
  .regex(/^[1-9]\d{0,9}$/, 'Expected a positive integer id.')
  .transform(Number)
  .pipe(Id);

export const IdParams = z.object({ id: IdParam });
export type IdParams = z.infer<typeof IdParams>;

export const UserIdParams = z.object({ userId: IdParam });
export type UserIdParams = z.infer<typeof UserIdParams>;

/**
 * Small integers in query strings (page and search limits): one to three decimal digits, then a range check.
 * Nothing is coerced, so `"1e1"`, `""`, `"-1"` and `"2.5"` are rejected.
 */
export const intParam = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,3}$/, 'Expected a whole number.')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
