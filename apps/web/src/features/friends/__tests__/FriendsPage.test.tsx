import type { FriendshipsResponse } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { baseApi } from '../../../shared/api/baseApi';
import { apiUrl, csrfTokenHandler, http, HttpResponse, problemResponse, server } from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { FriendsNavBadge } from '../components/FriendsNavBadge';
import { FriendsPage } from '../pages/FriendsPage';
import { AIKO, CLARA, fakeSocket, LUCIA, miraFriendships, noFriendships, SOFIA, TOMAS, YUSUF } from './fakes';

vi.mock('../../../shared/realtime/socket', async () => (await import('./fakes')).socketModule);

type Rendered = ReturnType<typeof renderWithProviders>;
const rendered: Rendered[] = [];

afterEach(async () => {
  // Unmount first (no hook may refetch), then remove the cache entries: that ends their `friendship:changed`
  // subscriptions on the shared fake socket, so no handler leaks into the next test.
  for (const { store, unmount } of rendered.splice(0)) {
    unmount();
    store.dispatch(baseApi.util.resetApiState());
  }
  await waitFor(() => {
    expect(fakeSocket.listenerCount('friendship:changed')).toBe(0);
  });
});

/** A gate the test opens itself, to look at the page before a response arrives. */
function deferred() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/**
 * `GET /api/friendships` answering with `responses` in turn (the last one repeats). `hold` keeps every answer after the
 * first waiting until the test releases it, so the page can be checked before the refetch lands.
 */
function friendshipsHandler(responses: FriendshipsResponse[], hold?: Promise<void>) {
  const calls = { count: 0 };
  server.use(
    http.get(apiUrl('/friendships'), async () => {
      calls.count += 1;
      if (calls.count > 1 && hold !== undefined) {
        await hold;
      }
      const body = responses[Math.min(calls.count, responses.length) - 1] ?? noFriendships();
      return HttpResponse.json(body);
    }),
  );
  return calls;
}

function track(result: Rendered): Rendered {
  rendered.push(result);
  return result;
}

function renderPage() {
  return track(renderWithProviders(<FriendsPage />));
}

function section(name: string) {
  return screen.getByRole('region', { name });
}

function namesIn(name: string): string[] {
  return within(section(name))
    .queryAllByRole('link')
    .map((link) => link.textContent);
}

describe('FriendsPage lists (F-54, F-56, F-58, B-93, B-110)', () => {
  it('F-54: shows the page title and the three lists, each entry with avatar, date and a link to the profile', async () => {
    friendshipsHandler([miraFriendships()]);
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Friends' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'friend requests' })).toBeInTheDocument();
    expect(namesIn('friend requests')).toEqual(['Sofia Lindqvist', 'Yusuf Demir']);
    expect(namesIn('friends')).toEqual(['Aiko Tanaka', 'lucía de la Cruz', 'Tomás Herrera']);
    expect(namesIn('sent requests')).toEqual(['Clara Moreau']);
    expect(within(section('friend requests')).getByText('2 requests')).toBeInTheDocument();
    expect(within(section('friends')).getByText('3 friends')).toBeInTheDocument();
    expect(within(section('sent requests')).getByText('1 request')).toBeInTheDocument();

    // B-93: every entry links to the profile.
    const friends = within(section('friends'));
    expect(friends.getByRole('link', { name: 'Aiko Tanaka' })).toHaveAttribute('href', `/users/${String(AIKO.id)}`);
    expect(friends.getByRole('img', { name: "Aiko Tanaka's profile picture" })).toHaveAttribute('src', AIKO.avatarUrl);
    expect(friends.getAllByText('friends since', { exact: false })).toHaveLength(3);
    const since = within(friends.getByRole('link', { name: 'Tomás Herrera' }).closest('li')!).getByText('14 Sept 2026');
    expect(since.tagName).toBe('TIME');
    expect(since).toHaveAttribute('datetime', '2026-09-14T12:15:00.000Z');
    expect(
      within(screen.getByRole('link', { name: 'Clara Moreau' }).closest('li')!).getByText('request sent', {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it('F-58, B-110: renders names exactly as stored, never re-cased in markup', async () => {
    friendshipsHandler([miraFriendships()]);
    renderPage();

    const link = await screen.findByRole('link', { name: 'lucía de la Cruz' });
    expect(link.textContent).toBe(`${LUCIA.firstName} ${LUCIA.lastName}`);
  });

  it('F-55: offers "unfriend" for friends, "accept" and "decline" for requests and "cancel" for sent requests', async () => {
    friendshipsHandler([miraFriendships()]);
    renderPage();

    await screen.findByRole('region', { name: 'friends' });
    expect(
      within(section('friends'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['unfriend Aiko Tanaka', 'unfriend lucía de la Cruz', 'unfriend Tomás Herrera']);
    expect(
      within(section('friend requests'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      'accept request from Sofia Lindqvist',
      'decline request from Sofia Lindqvist',
      'accept request from Yusuf Demir',
      'decline request from Yusuf Demir',
    ]);
    expect(within(section('sent requests')).getByRole('button')).toHaveAccessibleName('cancel request to Clara Moreau');
  });

  it('F-56: every empty list says so and what to do next', async () => {
    friendshipsHandler([noFriendships()]);
    renderPage();

    const requests = within(await screen.findByRole('region', { name: 'friend requests' }));
    expect(requests.getByText('No friend requests right now.')).toBeInTheDocument();
    expect(requests.getByText('When someone sends you a friend request, it appears here.')).toBeInTheDocument();
    expect(within(section('friends')).getByText('You have not added any friends yet.')).toBeInTheDocument();
    expect(
      within(section('friends')).getByText('Use the search in the header to find people you know.'),
    ).toBeInTheDocument();
    expect(within(section('sent requests')).getByText('No sent requests.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('F-105: shows "loading friends…", then the lists', async () => {
    const { gate, release } = deferred();
    server.use(
      http.get(apiUrl('/friendships'), async () => {
        await gate;
        return HttpResponse.json(miraFriendships());
      }),
    );
    renderPage();

    // The page's toast keeps its own (empty) live regions mounted, so the loading state is found by its text.
    expect(screen.getByText('loading friends…')).toHaveAttribute('role', 'status');
    release();
    expect(await screen.findByRole('region', { name: 'friends' })).toBeInTheDocument();
  });

  it('F-105: a failed load explains itself and "try again" loads the lists', async () => {
    let calls = 0;
    server.use(
      http.get(apiUrl('/friendships'), () => {
        calls += 1;
        return calls === 1 ? problemResponse(500, 'internal') : HttpResponse.json(miraFriendships());
      }),
    );
    const { user } = renderPage();

    const alert = (await screen.findByText('Your friends could not be loaded.')).closest<HTMLElement>('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent('Something went wrong on our side. Please try again.');

    await user.click(within(alert!).getByRole('button', { name: 'try again' }));

    expect(await screen.findByRole('region', { name: 'friends' })).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});

describe('FriendsPage actions (F-49, F-50, F-55, B-26, B-27)', () => {
  it('F-55, B-26: an accepted request moves to "friends" from the server answer, before the refetch lands', async () => {
    const accepted = miraFriendships();
    accepted.incoming = accepted.incoming.filter((entry) => entry.user.id !== SOFIA.id);
    accepted.friends = [
      accepted.friends[0]!,
      accepted.friends[1]!,
      { user: SOFIA, since: '2026-11-17T10:00:00.000Z' },
      accepted.friends[2]!,
    ];
    const refetch = deferred();
    const calls = friendshipsHandler([miraFriendships(), accepted], refetch.gate);
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl(`/friendships/${String(SOFIA.id)}/accept`), () =>
        HttpResponse.json({ userId: SOFIA.id, state: 'friends' }),
      ),
    );
    const { user } = renderPage();
    await screen.findByRole('region', { name: 'friends' });

    await user.click(screen.getByRole('button', { name: 'accept request from Sofia Lindqvist' }));

    await waitFor(() => {
      expect(namesIn('friends')).toEqual(['Aiko Tanaka', 'lucía de la Cruz', 'Sofia Lindqvist', 'Tomás Herrera']);
    });
    expect(namesIn('friend requests')).toEqual(['Yusuf Demir']);
    expect(screen.getByRole('status')).toHaveTextContent('You and Sofia Lindqvist are now friends.');
    // The row that held focus is gone: focus stays in place, on the list's heading.
    expect(screen.getByRole('heading', { name: 'friend requests' })).toHaveFocus();
    expect(calls.count).toBe(2);

    refetch.release();
    await waitFor(() => {
      expect(within(section('friends')).getByText('4 friends')).toBeInTheDocument();
    });
    expect(namesIn('friends')).toEqual(['Aiko Tanaka', 'lucía de la Cruz', 'Sofia Lindqvist', 'Tomás Herrera']);
  });

  it('F-49, B-27: "decline" removes the request', async () => {
    const declined = miraFriendships();
    declined.incoming = declined.incoming.filter((entry) => entry.user.id !== YUSUF.id);
    friendshipsHandler([miraFriendships(), declined]);
    const methods: string[] = [];
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(YUSUF.id)}`), ({ request }) => {
        methods.push(request.method);
        return HttpResponse.json({ userId: YUSUF.id, state: 'none' });
      }),
    );
    const { user } = renderPage();
    await screen.findByRole('region', { name: 'friends' });

    await user.click(screen.getByRole('button', { name: 'decline request from Yusuf Demir' }));

    await waitFor(() => {
      expect(namesIn('friend requests')).toEqual(['Sofia Lindqvist']);
    });
    expect(methods).toEqual(['DELETE']);
    expect(namesIn('friends')).not.toContain('Yusuf Demir');
    expect(await screen.findByText('Friend request from Yusuf Demir declined.')).toBeInTheDocument();
  });

  it('F-55: "cancel" withdraws a sent request and the empty list says so', async () => {
    const cancelled = miraFriendships();
    cancelled.outgoing = [];
    friendshipsHandler([miraFriendships(), cancelled]);
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(CLARA.id)}`), () =>
        HttpResponse.json({ userId: CLARA.id, state: 'none' }),
      ),
    );
    const { user } = renderPage();
    await screen.findByRole('region', { name: 'sent requests' });

    await user.click(screen.getByRole('button', { name: 'cancel request to Clara Moreau' }));

    expect(await within(section('sent requests')).findByText('No sent requests.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'sent requests' })).toHaveFocus();
  });

  it('F-50: "unfriend" asks first and then removes the friend', async () => {
    const unfriended = miraFriendships();
    unfriended.friends = unfriended.friends.filter((entry) => entry.user.id !== TOMAS.id);
    friendshipsHandler([miraFriendships(), unfriended]);
    let deletes = 0;
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(TOMAS.id)}`), () => {
        deletes += 1;
        return HttpResponse.json({ userId: TOMAS.id, state: 'none' });
      }),
    );
    const { user } = renderPage();
    await screen.findByRole('region', { name: 'friends' });

    await user.click(screen.getByRole('button', { name: 'unfriend Tomás Herrera' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Unfriend Tomás Herrera?' });
    expect(deletes).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'unfriend' }));

    await waitFor(() => {
      expect(namesIn('friends')).toEqual(['Aiko Tanaka', 'lucía de la Cruz']);
    });
    expect(deletes).toBe(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'friends' })).toHaveFocus();
  });

  it('B-26, F-53: an action on a request that is gone shows the error and refetches the real lists', async () => {
    const withdrawn = miraFriendships();
    withdrawn.incoming = withdrawn.incoming.filter((entry) => entry.user.id !== SOFIA.id);
    const calls = friendshipsHandler([miraFriendships(), withdrawn]);
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl(`/friendships/${String(SOFIA.id)}/accept`), () =>
        problemResponse(404, 'friend-request-not-found'),
      ),
    );
    const { user } = renderPage();
    await screen.findByRole('region', { name: 'friends' });

    await user.click(screen.getByRole('button', { name: 'accept request from Sofia Lindqvist' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This friend request no longer exists.');
    await waitFor(() => {
      expect(namesIn('friend requests')).toEqual(['Yusuf Demir']);
    });
    expect(namesIn('friends')).not.toContain('Sofia Lindqvist');
    expect(calls.count).toBe(2);
  });

  it('F-53: a failed action that changes nothing keeps the entry and its buttons', async () => {
    const calls = friendshipsHandler([miraFriendships()]);
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(YUSUF.id)}`), () => HttpResponse.error()),
    );
    const { user } = renderPage();
    await screen.findByRole('region', { name: 'friends' });

    await user.click(screen.getByRole('button', { name: 'decline request from Yusuf Demir' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached.');
    expect(screen.getByRole('button', { name: 'decline request from Yusuf Demir' })).toBeEnabled();
    expect(namesIn('friend requests')).toEqual(['Sofia Lindqvist', 'Yusuf Demir']);
    expect(calls.count).toBe(1);
  });
});

describe('Fresh friends data (F-52, F-57, B-92)', () => {
  it('F-57: refetches the lists every time the page is opened', async () => {
    const calls = friendshipsHandler([miraFriendships()]);
    const { router } = track(
      renderWithProviders(<FriendsPage />, {
        path: '/friends',
        initialEntries: ['/friends'],
        routes: [{ path: '/chat', element: <h1>Chat</h1> }],
      }),
    );
    await screen.findByRole('region', { name: 'friends' });

    await router.navigate('/chat');
    expect(await screen.findByRole('heading', { level: 1, name: 'Chat' })).toBeInTheDocument();
    await router.navigate('/friends');

    await waitFor(() => {
      expect(calls.count).toBe(2);
    });
    expect(await screen.findByRole('region', { name: 'friends' })).toBeInTheDocument();
  });

  it('F-57, B-92: a friendship:changed event refetches the lists, so a new request appears without a reload', async () => {
    const newRequest = miraFriendships();
    const ewa = { id: 12, firstName: 'Ewa', lastName: 'Kowalska', avatarUrl: null };
    newRequest.incoming = [{ user: ewa, since: '2026-11-17T09:00:00.000Z' }, ...newRequest.incoming];
    const calls = friendshipsHandler([miraFriendships(), newRequest]);
    renderPage();
    await screen.findByRole('region', { name: 'friends' });
    expect(fakeSocket.listenerCount('friendship:changed')).toBe(1);

    fakeSocket.receive('friendship:changed', { userId: ewa.id, state: 'pending_incoming' });

    await waitFor(() => {
      expect(namesIn('friend requests')).toEqual(['Ewa Kowalska', 'Sofia Lindqvist', 'Yusuf Demir']);
    });
    expect(calls.count).toBe(2);
  });

  it('F-52: the navigation badge counts incoming requests and follows friendship events in real time', async () => {
    const third = miraFriendships();
    third.incoming = [...third.incoming, { user: CLARA, since: '2026-11-17T09:00:00.000Z' }];
    third.outgoing = [];
    friendshipsHandler([miraFriendships(), third]);
    track(renderWithProviders(<FriendsNavBadge />));

    const badge = screen.getByRole('status');
    await waitFor(() => {
      expect(badge).toHaveTextContent('2 friend requests');
    });
    // The visible part is the number on the rose field; the words are for screen readers.
    expect(within(badge).getByText('2')).toHaveAttribute('aria-hidden', 'true');

    fakeSocket.receive('friendship:changed', { userId: CLARA.id, state: 'pending_incoming' });

    await waitFor(() => {
      expect(badge).toHaveTextContent('3 friend requests');
    });
  });

  it('F-52, B-86: a friendship:changed event that overtakes the first response still reaches the badge', async () => {
    const third = miraFriendships();
    third.incoming = [...third.incoming, { user: CLARA, since: '2026-11-17T09:00:00.000Z' }];
    third.outgoing = [];
    const firstAnswer = deferred();
    let calls = 0;
    server.use(
      http.get(apiUrl('/friendships'), async () => {
        calls += 1;
        if (calls === 1) {
          // The server built this answer before Clara's request; its event reaches the tab first.
          await firstAnswer.gate;
          return HttpResponse.json(miraFriendships());
        }
        return HttpResponse.json(third);
      }),
    );
    track(renderWithProviders(<FriendsNavBadge />));
    await waitFor(() => {
      expect(fakeSocket.listenerCount('friendship:changed')).toBe(1);
    });

    fakeSocket.receive('friendship:changed', { userId: CLARA.id, state: 'pending_incoming' });
    firstAnswer.release();

    const badge = screen.getByRole('status');
    await waitFor(() => {
      expect(badge).toHaveTextContent('3 friend requests');
    });
    expect(calls).toBe(2);
  });

  it('F-52, F-55: answering a request lowers the badge at once; no requests, no badge', async () => {
    const answered = miraFriendships();
    answered.incoming = [];
    friendshipsHandler([
      { ...miraFriendships(), incoming: [miraFriendships().incoming[0]!] },
      { ...answered, friends: [...answered.friends] },
    ]);
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(SOFIA.id)}`), () =>
        HttpResponse.json({ userId: SOFIA.id, state: 'none' }),
      ),
    );
    const { user } = track(
      renderWithProviders(
        <>
          <FriendsNavBadge />
          <FriendsPage />
        </>,
      ),
    );
    await screen.findByRole('region', { name: 'friends' });
    const badge = screen.getAllByRole('status')[0]!;
    expect(badge).toHaveTextContent('1 friend request');

    await user.click(screen.getByRole('button', { name: 'decline request from Sofia Lindqvist' }));

    await waitFor(() => {
      expect(badge).toBeEmptyDOMElement();
    });
  });
});
