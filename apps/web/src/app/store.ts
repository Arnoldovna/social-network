import { addListener, combineReducers, configureStore, createListenerMiddleware } from '@reduxjs/toolkit';

import { baseApi } from '../shared/api/baseApi';
import { realtimeSlice } from '../shared/realtime/realtimeSlice';

/**
 * The app's state (ADR-0012): the RTK Query cache of `baseApi` (every server answer, keyed by arguments) and the
 * `realtime` slice (socket connection status, the only plain client slice). Nothing else is global.
 */
const rootReducer = combineReducers({
  [baseApi.reducerPath]: baseApi.reducer,
  [realtimeSlice.reducerPath]: realtimeSlice.reducer,
});

export type RootState = ReturnType<typeof rootReducer>;

/**
 * Creates the store with the listener middleware the session and realtime listeners register on
 * (`startSessionListener`, `startRealtimeListener`). A factory, so every test gets a fresh store with its own
 * listeners; `main.tsx` creates the one store of the tab.
 *
 * This module imports neither the router nor the loaders (ADR-0012, B-101): navigation reaches the session listener
 * as a parameter, so `store → listener → router → loaders → store` can never form an import cycle.
 */
export function createAppStore(preloadedState?: Partial<RootState>) {
  const listenerMiddleware = createListenerMiddleware();
  return configureStore({
    reducer: rootReducer,
    ...(preloadedState === undefined ? {} : { preloadedState }),
    // The listener middleware goes first, so effects see every action, including the API's own thunks.
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(listenerMiddleware.middleware).concat(baseApi.middleware),
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
export type AppDispatch = AppStore['dispatch'];

/**
 * `store.dispatch(addAppListener({ … }))` registers a typed listener on the store's listener middleware and returns
 * its unsubscribe function (RTK's `addListener` action, so listeners need no module-level middleware instance).
 */
export const addAppListener = addListener.withTypes<RootState, AppDispatch>();
