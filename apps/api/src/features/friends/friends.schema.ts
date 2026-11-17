// Request schemas and response DTOs of the friends feature. The contract lives in `packages/shared`
// (`friendships.ts`, `ids.ts`; ADR-0003), so the web app, the API and the tests parse the very same schemas; this file
// only re-exports what the friends routes use, so the controller has one local import.
export {
  FriendEntry,
  FriendshipChange,
  FriendshipsResponse,
  FriendshipState,
  SendFriendRequestBody,
  UserIdParams,
} from '@app/shared';
