import { FriendshipChange, FriendshipsResponse } from '@app/shared';
import type { FriendEntry, FriendshipState } from '@app/shared';

import { baseApi } from '../../shared/api/baseApi';
import type { TagType } from '../../shared/api/baseApi';
import type { ApiError } from '../../shared/api/problem';
import { compareByName } from '../../shared/lib/names';
import { getSocket } from '../../shared/realtime/socket';

/** The user a friendship mutation is about (`POST /api/friendships`, `/:userId/accept`, `DELETE /:userId`). */
export interface FriendshipTarget {
  userId: number;
}

type FriendshipTags = (TagType | { type: TagType; id: number })[];

/**
 * Tags to refetch for a change with `userId`: the friends lists (page and navigation badge) and that user's profile,
 * whose `relationship.state` drives the friend button (ADR-0012, B-92).
 */
function tagsFor(userId: number): FriendshipTags {
  return ['Friendships', { type: 'User', id: userId }];
}

/**
 * After a mutation: refetch on success, and also on a 404/409, which mean the friendship changed elsewhere (the other
 * person cancelled, accepted or sent a request first; B-26). Other failures (network, 429, 5xx) leave every cache as it
 * is, so the views keep showing the last confirmed state (F-53).
 */
function invalidatesAfter(_result: unknown, error: ApiError | undefined, { userId }: FriendshipTarget): FriendshipTags {
  if (error === undefined || error.status === 404 || error.status === 409) {
    return tagsFor(userId);
  }
  return [];
}

/** Server order of every list (`userNameOrder()` in the API, mirrored by `compareByName`). */
function compareEntries(a: FriendEntry, b: FriendEntry): number {
  return compareByName(a.user, b.user);
}

function listFor(data: FriendshipsResponse, state: FriendshipState): FriendEntry[] | null {
  switch (state) {
    case 'friends':
      return data.friends;
    case 'pending_incoming':
      return data.incoming;
    case 'pending_outgoing':
      return data.outgoing;
    case 'none':
      return null;
  }
}

/**
 * Applies a confirmed `FriendshipChange` to the cached lists in place (an Immer draft): the person leaves the list they
 * were in and, when the new state has a list and the entry is known, joins it in server order with `since = now`
 * (accepting moves a request to "friends", F-55). A person who was in no list (a request sent from their profile) only
 * appears with the refetch that follows, because the change carries no name or avatar.
 */
export function applyFriendshipChange(data: FriendshipsResponse, change: FriendshipChange, now: string): void {
  let moved: FriendEntry | undefined;
  for (const list of [data.friends, data.incoming, data.outgoing]) {
    const index = list.findIndex((entry) => entry.user.id === change.userId);
    if (index !== -1) {
      [moved] = list.splice(index, 1);
    }
  }
  const target = listFor(data, change.state);
  if (target === null || moved === undefined) {
    return;
  }
  const entry: FriendEntry = { user: moved.user, since: now };
  const position = target.findIndex((other) => compareEntries(other, entry) > 0);
  target.splice(position === -1 ? target.length : position, 0, entry);
}

/** The friends lists of the signed-in user (F-54): one cache for the page, the badge and every list action (B-92). */
const friendshipsQueryApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getFriendships: build.query<FriendshipsResponse, undefined>({
      query: () => '/friendships',
      responseSchema: FriendshipsResponse,
      providesTags: ['Friendships'],
      /**
       * `friendship:changed` reaches both people after every mutation, in every tab (API.md §3). The lists and that
       * person's profile are refetched, so a new request shows up in the badge and on `/friends` without a reload
       * (F-52, F-57, B-92). Listening only while the entry is in use (B-86); the header's badge keeps it in use for the
       * whole signed-in session.
       *
       * The handler is attached at once, not after the first response: it never patches the cache, it only
       * invalidates tags, so an event that arrives while the first `GET /api/friendships` is in flight is safe to
       * handle. RTK Query delays that invalidation until the request settled and then refetches, so a request sent
       * after the server built the first answer still reaches the badge instead of being dropped.
       */
      async onCacheEntryAdded(_arg, { cacheEntryRemoved, dispatch }) {
        const socket = getSocket();
        const handleChange = (payload: unknown) => {
          const change = FriendshipChange.safeParse(payload);
          dispatch(baseApi.util.invalidateTags(change.success ? tagsFor(change.data.userId) : ['Friendships']));
        };
        socket.on('friendship:changed', handleChange);
        await cacheEntryRemoved;
        socket.off('friendship:changed', handleChange);
      },
    }),
  }),
});

/**
 * Applies the server's answer to the cached lists as soon as it arrives, so an accepted request moves to "friends"
 * and the badge count drops without waiting for the refetch (F-55). Nothing changes before the server confirmed it
 * (no optimistic "accepted", B-26).
 */
async function applyConfirmedChange(
  dispatch: (action: ReturnType<typeof friendshipsQueryApi.util.updateQueryData>) => unknown,
  queryFulfilled: Promise<{ data: FriendshipChange }>,
): Promise<void> {
  let change: FriendshipChange;
  try {
    ({ data: change } = await queryFulfilled);
  } catch {
    // The caller shows the error; `invalidatesAfter` decides whether to refetch.
    return;
  }
  const now = new Date().toISOString();
  dispatch(
    friendshipsQueryApi.util.updateQueryData('getFriendships', undefined, (draft) => {
      applyFriendshipChange(draft, change, now);
    }),
  );
}

/**
 * Friendship endpoints (API.md "Friendships"). Every mutation answers with a `FriendshipChange` from the actor's point
 * of view; the CSRF header and problem+json parsing come from the shared base query.
 */
export const friendsApi = friendshipsQueryApi.injectEndpoints({
  endpoints: (build) => ({
    /** `POST /api/friendships` → `pending_outgoing` (F-46). */
    sendFriendRequest: build.mutation<FriendshipChange, FriendshipTarget>({
      query: ({ userId }) => ({ url: '/friendships', method: 'POST', body: { userId } }),
      responseSchema: FriendshipChange,
      invalidatesTags: invalidatesAfter,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => applyConfirmedChange(dispatch, queryFulfilled),
    }),
    /** `POST /api/friendships/:userId/accept` → `friends` (F-48); 404 when there is no such request (B-26). */
    acceptFriendRequest: build.mutation<FriendshipChange, FriendshipTarget>({
      query: ({ userId }) => ({ url: `/friendships/${String(userId)}/accept`, method: 'POST' }),
      responseSchema: FriendshipChange,
      invalidatesTags: invalidatesAfter,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => applyConfirmedChange(dispatch, queryFulfilled),
    }),
    /** `DELETE /api/friendships/:userId` → `none`: cancel (F-47), decline (F-49) or unfriend (F-50). */
    removeFriendship: build.mutation<FriendshipChange, FriendshipTarget>({
      query: ({ userId }) => ({ url: `/friendships/${String(userId)}`, method: 'DELETE' }),
      responseSchema: FriendshipChange,
      invalidatesTags: invalidatesAfter,
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) => applyConfirmedChange(dispatch, queryFulfilled),
    }),
  }),
});

export const {
  useGetFriendshipsQuery,
  useSendFriendRequestMutation,
  useAcceptFriendRequestMutation,
  useRemoveFriendshipMutation,
} = friendsApi;
