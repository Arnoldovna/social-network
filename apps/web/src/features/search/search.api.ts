import { SEARCH_LIMIT_DEFAULT, SearchResponse } from '@app/shared';

import { baseApi } from '../../shared/api/baseApi';

/** The arguments of `GET /api/users/search` (API.md, `SearchQuery`): the trimmed query and the result limit. */
export interface SearchUsersArgs {
  /** 1–100 characters after trimming; the caller trims and never asks for an empty query. */
  q: string;
  /** 1–20; the header asks for the API default of 10 (F-61). */
  limit?: number;
}

/**
 * People search over HTTP (F-59–F-64, B-49): a list of `UserSummary` rows checked against the strict shared schema,
 * so a response with an extra field (email) is an `invalid-response` error instead of data in the cache.
 *
 * Results are kept for 30 seconds after the last subscriber leaves (OVERVIEW §7), so typing back to an earlier query
 * ("mir" → "mira" → "mir") answers from the cache. They carry no tags: the current user is never in the list, and
 * another person's new name or picture appears with the next search.
 */
export const searchApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    searchUsers: build.query<SearchResponse, SearchUsersArgs>({
      query: ({ q, limit = SEARCH_LIMIT_DEFAULT }) => ({
        url: '/users/search',
        params: { q, limit: String(limit) },
      }),
      responseSchema: SearchResponse,
      keepUnusedDataFor: 30,
    }),
  }),
});

export const { useSearchUsersQuery } = searchApi;
