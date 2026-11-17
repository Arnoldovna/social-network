import { MeResponse } from '@app/shared';
import type { Me } from '@app/shared';

import { baseApi } from './baseApi';
import type { ApiState } from './baseApi';
import { setAuthenticationGuard } from './baseQuery';

/**
 * The signed-in user (`GET /api/me`, F-21), cached under the `Me` tag. A 401 here means "visitor", never "expired":
 * the loaders read it to decide between the app and `/welcome` (ADR-0013).
 *
 * The cache holds the `MeResponse` envelope `{ user }` exactly as `GET /api/me`, `PATCH /api/me` and
 * `PUT /api/me/avatar` answer it, checked with the strict shared schema. Writers put that shape in:
 * login/register `upsertQueryData('getMe', undefined, { user: response.user })`, `updateMe` and the avatar upload
 * `upsertQueryData('getMe', undefined, response)`. (An unwrapping `transformResponse` is not an option: RTK Query
 * 2.14 runs `rawResponseSchema` on upserted values too, so the login's upsert would fail validation.) Logout and
 * `sessionExpired` reset the whole API state, which empties it.
 */
export const meApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getMe: build.query<MeResponse, undefined>({
      query: () => '/me',
      responseSchema: MeResponse,
      providesTags: ['Me'],
      // The identity of the session, not a view's data: kept until logout or expiry resets the API state, so
      // `selectIsAuthenticated` never flips to false just because no component is subscribed for a minute.
      keepUnusedDataFor: Number.POSITIVE_INFINITY,
    }),
  }),
});

export const { useGetMeQuery } = meApi;

const selectGetMeResult = meApi.endpoints.getMe.select(undefined);

/** The cached signed-in user, or `null` for a visitor (or before `getMe` resolved). */
export function selectCurrentUser(state: ApiState): Me | null {
  return selectGetMeResult(state).data?.user ?? null;
}

/**
 * `true` while the `getMe` cache holds a user (ADR-0012). It guards session expiry: only a client that was signed in
 * when a 401 (or a server-side socket close) arrives is sent to "Your session has expired".
 */
export function selectIsAuthenticated(state: ApiState): boolean {
  return selectCurrentUser(state) !== null;
}

// The store is created with `baseApi.reducer` under `baseApi.reducerPath`, so every state the base query sees has
// the `ApiState` shape; `getState()` is only typed `unknown` by RTK Query.
setAuthenticationGuard((state) => selectIsAuthenticated(state as ApiState));
