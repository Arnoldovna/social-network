import { z } from 'zod';

import { Id } from './ids.js';
import { PublicUser, UserSummary } from './user.js';

/** State, not UI labels (B-53): the web app maps it to button text. Always from the receiver's point of view. */
export const FriendshipState = z.enum(['none', 'pending_outgoing', 'pending_incoming', 'friends']);
export type FriendshipState = z.infer<typeof FriendshipState>;

/** `self` only appears on the profile endpoint for the viewer's own id (F-41). */
export const RelationshipState = z.union([FriendshipState, z.literal('self')]);
export type RelationshipState = z.infer<typeof RelationshipState>;

/** `GET /api/users/:id` (F-40, F-43, F-45). */
export const UserProfileResponse = z.strictObject({
  user: PublicUser,
  relationship: z.strictObject({
    state: RelationshipState,
    canViewWall: z.boolean(),
    canPostOnWall: z.boolean(),
  }),
});
export type UserProfileResponse = z.infer<typeof UserProfileResponse>;

export const FriendEntry = z.strictObject({ user: UserSummary, since: z.iso.datetime() });
export type FriendEntry = z.infer<typeof FriendEntry>;

/** `GET /api/friendships` (F-54). */
export const FriendshipsResponse = z.strictObject({
  friends: z.array(FriendEntry),
  incoming: z.array(FriendEntry),
  outgoing: z.array(FriendEntry),
});
export type FriendshipsResponse = z.infer<typeof FriendshipsResponse>;

/** `POST /api/friendships`: the id must be a JSON number (no coercion). */
export const SendFriendRequestBody = z.object({ userId: Id });
export type SendFriendRequestBody = z.infer<typeof SendFriendRequestBody>;

/** Response of every friendship mutation and payload of `friendship:changed` (F-52, F-57). */
export const FriendshipChange = z.strictObject({ userId: z.number().int().positive(), state: FriendshipState });
export type FriendshipChange = z.infer<typeof FriendshipChange>;
