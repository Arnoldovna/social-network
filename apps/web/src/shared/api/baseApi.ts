import { createApi } from '@reduxjs/toolkit/query/react';

import { baseQuery } from './baseQuery';
import { invalidResponseError } from './problem';

/**
 * Cache tags (ADR-0012). `Me` the signed-in user; `User` profiles by id; `Friendships` the friends page and every
 * friend button; `Wall` wall pages by owner id; `Chat` the chat history; `Presence` the online list.
 */
export const TAG_TYPES = ['Me', 'User', 'Friendships', 'Wall', 'Chat', 'Presence'] as const;
export type TagType = (typeof TAG_TYPES)[number];

/**
 * The one RTK Query API of the app. It has no endpoints of its own: every feature adds its endpoints with
 * `baseApi.injectEndpoints` in its own `<name>.api.ts`, so parallel feature work never touches this file.
 *
 * Responses are checked against the shared Zod contract with the endpoints' `rawResponseSchema` / `responseSchema`
 * (Zod 4 implements Standard Schema). A response that fails its schema becomes an `invalid-response` error instead
 * of untyped data in the cache.
 */
export const baseApi = createApi({
  reducerPath: 'api',
  baseQuery,
  tagTypes: TAG_TYPES,
  endpoints: () => ({}),
  catchSchemaFailure: () => invalidResponseError(200),
});

/** The store slice `baseApi` owns; selectors of injected endpoints take a state of at least this shape. */
export interface ApiState {
  [baseApi.reducerPath]: ReturnType<typeof baseApi.reducer>;
}
