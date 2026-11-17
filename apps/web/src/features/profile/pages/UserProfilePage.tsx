import { IdParam } from '@app/shared';
import { skipToken } from '@reduxjs/toolkit/query/react';
import { Link, Navigate, useParams } from 'react-router';

import { isApiError } from '../../../shared/api/problem';
import type { ApiError } from '../../../shared/api/problem';
import { fullName } from '../../../shared/lib/names';
import { Avatar } from '../../../shared/ui/Avatar';
import { FriendButton } from '../../friends';
import { Wall } from '../../wall';
import { ProfileFallback } from '../components/ProfileFallback';
import { ProfileHeader } from '../components/ProfileHeader';
import { useGetUserQuery } from '../profile.api';
import './UserProfilePage.css';

/**
 * A missing user (404 `user-not-found`) and an id the API rejects (400) look the same to the visitor (F-42, API.md:
 * "This user does not exist." for both).
 */
function isMissingUser(error: unknown): error is ApiError {
  return isApiError(error) && (error.status === 404 || error.status === 400);
}

function UserNotFound() {
  return (
    <div className="user-profile-page">
      <title>User not found · Let's chat!</title>
      <div className="user-profile-page__missing">
        <h1 className="user-profile-page__missing-title">This user does not exist.</h1>
        <p className="user-profile-page__missing-text">The link may be wrong, or the account no longer exists.</p>
        <Link className="user-profile-page__missing-link" to="/">
          <span aria-hidden="true">← </span>back to your profile
        </Link>
      </div>
    </div>
  );
}

/**
 * `/users/:id`: another user's profile (F-40): picture, name, bio ("No bio yet." when empty, B-78), the friend button
 * and the wall with the flags the API computed for this viewer (F-45, F-65, F-66).
 *
 * - An id that is not a positive decimal integer never reaches the API and shows "This user does not exist." (F-42);
 *   so does a 400 or 404 from the API.
 * - The friend button and the wall render only after the profile loaded successfully, so a missing user never gets
 *   either and no posts are requested for it (B-98).
 * - `currentData` is the entry for this id only, so moving to another profile shows "loading profile…" instead of the
 *   previous user (F-44, B-91).
 * - `relationship.state === 'self'` (the own id; the route loader normally redirects first, F-41) goes to `/`.
 */
export function UserProfilePage() {
  const { id: rawId } = useParams();
  const parsedId = IdParam.safeParse(rawId);
  const userId = parsedId.success ? parsedId.data : undefined;
  const { currentData, error, isError, isFetching, refetch } = useGetUserQuery(userId ?? skipToken);

  if (userId === undefined || (isError && isMissingUser(error))) {
    return <UserNotFound />;
  }

  if (currentData === undefined) {
    return (
      <div className="user-profile-page">
        <title>Profile · Let's chat!</title>
        <ProfileFallback
          isError={isError}
          error={error}
          errorTitle="This profile could not be loaded."
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      </div>
    );
  }

  const { user, relationship } = currentData;
  if (relationship.state === 'self') {
    return <Navigate to="/" replace />;
  }

  const name = fullName(user);

  return (
    <div className="user-profile-page">
      <title>{`${name} · Let's chat!`}</title>
      <ProfileHeader
        firstName={user.firstName}
        lastName={user.lastName}
        avatar={<Avatar firstName={user.firstName} lastName={user.lastName} src={user.avatarUrl} size="large" />}
        actions={<FriendButton userId={user.id} userName={name} state={relationship.state} />}
      >
        {user.bio === null ? (
          <p className="user-profile-page__bio user-profile-page__bio--empty">No bio yet.</p>
        ) : (
          <p className="user-profile-page__bio">{user.bio}</p>
        )}
      </ProfileHeader>
      <div className="user-profile-page__wall">
        <Wall
          ownerId={user.id}
          ownerFirstName={user.firstName}
          canView={relationship.canViewWall}
          canPost={relationship.canPostOnWall}
        />
      </div>
    </div>
  );
}
