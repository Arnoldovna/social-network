import { MeResponse, UserProfileResponse } from '@app/shared';
import type { UpdateMeBody } from '@app/shared';

import { baseApi } from '../../shared/api/baseApi';
import { meApi } from '../../shared/api/me.api';

/**
 * Profiles (OVERVIEW §7, ADR-0012).
 *
 * - `getUser(id)`: `GET /api/users/:id` (F-40, F-43), cached per id under `{ type: 'User', id }`, so switching from one
 *   profile to another never shows the previous user (B-91). Friendship mutations and `friendship:changed` invalidate
 *   that tag, which refetches the relationship that drives the friend button and the wall flags.
 * - `updateMe(body)`: `PATCH /api/me` (F-28, F-29). The server's `MeResponse` is written into the `getMe` cache as is
 *   (the envelope `me.api.ts` documents), so the header, the own profile and every own-message check show the new bio
 *   without a second request. It also invalidates the user's own `User` entry.
 *
 * Both responses are checked against the strict shared schemas; an extra field (email, timestamps) becomes an
 * `invalid-response` error instead of cached data (F-43, B-19).
 */
export const profileApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getUser: build.query<UserProfileResponse, number>({
      query: (id) => `/users/${String(id)}`,
      responseSchema: UserProfileResponse,
      providesTags: (_result, _error, id) => [{ type: 'User', id }],
    }),

    updateMe: build.mutation<MeResponse, UpdateMeBody>({
      query: (body) => ({ url: '/me', method: 'PATCH', body }),
      responseSchema: MeResponse,
      invalidatesTags: (result) => (result === undefined ? [] : [{ type: 'User', id: result.user.id }]),
      async onQueryStarted(_body, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          await dispatch(meApi.util.upsertQueryData('getMe', undefined, data));
        } catch {
          // A failed save leaves the cache untouched; the editor shows the error from the mutation result (F-31).
        }
      },
    }),
  }),
});

export const { useGetUserQuery, useUpdateMeMutation } = profileApi;
