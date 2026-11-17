import type { Me } from '@app/shared';
import { configureStore } from '@reduxjs/toolkit';
import type { Middleware, UnknownAction } from '@reduxjs/toolkit';

import { realtimeSlice } from '../../realtime/realtimeSlice';
import { baseApi } from '../baseApi';
import { meApi } from '../me.api';

/** The signed-in demo user as `GET /api/me` returns it (seed data, F-115). */
export const MIRA: Me = {
  id: 1,
  firstName: 'Mira',
  lastName: 'Novak',
  avatarUrl: '/api/users/1/avatar?v=6f1c2a4e-9b7d-4f3a-8e21-5c0d9a7b3e10',
  bio: 'Ceramics on weekends, maps during the week.',
};

/**
 * A store shaped like the app's (`app/store.ts` is not part of `shared/`): the API slice and the realtime slice, plus
 * a middleware that records every dispatched action so tests can count `session/expired`.
 */
export function createTestStore() {
  const actions: UnknownAction[] = [];
  const recorder: Middleware = () => (next) => (action) => {
    actions.push(action as UnknownAction);
    return next(action);
  };
  const store = configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
      [realtimeSlice.reducerPath]: realtimeSlice.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware, recorder),
  });
  const actionsOfType = (type: string) => actions.filter((action) => action.type === type);
  return { store, actions, actionsOfType };
}

/** What login/register do with the user they receive (ADR-0012): write it into the `getMe` cache. */
export async function signInAs(store: ReturnType<typeof createTestStore>['store'], user: Me = MIRA): Promise<void> {
  const result = await store.dispatch(meApi.util.upsertQueryData('getMe', undefined, { user }));
  if (result.error !== undefined) {
    throw new Error(`signInAs: the getMe cache rejected the user (${JSON.stringify(result.error)})`);
  }
}
