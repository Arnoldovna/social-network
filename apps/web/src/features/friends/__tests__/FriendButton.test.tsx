import type { FriendshipState } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  apiUrl,
  csrfTokenHandler,
  http,
  HttpResponse,
  problemResponse,
  server,
  TEST_CSRF_TOKEN,
} from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { FriendButton } from '../components/FriendButton';
import { ACTIONS_BY_STATE, friendActionLabel } from '../friend-button-labels';

vi.mock('../../../shared/realtime/socket', async () => (await import('./fakes')).socketModule);

const NOAH = { userId: 4, userName: 'Noah Fischer' };

/** A response the test releases itself, to look at the button while the request is in flight. */
function deferred() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

function renderButton(state: FriendshipState) {
  return renderWithProviders(<FriendButton userId={NOAH.userId} userName={NOAH.userName} state={state} />);
}

/** Records every friendship mutation the button sends. */
function recordMutations() {
  const calls: { method: string; path: string; body: unknown; csrf: string | null }[] = [];
  const record = async (request: Request) => {
    const text = await request.text();
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text === '' ? null : (JSON.parse(text) as unknown),
      csrf: request.headers.get('x-csrf-token'),
    });
  };
  return { calls, record };
}

describe('FriendButton labels (F-45, B-53)', () => {
  it.each([
    ['none', ['add friend']],
    ['pending_outgoing', ['cancel request']],
    ['pending_incoming', ['accept request', 'decline']],
    ['friends', ['unfriend']],
  ] as const)('F-45: state "%s" shows %j', (state, labels) => {
    renderButton(state);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(labels);
  });

  it('B-53: every state has its labels in the client, the first being the primary action', () => {
    for (const [state, actions] of Object.entries(ACTIONS_BY_STATE)) {
      expect(actions.length, state).toBeGreaterThan(0);
      for (const action of actions) {
        expect(friendActionLabel(action, 'profile', NOAH.userName).text).toMatch(/^[a-z ]+$/);
        // In a list row the accessible name starts with the visible label and names the person (WCAG 2.5.3).
        const row = friendActionLabel(action, 'row', NOAH.userName);
        expect(row.hiddenSuffix).toContain(NOAH.userName);
      }
    }
  });
});

describe('FriendButton actions (F-46–F-53, B-26, B-95)', () => {
  it('F-46, F-51: sends the request with the CSRF header, is disabled while it runs, then shows the server state', async () => {
    const { calls, record } = recordMutations();
    const { gate, release } = deferred();
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/friendships'), async ({ request }) => {
        await record(request);
        await gate;
        return HttpResponse.json({ userId: NOAH.userId, state: 'pending_outgoing' }, { status: 201 });
      }),
    );
    const { user } = renderButton('none');

    await user.click(screen.getByRole('button', { name: 'add friend' }));

    const running = screen.getByRole('button', { name: 'add friend' });
    expect(running).toBeDisabled();
    expect(running).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    release();

    expect(await screen.findByRole('button', { name: 'cancel request' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Friend request sent to Noah Fischer.');
    expect(calls).toEqual([
      { method: 'POST', path: '/api/friendships', body: { userId: NOAH.userId }, csrf: TEST_CSRF_TOKEN },
    ]);
  });

  it('F-51, B-95: a double click while the request runs sends one request', async () => {
    const { calls, record } = recordMutations();
    const { gate, release } = deferred();
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/friendships'), async ({ request }) => {
        await record(request);
        await gate;
        return HttpResponse.json({ userId: NOAH.userId, state: 'pending_outgoing' }, { status: 201 });
      }),
    );
    const { user } = renderButton('none');

    await user.dblClick(screen.getByRole('button', { name: 'add friend' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    release();

    expect(await screen.findByRole('button', { name: 'cancel request' })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it('B-26, F-48, F-53: an accept the server rejects with 404 never shows "friends" and explains why', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl(`/friendships/${String(NOAH.userId)}/accept`), () =>
        problemResponse(404, 'friend-request-not-found'),
      ),
    );
    const { user } = renderButton('pending_incoming');

    await user.click(screen.getByRole('button', { name: 'accept request' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This friend request no longer exists.');
    expect(screen.queryByRole('button', { name: 'unfriend' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'accept request' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'decline' })).toBeEnabled();
  });

  it('F-53, B-95: a failed request shows the message and returns the button to its previous state', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/friendships'), () =>
        problemResponse(429, 'rate-limited', {}, { headers: { 'retry-after': '30' } }),
      ),
    );
    const { user } = renderButton('none');

    await user.click(screen.getByRole('button', { name: 'add friend' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Wait a moment and try again.');
    const button = screen.getByRole('button', { name: 'add friend' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
  });

  it('F-53: a network failure keeps the state and clears the message on the next try', async () => {
    let attempts = 0;
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(NOAH.userId)}`), () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.error()
          : HttpResponse.json({ userId: NOAH.userId, state: 'none' }, { status: 200 });
      }),
    );
    const { user } = renderButton('pending_outgoing');

    await user.click(screen.getByRole('button', { name: 'cancel request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached.');

    await user.click(screen.getByRole('button', { name: 'cancel request' }));

    expect(await screen.findByRole('button', { name: 'add friend' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Friend request to Noah Fischer cancelled.');
  });

  it('F-49, B-27: decline removes the request and keeps keyboard focus on the button', async () => {
    const methods: string[] = [];
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(NOAH.userId)}`), ({ request }) => {
        methods.push(request.method);
        return HttpResponse.json({ userId: NOAH.userId, state: 'none' });
      }),
    );
    const { user } = renderButton('pending_incoming');

    await user.click(screen.getByRole('button', { name: 'decline' }));

    const addFriend = await screen.findByRole('button', { name: 'add friend' });
    expect(methods).toEqual(['DELETE']);
    expect(screen.queryByRole('button', { name: 'decline' })).not.toBeInTheDocument();
    expect(addFriend).toHaveFocus();
  });

  it('F-50: unfriending asks first; "cancel" sends nothing, "unfriend" ends the friendship', async () => {
    let deletes = 0;
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(NOAH.userId)}`), () => {
        deletes += 1;
        return HttpResponse.json({ userId: NOAH.userId, state: 'none' });
      }),
    );
    const { user } = renderButton('friends');

    await user.click(screen.getByRole('button', { name: 'unfriend' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Unfriend Noah Fischer?' });
    expect(dialog).toHaveAccessibleDescription(
      'You will no longer see each other’s walls. You can send a new friend request later.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deletes).toBe(0);
    expect(screen.getByRole('button', { name: 'unfriend' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'unfriend' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'unfriend' }));

    expect(await screen.findByRole('button', { name: 'add friend' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deletes).toBe(1);
    expect(screen.getByRole('status')).toHaveTextContent('You and Noah Fischer are no longer friends.');
  });

  it('F-50, F-53: a failed unfriend keeps the confirmation open with the message', async () => {
    server.use(
      csrfTokenHandler(),
      http.delete(apiUrl(`/friendships/${String(NOAH.userId)}`), () => problemResponse(500, 'internal')),
    );
    const { user } = renderButton('friends');

    await user.click(screen.getByRole('button', { name: 'unfriend' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'unfriend' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(within(dialog).getByRole('button', { name: 'unfriend' })).toBeEnabled();
  });

  it('B-26: a 404 after an earlier answer falls back to the state the profile reports, not the outdated answer', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/friendships'), () =>
        HttpResponse.json({ userId: NOAH.userId, state: 'pending_outgoing' }, { status: 201 }),
      ),
      // Noah declined before the profile was refetched; the refetch still says "none", so the prop never changes.
      http.delete(apiUrl(`/friendships/${String(NOAH.userId)}`), () =>
        problemResponse(404, 'friend-request-not-found'),
      ),
    );
    const { user } = renderButton('none');

    await user.click(screen.getByRole('button', { name: 'add friend' }));
    await user.click(await screen.findByRole('button', { name: 'cancel request' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This friend request no longer exists.');
    expect(screen.getByRole('button', { name: 'add friend' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'cancel request' })).not.toBeInTheDocument();
  });

  it('F-45: follows a newer state from the profile once it arrives (server state wins)', async () => {
    server.use(
      csrfTokenHandler(),
      http.post(apiUrl('/friendships'), () =>
        HttpResponse.json({ userId: NOAH.userId, state: 'pending_outgoing' }, { status: 201 }),
      ),
    );
    // Stands in for the profile page: its refetched `relationship.state` is passed down as the prop.
    function Profile() {
      const [state, setState] = useState<FriendshipState>('none');
      return (
        <>
          <FriendButton userId={NOAH.userId} userName={NOAH.userName} state={state} />
          <button
            type="button"
            onClick={() => {
              setState('friends');
            }}
          >
            refetch: friends
          </button>
          <button
            type="button"
            onClick={() => {
              setState('none');
            }}
          >
            refetch: none
          </button>
        </>
      );
    }
    const { user } = renderWithProviders(<Profile />);

    await user.click(screen.getByRole('button', { name: 'add friend' }));
    expect(await screen.findByRole('button', { name: 'cancel request' })).toBeInTheDocument();

    // Noah accepted meanwhile: the refetched profile says "friends".
    await user.click(screen.getByRole('button', { name: 'refetch: friends' }));
    expect(screen.getByRole('button', { name: 'unfriend' })).toBeInTheDocument();

    // Later he unfriends: back to "none", and the old answer of this button does not come back.
    await user.click(screen.getByRole('button', { name: 'refetch: none' }));
    expect(screen.getByRole('button', { name: 'add friend' })).toBeInTheDocument();
  });
});
