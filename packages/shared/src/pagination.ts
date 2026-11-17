import { z } from 'zod';

import { intParam } from './ids.js';

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 50;

/** Query of every newest-first keyset list (ADR-0014). The cursor is opaque here; the API decodes and validates it. */
export const PageQuery = z.object({
  limit: intParam(1, PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(200).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** Response envelope of a cursor page. Strict, like every response DTO (B-19). */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
