import { Id, PresenceResponse, UserSummary } from '@app/shared';
import { createEntityAdapter } from '@reduxjs/toolkit';
import type { EntityState } from '@reduxjs/toolkit';
import { z } from 'zod';

import { baseApi } from '../../shared/api/baseApi';
import { compareByName } from '../../shared/lib/names';
import { bufferUntilLoaded } from '../../shared/realtime/buffer-until-loaded';
import { getSocket } from '../../shared/realtime/socket';

/** `presence:left` payload (API.md §3); the shared contract types it but has no schema of its own. */
const PresenceLeftPayload = z.object({ userId: Id });

/** The online list as cached: a map keyed by user id, so one person is one entry whatever arrives twice (B-87). */
export type OnlineUsers = EntityState<UserSummary, number>;

/**
 * Sorted in the order of `GET /api/presence` (API.md, F-86), the API's one name order, so a person who joins later is
 * slotted in where a reload would put them.
 */
const onlineUsersAdapter = createEntityAdapter<UserSummary>({ sortComparer: compareByName });

/** `selectAll(onlineUsers)` gives the people in name order. */
export const onlineUsersSelectors = onlineUsersAdapter.getSelectors();

type PresenceEvent = { kind: 'joined'; user: UserSummary } | { kind: 'left'; userId: number };

/**
 * `GET /api/presence` (F-86, F-90), cached under the `Presence` tag. The realtime listener invalidates that tag after
 * a reconnect, and the avatar upload after a new picture (F-37), so both refetch the list over HTTP.
 *
 * While the entry lives, the socket keeps it current (ADR-0012): `presence:joined` upserts a person and
 * `presence:left` removes one, so a second tab, a reload within the grace period or a repeated event never produces a
 * duplicate row (F-87, F-88, B-87). Payloads are checked with the shared schemas first: anything that is not exactly
 * a `UserSummary` (an extra private field, B-19) is dropped instead of reaching the cache.
 *
 * Events are only applied once the first response is in the cache (B-86). Events that arrive while that request is in
 * flight are kept and replayed in order afterwards, so someone who joins during the first load is not missed; a
 * replayed event is never wrong, because joins are upserts and leaves of absent ids are no-ops.
 */
export const presenceApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getOnlineUsers: build.query<OnlineUsers, undefined>({
      query: () => '/presence',
      rawResponseSchema: PresenceResponse,
      transformResponse: (response: PresenceResponse) =>
        onlineUsersAdapter.setAll(onlineUsersAdapter.getInitialState(), response.items),
      providesTags: ['Presence'],
      // `lifecycle` stays an object: RTK Query types `updateCachedData` as a method, so destructuring it trips
      // `unbound-method` although it does not use `this`.
      async onCacheEntryAdded(_arg, lifecycle) {
        const socket = getSocket();
        const events = bufferUntilLoaded<PresenceEvent>((event) => {
          lifecycle.updateCachedData((draft) => {
            if (event.kind === 'joined') {
              onlineUsersAdapter.upsertOne(draft, event.user);
            } else {
              onlineUsersAdapter.removeOne(draft, event.userId);
            }
          });
        });
        const onJoined = (payload: unknown): void => {
          const parsed = UserSummary.safeParse(payload);
          if (parsed.success) {
            events.push({ kind: 'joined', user: parsed.data });
          }
        };
        const onLeft = (payload: unknown): void => {
          const parsed = PresenceLeftPayload.safeParse(payload);
          if (parsed.success) {
            events.push({ kind: 'left', userId: parsed.data.userId });
          }
        };

        socket.on('presence:joined', onJoined);
        socket.on('presence:left', onLeft);
        try {
          await lifecycle.cacheDataLoaded;
          events.flush();
          await lifecycle.cacheEntryRemoved;
        } catch {
          // The entry was removed before its first response arrived (`cacheDataLoaded` rejects then): nothing to do.
        } finally {
          socket.off('presence:joined', onJoined);
          socket.off('presence:left', onLeft);
        }
      },
    }),
  }),
});

export const { useGetOnlineUsersQuery } = presenceApi;
