import { AuthResponse } from '@app/shared';
import type { LoginBody, Me, RegisterBody } from '@app/shared';
import type { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';
import type { BaseQueryApi, FetchArgs, FetchBaseQueryMeta, QueryReturnValue } from '@reduxjs/toolkit/query/react';

import { baseApi } from '../../shared/api/baseApi';
import type { ApiState } from '../../shared/api/baseApi';
import { setCsrfToken } from '../../shared/api/csrf';
import { meApi } from '../../shared/api/me.api';
import { bodyFieldErrors, errorMessage, invalidResponseError, isApiError } from '../../shared/api/problem';
import type { ApiError } from '../../shared/api/problem';

type AuthBaseQueryResult = QueryReturnValue<unknown, ApiError, FetchBaseQueryMeta>;
type AuthBaseQuery = (args: string | FetchArgs) => AuthBaseQueryResult | PromiseLike<AuthBaseQueryResult>;

/**
 * Register and login share their success path (API.md §2, ADR-0012):
 * 1. the response is checked against the strict `AuthResponse` contract;
 * 2. its CSRF token replaces the in-memory one, because the server regenerated the session and the old token was
 *    bound to the old session id (F-18, F-23);
 * 3. the user is written into the `getMe` cache as the `MeResponse` envelope, which signs the client in: the loaders
 *    let it into the app and the realtime listener connects the socket.
 *
 * The mutation resolves only after step 3, so the caller can navigate to `/` right away and the app guard answers from
 * the cache instead of asking `GET /api/me` again. The result is the user alone: the token never enters the Redux
 * state (and with it the devtools), it lives in `shared/api/csrf.ts` only.
 *
 * Once step 2 ran, the server session exists, so the sign-in has succeeded whatever happens to the cache. Should the
 * cache refuse the user (a contract drift that `MeResponse` rejects), the entry simply stays without data and the app
 * guard reads `GET /api/me` itself after the navigation: the app then shows its own error page with "try again",
 * instead of a login form that claims a failure while a valid session cookie is already set.
 */
async function signIn(
  args: FetchArgs,
  api: BaseQueryApi,
  baseQuery: AuthBaseQuery,
): Promise<QueryReturnValue<Me, ApiError, FetchBaseQueryMeta>> {
  const result = await baseQuery(args);
  if (result.error !== undefined) {
    return { error: result.error };
  }
  const parsed = AuthResponse.safeParse(result.data);
  if (!parsed.success) {
    return { error: invalidResponseError(result.meta?.response?.status ?? 200) };
  }
  const { user, csrfToken } = parsed.data;
  setCsrfToken(csrfToken);
  // RTK Query types the queryFn's dispatch loosely (`any` state); the store always holds `baseApi` (ApiState).
  const dispatch = api.dispatch as ThunkDispatch<ApiState, unknown, UnknownAction>;
  await dispatch(meApi.util.upsertQueryData('getMe', undefined, { user }));
  return { data: user };
}

/**
 * `/api/auth/*` (API.md §2). Every request is a `POST`, so the base query adds `x-csrf-token` (fetched lazily from
 * `GET /api/csrf-token` for a visitor) and retries a `csrf-invalid` once. A 401 from these paths never dispatches
 * `sessionExpired` (the base query treats `/auth/*` as a session probe).
 */
export const authApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /** F-06: creates the account and signs it in (201 `AuthResponse`). */
    register: build.mutation<Me, RegisterBody>({
      queryFn: (body, api, _extraOptions, baseQuery) =>
        signIn({ url: '/auth/register', method: 'POST', body }, api, baseQuery),
    }),

    /** F-14: signs in with email and password (200 `AuthResponse`). */
    login: build.mutation<Me, LoginBody>({
      queryFn: (body, api, _extraOptions, baseQuery) =>
        signIn({ url: '/auth/login', method: 'POST', body }, api, baseQuery),
    }),

    /**
     * F-20: destroys the server session, clears the cookie and disconnects the session's sockets (204, empty body).
     * The local clean-up (socket, CSRF token, API state, navigation) belongs to `LogoutButton`, which knows the order.
     */
    logout: build.mutation<null, undefined>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
    }),
  }),
});

export const { useRegisterMutation, useLoginMutation, useLogoutMutation } = authApi;

/** Where a failed register or login puts its message: next to a field (F-10, F-11) or above the submit button. */
export interface AuthFormErrors<Field extends string> {
  fields: Partial<Record<Field, string>>;
  form: string | null;
}

/**
 * Maps a failed register/login onto the form (F-10, F-11, F-15):
 * - 409 `email-taken` goes next to the email field with the F-10 sentence (not the server's detail);
 * - 422 field errors go next to the fields they name; issues on fields the form does not have become the form message;
 * - everything else (401 wrong credentials, 429, network, 5xx) is one form-level sentence from `problem.ts`.
 */
export function authFormErrors<Field extends string>(
  error: unknown,
  fieldNames: readonly Field[],
): AuthFormErrors<Field> {
  if (!isApiError(error)) {
    return { fields: {}, form: errorMessage(error) };
  }
  const fields: Partial<Record<Field, string>> = {};
  const emailField = fieldNames.find((name) => name === 'email');
  if (error.code === 'email-taken' && emailField !== undefined) {
    fields[emailField] = error.message;
    return { fields, form: null };
  }
  if (error.code === 'validation-failed') {
    for (const [path, message] of Object.entries(bodyFieldErrors(error))) {
      const field = fieldNames.find((name) => name === path);
      if (field !== undefined) {
        fields[field] = message;
      }
    }
    if (Object.keys(fields).length > 0) {
      return { fields, form: null };
    }
  }
  return { fields: {}, form: error.message };
}
