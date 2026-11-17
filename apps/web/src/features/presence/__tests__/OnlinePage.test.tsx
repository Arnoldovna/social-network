import type { UserSummary } from '@app/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MIRA, createTestStore, signInAs } from '../../../shared/api/__tests__/fixtures';
import { baseApi } from '../../../shared/api/baseApi';
import { apiUrl, http, HttpResponse, problemResponse, server } from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { OnlinePage } from '../pages/OnlinePage';

/*
 * The tab's socket, replaced by an in-memory emitter: the page's cache entry subscribes with `on`/`off`, and the test
 * plays the server with `serverEmit` (API.md §3). Nothing here opens a connection.
 */
const fakeSocket = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return this;
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    serverEmit(event: string, payload: unknown): void {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
    listenerCount(event: string): number {
      return handlers.get(event)?.size ?? 0;
    },
    reset(): void {
      handlers.clear();
    },
  };
});
vi.mock('../../../shared/realtime/socket', () => ({ getSocket: () => fakeSocket }));

const JONAS: UserSummary = {
  id: 2,
  firstName: 'Jonas',
  lastName: 'Berg',
  avatarUrl: '/api/users/2/avatar?v=0b6c2f8e-3d1a-4c5e-9f7a-2e8d4b6a1c90',
};
const AMARA: UserSummary = { id: 3, firstName: 'Amara', lastName: 'Okafor', avatarUrl: null };
const LEA: UserSummary = { id: 4, firstName: 'Lea', lastName: 'Hoffmann', avatarUrl: null };
const SELF: UserSummary = { id: MIRA.id, firstName: MIRA.firstName, lastName: MIRA.lastName, avatarUrl: null };

/** `GET /api/presence` answering with `items`; returns a counter of how often it was called. */
function presenceHandler(items: UserSummary[]) {
  const calls = { count: 0 };
  server.use(
    http.get(apiUrl('/presence'), () => {
      calls.count += 1;
      return HttpResponse.json({ items });
    }),
  );
  return calls;
}

async function renderOnlinePage() {
  const { store } = createTestStore();
  await signInAs(store);
  return renderWithProviders(<OnlinePage />, { store, path: '/online', initialEntries: ['/online'] });
}

function list() {
  return screen.getByRole('list', { name: 'Online' });
}

function listedNames(): string[] {
  return within(list())
    .getAllByRole('link')
    .map((link) => link.textContent);
}

/**
 * Plays the server. The page applies events once its first response is in the cache, a few microtasks after the list
 * rendered (earlier events are buffered, see the loading test); one macrotask turn lets those settle first, so every
 * assertion after this sees the event applied.
 */
async function serverEmit(event: 'presence:joined' | 'presence:left', payload: unknown): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fakeSocket.serverEmit(event, payload);
  });
}

beforeEach(() => {
  fakeSocket.reset();
});

describe('OnlinePage', () => {
  it('F-86, B-93: lists everyone else online in name order, each with a picture and a link to the profile', async () => {
    presenceHandler([JONAS, AMARA]);
    await renderOnlinePage();

    expect(await screen.findByRole('list', { name: 'Online' })).toBeInTheDocument();
    expect(listedNames()).toEqual(['Amara Okafor', 'Jonas Berg']);
    expect(screen.getByRole('link', { name: 'Jonas Berg' })).toHaveAttribute('href', '/users/2');
    expect(screen.getByRole('link', { name: 'Amara Okafor' })).toHaveAttribute('href', '/users/3');
    expect(screen.getByRole('img', { name: "Jonas Berg's profile picture" })).toHaveAttribute('src', JONAS.avatarUrl);
    expect(screen.getByRole('img', { name: "Amara Okafor's profile picture" })).toHaveTextContent('AO');
    expect(screen.getByRole('status')).toHaveTextContent('2 people online');
  });

  it('B-88, F-103: has one heading "Online" and the page title, without stray characters', async () => {
    presenceHandler([JONAS]);
    const { container } = await renderOnlinePage();

    await screen.findByRole('list', { name: 'Online' });
    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Online$/);
    expect(document.title).toBe("Online · Let's chat!");
    expect(container.textContent).not.toContain(';');
  });

  it('B-46: never lists the current user, from the list or from an event', async () => {
    presenceHandler([SELF, JONAS]);
    await renderOnlinePage();

    await screen.findByRole('list', { name: 'Online' });
    await serverEmit('presence:joined', SELF);

    expect(listedNames()).toEqual(['Jonas Berg']);
    expect(screen.queryByRole('link', { name: 'Mira Novak' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 person online');
  });

  it('F-88, B-87: someone who joins appears in real time, once, however often the event arrives', async () => {
    presenceHandler([JONAS]);
    await renderOnlinePage();
    await screen.findByRole('list', { name: 'Online' });

    await serverEmit('presence:joined', LEA);
    await serverEmit('presence:joined', LEA);
    await serverEmit('presence:joined', JONAS);

    expect(listedNames()).toEqual(['Jonas Berg', 'Lea Hoffmann']);
    expect(screen.getByRole('status')).toHaveTextContent('2 people online');
  });

  it('F-87: someone who leaves disappears in real time; the empty state follows the last one', async () => {
    presenceHandler([JONAS, AMARA]);
    await renderOnlinePage();
    await screen.findByRole('list', { name: 'Online' });

    await serverEmit('presence:left', { userId: AMARA.id });
    expect(listedNames()).toEqual(['Jonas Berg']);

    await serverEmit('presence:left', { userId: JONAS.id });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('Nobody else is online right now.')).toBeInTheDocument();
  });

  it('F-89: says so when nobody else is online and offers the chat', async () => {
    presenceHandler([]);
    await renderOnlinePage();

    expect(await screen.findByText('Nobody else is online right now.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'go to the chat' })).toHaveAttribute('href', '/chat');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('F-88: the empty list fills in when the first person joins', async () => {
    presenceHandler([]);
    await renderOnlinePage();
    await screen.findByText('Nobody else is online right now.');

    await serverEmit('presence:joined', AMARA);

    expect(listedNames()).toEqual(['Amara Okafor']);
    expect(screen.queryByText('Nobody else is online right now.')).not.toBeInTheDocument();
  });

  it('F-88: keeps someone who joined while the list was still loading', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(apiUrl('/presence'), async () => {
        await gate;
        return HttpResponse.json({ items: [JONAS] });
      }),
    );
    await renderOnlinePage();

    expect(await screen.findByText('loading who is online…')).toBeInTheDocument();
    await waitFor(() => {
      expect(fakeSocket.listenerCount('presence:joined')).toBe(1);
    });
    await serverEmit('presence:joined', LEA);
    release();

    await screen.findByRole('list', { name: 'Online' });
    await waitFor(() => {
      expect(listedNames()).toEqual(['Jonas Berg', 'Lea Hoffmann']);
    });
  });

  it('F-90: drops event payloads that are not exactly the public user fields', async () => {
    presenceHandler([JONAS]);
    await renderOnlinePage();
    await screen.findByRole('list', { name: 'Online' });

    await serverEmit('presence:joined', { ...LEA, email: 'lea@example.com' });
    await serverEmit('presence:joined', { id: '5', firstName: 'Tomás', lastName: 'Ruiz', avatarUrl: null });
    await serverEmit('presence:left', { userId: String(JONAS.id) });

    expect(listedNames()).toEqual(['Jonas Berg']);
  });

  it('F-105: shows the error with "try again", which loads the list again', async () => {
    presenceHandler([JONAS]);
    // Handlers added later take precedence: the first request fails, the retry reaches the one above.
    server.use(http.get(apiUrl('/presence'), () => problemResponse(500, 'internal'), { once: true }));
    const { user } = await renderOnlinePage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The online list could not be loaded.');
    expect(alert).toHaveTextContent('Something went wrong on our side. Please try again.');

    await user.click(within(alert).getByRole('button', { name: 'try again' }));

    expect(await screen.findByRole('list', { name: 'Online' })).toBeInTheDocument();
    expect(listedNames()).toEqual(['Jonas Berg']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('B-89: loads the list with exactly one request, and refetches when the Presence tag is invalidated', async () => {
    const calls = presenceHandler([JONAS]);
    const { store } = await renderOnlinePage();
    await screen.findByRole('list', { name: 'Online' });
    expect(calls.count).toBe(1);

    // What the realtime listener does after a reconnect and the avatar upload after a new picture (OVERVIEW §7).
    presenceHandler([JONAS, LEA]);
    act(() => {
      store.dispatch(baseApi.util.invalidateTags(['Presence']));
    });

    await waitFor(() => {
      expect(listedNames()).toEqual(['Jonas Berg', 'Lea Hoffmann']);
    });
  });

  it('stops listening to presence events once its cache entry is gone', async () => {
    presenceHandler([JONAS]);
    const { store, unmount } = await renderOnlinePage();
    await screen.findByRole('list', { name: 'Online' });
    expect(fakeSocket.listenerCount('presence:joined')).toBe(1);
    expect(fakeSocket.listenerCount('presence:left')).toBe(1);

    unmount();
    // Logout and session expiry reset the API state, which removes every cache entry (ADR-0012).
    store.dispatch(baseApi.util.resetApiState());

    await waitFor(() => {
      expect(fakeSocket.listenerCount('presence:joined')).toBe(0);
    });
    expect(fakeSocket.listenerCount('presence:left')).toBe(0);
  });
});
