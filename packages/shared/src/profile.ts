import { z } from 'zod';

import { intParam } from './ids.js';
import { Bio, Me, UserSummary } from './user.js';

export const SEARCH_QUERY_MAX = 100;
export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 20;

/** `PATCH /api/me`: `null` or an empty/blank string clears the bio (F-29). */
export const UpdateMeBody = z.object({ bio: Bio.nullable() });
export type UpdateMeBody = z.infer<typeof UpdateMeBody>;

/** `GET /api/me`, `PATCH /api/me`, `PUT /api/me/avatar` (the new `avatarUrl`, B-62). */
export const MeResponse = z.strictObject({ user: Me });
export type MeResponse = z.infer<typeof MeResponse>;

/** `GET /api/users/search` (F-59–F-64). The query is trimmed before the length check (F-60). */
export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
  limit: intParam(1, SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchResponse = z.strictObject({ items: z.array(UserSummary) });
export type SearchResponse = z.infer<typeof SearchResponse>;
