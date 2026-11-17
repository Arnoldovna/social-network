import type { FriendshipState, UserProfileResponse } from '@app/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA, signInAs } from '../../../shared/api/__tests__/fixtures';
import { apiUrl, HttpResponse, http, problemResponse, server } from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { UserProfilePage } from '../pages/UserProfilePage';

// Rule 7: the profile composes the wall, the friend button and (on the own profile) the avatar button; trivial
// stand-ins keep these tests independent of the sibling units and their network calls. They expose their props.
vi.mock('../../wall', () => ({
  Wall: (props: { ownerId: number; ownerFirstName: string; canView: boolean; canPost: boolean }) => (
    <section
      aria-label="wall stand-in"
      data-owner-id={props.ownerId}
      data-owner-first-name={props.ownerFirstName}
      data-can-view={String(props.canView)}
      data-can-post={String(props.canPost)}
    />
  ),
}));
vi.mock('../../friends', () => ({
  FriendButton: (props: { userId: number; userName: string; state: FriendshipState }) => (
    <button type="button" data-user-id={props.userId} data-state={props.state}>
      {`friend button for ${props.userName}`}
    </button>
  ),
}));
vi.mock('../../avatars', () => ({
  AvatarButton: () => (
    <button type="button" data-variant="profile">
      Change profile picture
    </button>
  ),
}));

/** Seeded neighbours of the demo user (F-115). */
const JONAS: UserProfileResponse = {
  user: {
    id: 7,
    firstName: 'Jonas',
    lastName: 'Albrecht',
    avatarUrl: '/api/users/7/avatar?v=0b6d3f2a-4c1e-4a8b-9f57-2e3d1c0a9b84',
    bio: 'Night trains, film cameras\nand far too many houseplants.',
  },
  relationship: { state: 'friends', canViewWall: true, canPostOnWall: true },
};

const ELIF: UserProfileResponse = {
  user: { id: 8, firstName: 'Elif', lastName: 'Kaya', avatarUrl: null, bio: null },
  relationship: { state: 'none', canViewWall: false, canPostOnWall: false },
};

/** Holds a mocked response back until the test calls `release()`, to look at the pending state. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<true>();
  return {
    promise,
    release: () => {
      resolve(true);
    },
  };
}

/** Answers `GET /api/users/:id` from `profiles`, 404 `user-not-found` otherwise; counts the requests per id. */
function profileHandler(profiles: UserProfileResponse[], requests: string[] = []) {
  return http.get(apiUrl('/users/:id'), ({ params }) => {
    const id = String(params['id']);
    requests.push(id);
    const profile = profiles.find((entry) => String(entry.user.id) === id);
    return profile === undefined ? problemResponse(404, 'user-not-found') : HttpResponse.json(profile);
  });
}

async function renderProfile(path: string) {
  const { store } = createTestStore();
  await signInAs(store, MIRA);
  return renderWithProviders(<UserProfilePage />, {
    store,
    path: '/users/:id',
    initialEntries: [path],
    routes: [{ path: '/', element: <h1>Own profile stand-in</h1> }],
  });
}

describe('UserProfilePage (F-40–F-44)', () => {
  it('F-40, B-78: shows the other user’s avatar, name as the only h1, bio, friend button and wall', async () => {
    server.use(profileHandler([JONAS]));
    await renderProfile('/users/7');

    expect(await screen.findByRole('heading', { level: 1, name: 'Jonas Albrecht' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('img', { name: "Jonas Albrecht's profile picture" })).toHaveAttribute(
      'src',
      JONAS.user.avatarUrl,
    );
    const bio = screen.getByText(
      (_content, element) => element?.tagName === 'P' && element.textContent === JONAS.user.bio,
    );
    expect(bio).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change profile picture' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bio/ })).not.toBeInTheDocument();

    const friendButton = screen.getByRole('button', { name: 'friend button for Jonas Albrecht' });
    expect(friendButton).toHaveAttribute('data-user-id', '7');
    expect(friendButton).toHaveAttribute('data-state', 'friends');

    const wall = screen.getByRole('region', { name: 'wall stand-in' });
    expect(wall).toHaveAttribute('data-owner-id', '7');
    expect(wall).toHaveAttribute('data-owner-first-name', 'Jonas');
    expect(wall).toHaveAttribute('data-can-view', 'true');
    expect(wall).toHaveAttribute('data-can-post', 'true');
    expect(document.title).toBe("Jonas Albrecht · Let's chat!");
  });

  it('F-40: says "No bio yet." for an empty bio and passes the wall flags the API computed', async () => {
    server.use(profileHandler([ELIF]));
    await renderProfile('/users/8');

    expect(await screen.findByText('No bio yet.')).toBeInTheDocument();
    // No picture: the initials field, still named for assistive technology.
    expect(screen.getByRole('img', { name: "Elif Kaya's profile picture" })).toHaveTextContent('EK');
    expect(screen.getByRole('button', { name: 'friend button for Elif Kaya' })).toHaveAttribute('data-state', 'none');
    const wall = screen.getByRole('region', { name: 'wall stand-in' });
    expect(wall).toHaveAttribute('data-can-view', 'false');
    expect(wall).toHaveAttribute('data-can-post', 'false');
  });

  it('F-32: renders the bio as plain text, never as HTML', async () => {
    const bio = '<script>alert(1)</script><b>bold</b>';
    server.use(profileHandler([{ ...JONAS, user: { ...JONAS.user, bio } }]));
    await renderProfile('/users/7');

    const text = await screen.findByText(bio);
    expect(text.querySelector('script, b')).toBeNull();
  });

  it('F-44, B-98: shows "loading profile…" and neither friend button nor wall until the profile arrived', async () => {
    const { promise, release } = gate();
    server.use(
      http.get(apiUrl('/users/:id'), async () => {
        await promise;
        return HttpResponse.json(JONAS);
      }),
    );
    await renderProfile('/users/7');

    expect(await screen.findByRole('status')).toHaveTextContent('loading profile…');
    expect(screen.queryByRole('button', { name: /friend button/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'wall stand-in' })).not.toBeInTheDocument();

    release();
    expect(await screen.findByRole('heading', { level: 1, name: 'Jonas Albrecht' })).toBeInTheDocument();
  });

  it('F-42, B-98: a 404 shows "This user does not exist." without friend button or wall', async () => {
    server.use(profileHandler([]));
    await renderProfile('/users/999');

    expect(await screen.findByRole('heading', { level: 1, name: 'This user does not exist.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'back to your profile' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: /friend button/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'wall stand-in' })).not.toBeInTheDocument();
    expect(document.title).toBe("User not found · Let's chat!");
  });

  it('F-42: a 400 from the API is shown the same way', async () => {
    server.use(http.get(apiUrl('/users/:id'), () => problemResponse(400, 'invalid-request')));
    await renderProfile('/users/2147483647');

    expect(await screen.findByRole('heading', { level: 1, name: 'This user does not exist.' })).toBeInTheDocument();
  });

  it.each(['abc', '0', '07', '1e3', '-4', '2147483648'])(
    'F-42: the id "%s" shows "This user does not exist." without asking the API',
    async (id) => {
      // No handler: any request would fail the test (onUnhandledFrame: 'error').
      await renderProfile(`/users/${id}`);

      expect(screen.getByRole('heading', { level: 1, name: 'This user does not exist.' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'wall stand-in' })).not.toBeInTheDocument();
    },
  );

  it('B-82: any other failure shows an error with "try again" and recovers', async () => {
    let fail = true;
    server.use(
      http.get(apiUrl('/users/:id'), () => (fail ? problemResponse(503, 'internal') : HttpResponse.json(JONAS))),
    );
    const { user } = await renderProfile('/users/7');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This profile could not be loaded.');
    expect(screen.queryByRole('region', { name: 'wall stand-in' })).not.toBeInTheDocument();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Jonas Albrecht' })).toBeInTheDocument();
  });

  it('B-19, F-43: a response with private fields is an error, never rendered', async () => {
    server.use(
      http.get(apiUrl('/users/:id'), () =>
        HttpResponse.json({ ...JONAS, user: { ...JONAS.user, email: 'jonas.albrecht@example.com' } }),
      ),
    );
    await renderProfile('/users/7');

    expect(await screen.findByRole('alert')).toHaveTextContent('This profile could not be loaded.');
    expect(screen.queryByText(/jonas\.albrecht@example\.com/)).not.toBeInTheDocument();
  });

  it('F-41: the own id ("self") goes to the own profile', async () => {
    server.use(
      http.get(apiUrl('/users/:id'), () =>
        HttpResponse.json({
          user: MIRA,
          relationship: { state: 'self', canViewWall: true, canPostOnWall: true },
        } satisfies UserProfileResponse),
      ),
    );
    const { router } = await renderProfile(`/users/${String(MIRA.id)}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Own profile stand-in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('B-91: moving to another profile never shows the previous user', async () => {
    const { promise, release } = gate();
    server.use(
      http.get(apiUrl('/users/:id'), async ({ params }) => {
        if (params['id'] === '8') {
          await promise;
          return HttpResponse.json(ELIF);
        }
        return HttpResponse.json(JONAS);
      }),
    );
    const { router } = await renderProfile('/users/7');
    expect(await screen.findByRole('heading', { level: 1, name: 'Jonas Albrecht' })).toBeInTheDocument();

    await router.navigate('/users/8');

    expect(await screen.findByRole('status')).toHaveTextContent('loading profile…');
    expect(screen.queryByText('Jonas Albrecht')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'wall stand-in' })).not.toBeInTheDocument();

    release();
    expect(await screen.findByRole('heading', { level: 1, name: 'Elif Kaya' })).toBeInTheDocument();
  });

  it('requests each profile once and answers a revisit from the cache', async () => {
    const requests: string[] = [];
    server.use(profileHandler([JONAS, ELIF], requests));
    const { router } = await renderProfile('/users/7');
    await screen.findByRole('heading', { level: 1, name: 'Jonas Albrecht' });

    await router.navigate('/users/8');
    await screen.findByRole('heading', { level: 1, name: 'Elif Kaya' });
    await router.navigate('/users/7');

    expect(await screen.findByRole('heading', { level: 1, name: 'Jonas Albrecht' })).toBeInTheDocument();
    expect(requests).toEqual(['7', '8']);
  });
});
