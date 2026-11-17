// Request and response schemas of the users feature. They are the shared API contract (packages/shared, ADR-0003);
// this file only re-exports what the users routes use, so the controller has one local import.
export {
  IdParams,
  Me,
  MeResponse,
  PublicUser,
  SearchQuery,
  SearchResponse,
  UpdateMeBody,
  UserProfileResponse,
  UserSummary,
} from '@app/shared';
export type { RelationshipState } from '@app/shared';
