import { AVATAR_FIELD, MeResponse } from '@app/shared';
import type { FetchBaseQueryMeta, QueryReturnValue } from '@reduxjs/toolkit/query/react';

import { baseApi } from '../../shared/api/baseApi';
import type { TagType } from '../../shared/api/baseApi';
import { CSRF_HEADER, reportUnauthorized, sendWithCsrfToken } from '../../shared/api/baseQuery';
import { meApi } from '../../shared/api/me.api';
import { invalidResponseError, networkError, toApiError } from '../../shared/api/problem';
import type { ApiError } from '../../shared/api/problem';

/** `PUT /api/me/avatar` (API.md "Avatar upload and media"), same origin like every `/api` call. */
export const AVATAR_UPLOAD_URL = '/api/me/avatar';

/** 2 MB on a slow uplink takes longer than the 30 s of ordinary requests; a hung upload still ends (B-51). */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The filename sent with the multipart part. The server ignores it and generates the object key (Appendix C), so the
 * user's local filename (which can carry a real name or a date) never leaves the browser.
 */
const UPLOAD_FILENAME = 'avatar';

/**
 * Everything that shows a user's picture (F-37, ADR-0010 §9). After an upload the new `Me` is written into the cache
 * directly; these tags make every other list refetch, so each entry rendered afterwards carries the new `?v=`.
 */
const LISTS_WITH_AVATARS = ['Chat', 'Wall', 'Friendships', 'Presence'] as const satisfies readonly TagType[];

export interface UploadAvatarArgs {
  /** The chosen image, already checked by `validateAvatarFile`; sent as the single `avatar` part. */
  file: Blob;
  /**
   * Share of the request body sent so far, `0` to `1`, for the progress bar (F-35). Called only when the browser knows
   * the total, and with `1` once the body is sent (the server then still re-encodes the image).
   */
  onProgress?: (fraction: number) => void;
}

/** How one XHR ended, before it is mapped onto the endpoint's result. */
type UploadOutcome =
  | { kind: 'response'; status: number; body: unknown; headers: Pick<Headers, 'get'> }
  | { kind: 'network' }
  | { kind: 'aborted'; bodySent: boolean };

function parseJsonBody(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // An HTML error page (nginx 413/502): `toApiError` derives the code from the status alone (ADR-0010 §11).
    return undefined;
  }
}

/**
 * One `PUT` as `XMLHttpRequest`, the only browser API with upload progress (ADR-0012). The promise never rejects: it
 * settles with what happened. Same-origin XHR sends the session cookie like `credentials: 'same-origin'`.
 */
function putAvatar(
  file: Blob,
  csrfToken: string,
  signal: AbortSignal,
  onProgress: ((fraction: number) => void) | undefined,
): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: 'aborted', bodySent: false });
      return;
    }

    const xhr = new XMLHttpRequest();
    let bodySent = false;
    const abort = () => {
      xhr.abort();
    };
    const settle = (outcome: UploadOutcome) => {
      signal.removeEventListener('abort', abort);
      resolve(outcome);
    };

    xhr.open('PUT', AVATAR_UPLOAD_URL);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader('accept', 'application/json, application/problem+json');
    xhr.setRequestHeader(CSRF_HEADER, csrfToken);

    // Upload listeners must exist before `send()`, or the browser skips the upload events.
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(event.loaded / event.total, 1));
      }
    });
    xhr.upload.addEventListener('load', () => {
      bodySent = true;
      onProgress?.(1);
    });

    xhr.addEventListener('load', () => {
      settle({
        kind: 'response',
        status: xhr.status,
        body: parseJsonBody(xhr.responseText),
        headers: { get: (name) => xhr.getResponseHeader(name) },
      });
    });
    xhr.addEventListener('error', () => {
      settle({ kind: 'network' });
    });
    xhr.addEventListener('timeout', () => {
      settle({ kind: 'network' });
    });
    xhr.addEventListener('abort', () => {
      settle({ kind: 'aborted', bodySent });
    });
    signal.addEventListener('abort', abort, { once: true });

    const body = new FormData();
    body.append(AVATAR_FIELD, file, UPLOAD_FILENAME);
    xhr.send(body);
  });
}

/** The server refused the token (403 `csrf-invalid`): the base query's helper retries once with a fresh one. */
function isCsrfRejection(outcome: UploadOutcome): boolean {
  return (
    outcome.kind === 'response' &&
    outcome.status === 403 &&
    toApiError(outcome.status, outcome.body, outcome.headers).code === 'csrf-invalid'
  );
}

/**
 * The upload endpoint (ADR-0012 "Avatar upload", OVERVIEW §7). `fetchBaseQuery` has no upload progress, so the request
 * is an XHR, but it keeps the base query's contract through the base query's own helpers: `x-csrf-token` on the `PUT`
 * and one retry with a fresh token after `csrf-invalid` (`sendWithCsrfToken`), problem+json parsed into `ApiError` (a
 * non-JSON 413 from nginx becomes `file-too-large`), and a 401 signals `sessionExpired` only for a client that was
 * signed in (`reportUnauthorized`). Aborting the mutation (the dialog closing) aborts the XHR.
 *
 * On success the response's `Me` goes into the `getMe` cache as is (the header and the profile re-render at once) and
 * the user's own profile plus every list with avatars is invalidated (F-37).
 */
export const avatarsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    uploadAvatar: build.mutation<MeResponse, UploadAvatarArgs>({
      async queryFn(
        args,
        api,
        extraOptions,
      ): Promise<QueryReturnValue<MeResponse, ApiError, FetchBaseQueryMeta | undefined>> {
        const sent = await sendWithCsrfToken(
          api,
          extraOptions,
          (csrfToken) => putAvatar(args.file, csrfToken, api.signal, args.onProgress),
          isCsrfRejection,
        );
        if (sent.kind === 'token-failed') {
          return { error: sent.error };
        }

        const outcome = sent.result;
        switch (outcome.kind) {
          case 'network':
            return { error: networkError() };
          case 'aborted':
            if (outcome.bodySent) {
              // The server may have saved the picture before the abort reached it: refetch instead of guessing.
              api.dispatch(baseApi.util.invalidateTags(['Me', 'User', ...LISTS_WITH_AVATARS]));
            }
            // RTK Query has already settled an aborted mutation; this value is never shown.
            return { error: networkError() };
          case 'response':
            break;
        }

        const { status, body, headers } = outcome;
        if (status >= 200 && status < 300) {
          const parsed = MeResponse.safeParse(body);
          return parsed.success ? { data: parsed.data } : { error: invalidResponseError(status) };
        }

        const error = toApiError(status, body, headers);
        // `PUT /me/avatar` is an ordinary signed-in request, never a session probe: its 401 is a real expiry.
        reportUnauthorized(api, error);
        return { error };
      },
      invalidatesTags: (result) =>
        result === undefined ? [] : [{ type: 'User', id: result.user.id }, ...LISTS_WITH_AVATARS],
      async onQueryStarted(_args, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          await dispatch(meApi.util.upsertQueryData('getMe', undefined, data));
        } catch {
          // A failed or aborted upload leaves the cached user as it was; the dialog shows the mutation's error.
        }
      },
    }),
  }),
});

export const { useUploadAvatarMutation } = avatarsApi;
