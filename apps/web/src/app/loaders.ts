import { IdParam } from '@app/shared';
import type { Me } from '@app/shared';
import { redirect } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { meApi } from '../shared/api/me.api';
import { errorMessage, isApiError } from '../shared/api/problem';
import type { AppStore } from './store';

export const WELCOME_PATH = '/welcome';
export const HOME_PATH = '/';

/**
 * The signed-in user, or `null` for a visitor (ADR-0013). `getMe` is deduplicated and cached by RTK Query (the
 * entry is kept until logout or expiry reset the API state), so the parent and child loaders of one navigation share
 * one request and later navigations answer from the cache. A 401 from `GET /api/me` means "visitor" and is handled
 * silently: the base query never turns it into `sessionExpired`, and neither do the loaders. Every other failure
 * (network, 5xx, a response that breaks the contract) is thrown to `RouteErrorPage` as an `Error` whose `cause` is the
 * `ApiError`.
 */
export async function loadCurrentUser(store: AppStore): Promise<Me | null> {
  // `subscribe: false`: a loader is not a component; the entry stays cached without a subscription (keepUnusedDataFor
  // is infinite for `getMe`), so nothing has to be unsubscribed.
  const result = await store.dispatch(meApi.endpoints.getMe.initiate(undefined, { subscribe: false }));
  if (result.isSuccess) {
    return result.data.user;
  }
  const { error } = result;
  if (isApiError(error) && error.status === 401) {
    return null;
  }
  // The `ApiError` travels as the cause, so `RouteErrorPage` can show its user-facing message.
  throw new Error(errorMessage(error, 'The signed-in user could not be loaded.'), { cause: error });
}

/**
 * The route guards of `router.tsx` (ADR-0013), created for one store. They redirect before anything renders, so a
 * protected page never flashes for a visitor (F-01) and the welcome pages never flash for a user (F-02).
 */
export function createLoaders(store: AppStore) {
  return {
    /** App area (`/`, `/users/:id`, `/friends`, `/online`, `/chat`): visitors go to `/welcome`, without a reason. */
    requireUser: async () => {
      const user = await loadCurrentUser(store);
      return user === null ? redirect(WELCOME_PATH) : null;
    },

    /** Welcome area (`/welcome`, `/welcome/login`, `/welcome/about`): a signed-in user goes to `/` (F-02). */
    redirectIfAuthenticated: async () => {
      const user = await loadCurrentUser(store);
      return user === null ? null : redirect(HOME_PATH);
    },

    /**
     * `/users/:id` with the user's own id goes to `/` (F-41). Ids are compared after the same `IdParam` parse the API
     * uses; anything that does not parse renders the profile page, which shows "This user does not exist." (F-42).
     * Loaders of nested routes run in parallel, so this one reads `getMe` itself (deduplicated) instead of relying on
     * the parent guard having finished.
     */
    redirectIfOwnProfile: async ({ params }: LoaderFunctionArgs) => {
      const user = await loadCurrentUser(store);
      if (user === null) {
        return redirect(WELCOME_PATH);
      }
      const id = IdParam.safeParse(params['id']);
      return id.success && id.data === user.id ? redirect(HOME_PATH) : null;
    },
  };
}
