// Request and response schemas of the wall feature. The contract lives in `packages/shared` (API.md §1, ADR-0003), so
// server validation, the web app's forms and the integration tests use the same definitions; this file only gives the
// feature one local import point. No server-only schema is needed: the cursor is decoded by
// `shared/pagination/cursor.ts`.
export {
  CreatePostBody,
  CreatePostResponse,
  IdParams,
  PageQuery,
  POST_MAX,
  WallPage,
  WallPost,
  WallRoomPayload,
} from '@app/shared';
