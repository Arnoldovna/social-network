import type { FriendshipState } from '@app/shared';
import { useParams, useSearchParams } from 'react-router';

/*
 * Trivial stand-ins for every feature's public `index.ts` (BUILD-ORDER rule 7). App-shell tests `vi.mock` the feature
 * indexes with these, so they keep testing the shell (routing, guards, header, listeners) when the Phase 3 units swap
 * their stubs for real components with their own network calls:
 *
 *   vi.mock('../../features/auth', async () => (await import('./fakes')).authFeature);
 *
 * The names and props mirror BUILD-ORDER "Web feature exports fixed in Phase 1c".
 */

/** The F-22 sentence, as the real `LoginPage` shows it for `?reason=expired`. */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';

function StandInPage({ title }: { title: string }) {
  return (
    <>
      <title>{`${title} · Let's chat!`}</title>
      <h1>{title}</h1>
    </>
  );
}

function LoginPage() {
  const [searchParams] = useSearchParams();
  return (
    <>
      <StandInPage title="Log in" />
      {searchParams.get('reason') === 'expired' ? <p role="alert">{SESSION_EXPIRED_MESSAGE}</p> : null}
    </>
  );
}

function UserProfilePage() {
  const { id = '' } = useParams();
  return <StandInPage title={`User ${id}`} />;
}

export const authFeature = {
  RegisterPage: () => <StandInPage title="Sign up" />,
  LoginPage,
  AboutPage: () => <StandInPage title="About" />,
  BrandPanel: () => <p>A small social network for profiles, friends, walls and chat.</p>,
  LogoutButton: () => <button type="button">log out</button>,
};

export const profileFeature = {
  OwnProfilePage: () => <StandInPage title="Profile" />,
  UserProfilePage,
};

export const avatarsFeature = {
  AvatarButton: ({ variant }: { variant: 'header' | 'profile' }) => (
    <button type="button" data-variant={variant}>
      change profile picture
    </button>
  ),
};

export const friendsFeature = {
  FriendsPage: () => <StandInPage title="Friends" />,
  FriendButton: (_props: { userId: number; userName: string; state: FriendshipState }) => null,
  FriendsNavBadge: () => <span>2 new requests</span>,
};

export const searchFeature = {
  HeaderSearch: () => (
    <label>
      find people <input type="search" />
    </label>
  ),
};

export const wallFeature = {
  Wall: (_props: { ownerId: number; ownerFirstName: string; canView: boolean; canPost: boolean }) => null,
};

export const chatFeature = {
  ChatPage: () => <StandInPage title="Chat" />,
};

export const presenceFeature = {
  OnlinePage: () => <StandInPage title="Online" />,
};
