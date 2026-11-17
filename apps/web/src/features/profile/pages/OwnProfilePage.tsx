import { useGetMeQuery } from '../../../shared/api/me.api';
import { fullName } from '../../../shared/lib/names';
import { AvatarButton } from '../../avatars';
import { Wall } from '../../wall';
import { BioEditor } from '../components/BioEditor';
import { ProfileFallback } from '../components/ProfileFallback';
import { ProfileHeader } from '../components/ProfileHeader';
import './OwnProfilePage.css';

/**
 * `/`: the signed-in user's profile (F-24): the avatar as the "Change profile picture" button (F-33), the full name,
 * the bio editor (F-26–F-32) and the own wall (F-65). The user comes from the `getMe` cache the app loader filled
 * (ADR-0013), so it normally renders at once; it subscribes to that entry, so a saved bio or a new avatar shows up
 * immediately (F-37). While the entry is (re)loading it shows "loading profile…" and on an error "try again", never a
 * blank page (F-25, B-82).
 */
export function OwnProfilePage() {
  const { data, error, isError, isFetching, refetch } = useGetMeQuery(undefined);
  const me = data?.user;

  if (me === undefined) {
    return (
      <div className="own-profile-page">
        <title>Profile · Let's chat!</title>
        <ProfileFallback
          isError={isError}
          error={error}
          errorTitle="Your profile could not be loaded."
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      </div>
    );
  }

  return (
    <div className="own-profile-page">
      <title>{`${fullName(me)} · Let's chat!`}</title>
      <ProfileHeader firstName={me.firstName} lastName={me.lastName} avatar={<AvatarButton variant="profile" />}>
        <BioEditor bio={me.bio} />
      </ProfileHeader>
      <div className="own-profile-page__wall">
        <Wall ownerId={me.id} ownerFirstName={me.firstName} canView canPost />
      </div>
    </div>
  );
}
