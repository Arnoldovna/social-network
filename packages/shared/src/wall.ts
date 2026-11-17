import { z } from 'zod';

import { pageOf } from './pagination.js';
import { UserSummary } from './user.js';

/** Upper bound of a post after trimming (F-67). */
export const POST_MAX = 2000;

/** A post as the API and `wall:post-created` deliver it; `id` is the real row id (B-41). */
export const WallPost = z.strictObject({
  id: z.number().int().positive(),
  wallOwnerId: z.number().int().positive(),
  author: UserSummary,
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type WallPost = z.infer<typeof WallPost>;

/** `GET /api/users/:id/posts`, newest first (F-70). */
export const WallPage = pageOf(WallPost);
export type WallPage = z.infer<typeof WallPage>;

/** `POST /api/users/:id/posts`: 1–2,000 characters after trimming (F-67). */
export const CreatePostBody = z.object({
  body: z.string().trim().min(1, 'Write something first.').max(POST_MAX),
});
export type CreatePostBody = z.infer<typeof CreatePostBody>;

export const CreatePostResponse = z.strictObject({ post: WallPost });
export type CreatePostResponse = z.infer<typeof CreatePostResponse>;
