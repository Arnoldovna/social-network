import { CreatePostResponse, Id, PAGE_LIMIT_DEFAULT, WallPage, WallPost } from '@app/shared';
import type { Ack, CreatePostBody } from '@app/shared';
import type { InfiniteData } from '@reduxjs/toolkit/query/react';
import { z } from 'zod';

import { baseApi } from '../../shared/api/baseApi';
import { hasErrorCode } from '../../shared/api/problem';
import { isLoaded, newestFirstIndex } from '../../shared/lib/newest-first';
import { bufferUntilLoaded } from '../../shared/realtime/buffer-until-loaded';
import { getSocket } from '../../shared/realtime/socket';

/** The cursor of the next older page (`WallPage.nextCursor`); `null` asks for the newest page (ADR-0014). */
export type WallPageParam = string | null;

/** A wall as cached: the loaded pages, newest first, and the cursor each one was requested with. */
export type WallPages = InfiniteData<WallPage, WallPageParam>;

/** `wall:post-deleted` payload (API.md §3); the shared contract types it but has no schema of its own. */
const PostDeletedPayload = z.object({ id: Id, wallOwnerId: Id });

export interface CreatePostArgs extends CreatePostBody {
  ownerId: number;
}

export interface DeletePostArgs {
  id: number;
  /** The wall the post is on, so the right cache entry loses it (B-91). */
  ownerId: number;
}

/**
 * Puts a post that just arrived (own `POST` answer or `wall:post-created`) into its place on the first page. A post
 * that is already loaded is left alone, so the author's own post, which arrives both as the response and as the
 * room event, appears once (B-41). A post older than the whole first page while older pages exist is not inserted:
 * "load older posts" brings it in its place, and inserting it here would duplicate it then.
 */
function insertPost(data: WallPages, post: WallPost): void {
  const [firstPage] = data.pages;
  if (firstPage === undefined || isLoaded(data.pages, post.id)) {
    return;
  }
  const index = newestFirstIndex(firstPage.items, post);
  const olderThanFirstPage = index === firstPage.items.length;
  if (olderThanFirstPage && (data.pages.length > 1 || firstPage.nextCursor !== null)) {
    return;
  }
  firstPage.items.splice(index, 0, post);
}

/** Removes a post from whichever loaded page holds it (F-72, ADR-0014); an unknown id changes nothing. */
function removePost(data: WallPages, id: number): void {
  for (const page of data.pages) {
    const index = page.items.findIndex((item) => item.id === id);
    if (index !== -1) {
      page.items.splice(index, 1);
    }
  }
}

/** Every loaded post, newest first, each id once (React keys stay unique whatever the cache went through). */
export function wallPostsOf(data: WallPages | undefined): WallPost[] {
  if (data === undefined) {
    return [];
  }
  const seen = new Set<number>();
  return data.pages.flatMap((page) =>
    page.items.filter((post) => {
      if (seen.has(post.id)) {
        return false;
      }
      seen.add(post.id);
      return true;
    }),
  );
}

type WallEvent = { kind: 'created'; post: WallPost } | { kind: 'deleted'; id: number };

/** Acks of `wall:join`/`wall:leave` need no handling: a refused join only means no live updates for a lost friend. */
const ignoreAck = (_ack: Ack): void => undefined;

/**
 * The wall feature's endpoints (OVERVIEW §7, ADR-0012). The cache is keyed by the wall owner's id, so every wall has
 * its own entry and switching profiles never shows the previous wall's posts (B-91).
 */
export const wallApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    /**
     * `GET /api/users/:id/posts` as an infinite query: newest first, 20 per page, the server's `nextCursor` as the
     * next page param, "load older posts" fetches the next one (F-70, ADR-0014). A refetch (the realtime listener's
     * resync after a reconnect, the avatar upload's `Wall` invalidation) reloads every loaded page from the newest.
     *
     * While the entry lives, the socket keeps it current (F-72, ADR-0008): the entry joins the wall's room
     * (`wall:join`, permission-checked by the server, B-39) whenever the socket connects, applies
     * `wall:post-created`/`wall:post-deleted` for this wall only (B-40) and leaves the room when the entry is removed.
     * Events reach the cache only after the first page is in it (B-86); events that arrive while that request is in
     * flight are replayed in order afterwards, which is always safe because inserts and removals are idempotent.
     * Payloads are parsed with the shared schemas first, so nothing outside the contract reaches the cache.
     *
     * `keepUnusedDataFor: 0`: the entry, and with it the room membership, ends as soon as no wall shows it
     * (ADR-0008 "`wall:leave` on unmount"); opening the wall again loads it fresh.
     */
    getWallPosts: build.infiniteQuery<WallPage, number, WallPageParam>({
      query: ({ queryArg: ownerId, pageParam }) => ({
        url: `/users/${String(ownerId)}/posts`,
        params: pageParam === null ? { limit: PAGE_LIMIT_DEFAULT } : { limit: PAGE_LIMIT_DEFAULT, cursor: pageParam },
      }),
      responseSchema: WallPage,
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
      providesTags: (_result, _error, ownerId) => [{ type: 'Wall', id: ownerId }],
      keepUnusedDataFor: 0,
      async onCacheEntryAdded(ownerId, lifecycle) {
        const { cacheDataLoaded, cacheEntryRemoved } = lifecycle;
        const socket = getSocket();
        const room = { userId: ownerId };
        const events = bufferUntilLoaded<WallEvent>((event) => {
          lifecycle.updateCachedData((draft) => {
            if (event.kind === 'created') {
              insertPost(draft, event.post);
            } else {
              removePost(draft, event.id);
            }
          });
        });
        const onCreated = (payload: unknown): void => {
          const parsed = WallPost.safeParse(payload);
          if (parsed.success && parsed.data.wallOwnerId === ownerId) {
            events.push({ kind: 'created', post: parsed.data });
          }
        };
        const onDeleted = (payload: unknown): void => {
          const parsed = PostDeletedPayload.safeParse(payload);
          if (parsed.success && parsed.data.wallOwnerId === ownerId) {
            events.push({ kind: 'deleted', id: parsed.data.id });
          }
        };
        // Rooms do not survive a reconnect, so the entry joins again on every `connect` (OVERVIEW §7).
        const join = (): void => {
          socket.emit('wall:join', room, ignoreAck);
        };

        socket.on('wall:post-created', onCreated);
        socket.on('wall:post-deleted', onDeleted);
        socket.on('connect', join);
        if (socket.connected) {
          join();
        }

        try {
          await cacheDataLoaded;
          events.flush();
        } catch {
          // The entry was removed before its first page arrived; the cleanup below still runs.
        }

        await cacheEntryRemoved;
        socket.off('wall:post-created', onCreated);
        socket.off('wall:post-deleted', onDeleted);
        socket.off('connect', join);
        if (socket.connected) {
          socket.emit('wall:leave', room, ignoreAck);
        }
      },
    }),

    /**
     * `POST /api/users/:id/posts` (F-66, F-67). The answer is the stored post with its real id and author (B-41); it
     * goes into that wall's cache, never optimistically (ADR-0012). The room event for the same post is de-duplicated
     * by id.
     */
    createPost: build.mutation<CreatePostResponse, CreatePostArgs>({
      query: ({ ownerId, body }) => ({ url: `/users/${String(ownerId)}/posts`, method: 'POST', body: { body } }),
      responseSchema: CreatePostResponse,
      async onQueryStarted({ ownerId }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(
            wallApi.util.updateQueryData('getWallPosts', ownerId, (draft) => {
              insertPost(draft, data.post);
            }),
          );
        } catch {
          // The component shows the error; the cache stays as it was (F-53).
        }
      },
    }),

    /**
     * `DELETE /api/posts/:id` (F-71): 204, then the post leaves that wall's cache. A 404 `post-not-found` means it is
     * already gone (deleted in another tab or by the other permitted person), so it leaves the cache as well.
     */
    deletePost: build.mutation<null, DeletePostArgs>({
      query: ({ id }) => ({ url: `/posts/${String(id)}`, method: 'DELETE' }),
      async onQueryStarted({ id, ownerId }, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
        } catch (failure: unknown) {
          const error = typeof failure === 'object' && failure !== null && 'error' in failure ? failure.error : null;
          if (!hasErrorCode(error, 'post-not-found')) {
            return;
          }
        }
        dispatch(
          wallApi.util.updateQueryData('getWallPosts', ownerId, (draft) => {
            removePost(draft, id);
          }),
        );
      },
    }),
  }),
});

export const { useGetWallPostsInfiniteQuery, useCreatePostMutation, useDeletePostMutation } = wallApi;
