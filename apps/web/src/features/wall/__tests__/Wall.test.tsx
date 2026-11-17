import type { WallPage, WallPost } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA, signInAs } from '../../../shared/api/__tests__/fixtures';
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
import { Wall } from '../components/Wall';
import type { WallProps } from '../components/Wall';
import { socket } from './fakes';

vi.mock('../../../shared/realtime/socket', async () => (await import('./fakes')).socketModule);

const ADA = { id: 2, firstName: 'Ada', lastName: 'Brennan', avatarUrl: '/api/users/2/avatar?v=9a3e' };
const JONAS = { id: 3, firstName: 'Jonas', lastName: 'Lindqvist', avatarUrl: null };
const MIRA_SUMMARY = { id: MIRA.id, firstName: MIRA.firstName, lastName: MIRA.lastName, avatarUrl: MIRA.avatarUrl };

let nextPostId = 100;

function post(author: WallPost['author'], wallOwnerId: number, body: string, minutesAgo: number): WallPost {
  nextPostId += 1;
  return {
    id: nextPostId,
    wallOwnerId,
    author,
    body,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

function page(items: WallPost[], nextCursor: string | null = null): WallPage {
  return { items, nextCursor };
}

/** Answers `GET /api/users/:ownerId/posts`; `pages` maps the requested cursor (`null` = newest) to a page. */
function postsHandler(ownerId: number, pages: Map<string | null, WallPage> | WallPage) {
  const requests: URL[] = [];
  const handler = http.get(apiUrl(`/users/${String(ownerId)}/posts`), ({ request }) => {
    const url = new URL(request.url);
    requests.push(url);
    const answer = pages instanceof Map ? pages.get(url.searchParams.get('cursor')) : pages;
    return answer === undefined ? problemResponse(400, 'invalid-cursor') : HttpResponse.json(answer);
  });
  return { handler, requests };
}

async function renderWall(props: Partial<WallProps> = {}) {
  const { store } = createTestStore();
  await signInAs(store);
  return renderWithProviders(<Wall ownerId={ADA.id} ownerFirstName={ADA.firstName} canView canPost {...props} />, {
    store,
  });
}

function postArticles() {
  return within(screen.getByRole('list')).getAllByRole('article');
}

beforeEach(() => {
  socket.reset();
});

describe('Wall', () => {
  it('F-65: without read access it says how to get it and requests nothing', async () => {
    await renderWall({ canView: false, canPost: false });

    expect(screen.getByRole('heading', { level: 2, name: 'wall' })).toBeInTheDocument();
    expect(screen.getByText('Become friends with Ada to see their wall.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(socket.listenerCount('wall:post-created')).toBe(0);
  });

  it('B-100: shows "loading posts…" first, then the posts newest first (F-70)', async () => {
    const newest = post(JONAS, ADA.id, 'The ferry to Inishmore runs again from Monday.', 5);
    const older = post(ADA, ADA.id, 'Back from the coast, photos soon.', 90);
    const { handler, requests } = postsHandler(ADA.id, page([newest, older]));
    server.use(handler);

    await renderWall();

    expect(screen.getByText('loading posts…')).toBeInTheDocument();
    await screen.findByText(newest.body);
    const articles = postArticles();
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveTextContent(newest.body);
    expect(articles[1]).toHaveTextContent(older.body);
    expect(requests[0]?.searchParams.get('limit')).toBe('20');
    expect(requests[0]?.searchParams.has('cursor')).toBe(false);
  });

  it('F-69, B-99, B-71: a post shows avatar, linked author name, text and a <time datetime>, and no other image', async () => {
    const written = post(ADA, ADA.id, 'Line one\nline two', 5);
    server.use(postsHandler(ADA.id, page([written])).handler);

    await renderWall();

    const article = await screen.findByRole('article', { name: 'Ada Brennan' });
    expect(within(article).getByRole('link', { name: 'Ada Brennan' })).toHaveAttribute('href', '/users/2');
    const images = within(article).getAllByRole('img');
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAccessibleName("Ada Brennan's profile picture");
    expect(within(article).getByText(/Line one/)).toHaveTextContent('Line one line two');
    const time = article.querySelector('time');
    expect(time).toHaveAttribute('datetime', written.createdAt);
    expect(time).toHaveTextContent('5 minutes ago');
  });

  it('F-74: an empty wall says "No posts yet." and invites the first post when the viewer may post', async () => {
    server.use(postsHandler(ADA.id, page([])).handler);

    await renderWall();

    expect(await screen.findByText('No posts yet.')).toBeInTheDocument();
    expect(screen.getByText('Write the first one.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: "write on Ada's wall" })).toBeInTheDocument();
  });

  it('B-90: without write access there is no composer and no invitation', async () => {
    server.use(postsHandler(ADA.id, page([])).handler);

    await renderWall({ canPost: false });

    expect(await screen.findByText('No posts yet.')).toBeInTheDocument();
    expect(screen.queryByText('Write the first one.')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('F-105: a failed load shows the reason and "try again" loads the posts', async () => {
    let failed = false;
    const written = post(ADA, ADA.id, 'Second attempt worked.', 2);
    server.use(
      http.get(apiUrl('/users/2/posts'), () => {
        if (!failed) {
          failed = true;
          return problemResponse(403, 'wall-forbidden');
        }
        return HttpResponse.json(page([written]));
      }),
    );

    const { user } = await renderWall();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The posts could not be loaded.');
    expect(alert).toHaveTextContent('Only friends can see this wall.');
    await user.click(within(alert).getByRole('button', { name: 'try again' }));
    expect(await screen.findByText(written.body)).toBeInTheDocument();
  });

  it('F-70: "load older posts" fetches the next page with the cursor and appends it', async () => {
    const first = Array.from({ length: 20 }, (_, index) =>
      post(ADA, ADA.id, `Post number ${String(20 - index)}`, index),
    );
    const older = post(JONAS, ADA.id, 'The oldest post on this wall.', 600);
    const { handler, requests } = postsHandler(
      ADA.id,
      new Map([
        [null, page(first, 'cursor-after-20')],
        ['cursor-after-20', page([older])],
      ]),
    );
    server.use(handler);

    const { user } = await renderWall();

    const button = await screen.findByRole('button', { name: 'load older posts' });
    expect(postArticles()).toHaveLength(20);
    await user.click(button);

    expect(await screen.findByText(older.body)).toBeInTheDocument();
    expect(postArticles()).toHaveLength(21);
    expect(postArticles().at(-1)).toHaveTextContent(older.body);
    expect(requests.at(-1)?.searchParams.get('cursor')).toBe('cursor-after-20');
    expect(screen.queryByRole('button', { name: /load older posts/ })).not.toBeInTheDocument();
  });

  it('F-70: a failed "load older posts" keeps the loaded posts and the button to try again', async () => {
    const first = post(ADA, ADA.id, 'Only the first page arrives.', 1);
    server.use(postsHandler(ADA.id, new Map([[null, page([first], 'cursor-x')]])).handler);

    const { user } = await renderWall();

    await user.click(await screen.findByRole('button', { name: 'load older posts' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Older entries could not be loaded. Reload the page and try again.',
    );
    expect(screen.getByText(first.body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'load older posts' })).toBeInTheDocument();
  });

  it("F-71, B-90: on a friend's wall only the viewer's own posts can be deleted", async () => {
    const byAda = post(ADA, ADA.id, 'Ada wrote this on her own wall.', 3);
    const byMira = post(MIRA_SUMMARY, ADA.id, 'Mira says hello.', 4);
    server.use(postsHandler(ADA.id, page([byAda, byMira])).handler);

    await renderWall();

    const adaArticle = await screen.findByRole('article', { name: 'Ada Brennan' });
    const miraArticle = screen.getByRole('article', { name: 'Mira Novak' });
    expect(within(adaArticle).queryByRole('button', { name: /delete post/ })).not.toBeInTheDocument();
    expect(within(miraArticle).getByRole('button', { name: 'delete post by Mira Novak' })).toBeInTheDocument();
  });

  it('F-71: the owner can delete every post on the own wall after confirming', async () => {
    const byAda = post(ADA, MIRA.id, "Ada left a note on Mira's wall.", 3);
    const byMira = post(MIRA_SUMMARY, MIRA.id, 'Mira wrote this herself.', 4);
    const deletes: { id: string; csrf: string | null }[] = [];
    server.use(
      postsHandler(MIRA.id, page([byAda, byMira])).handler,
      csrfTokenHandler(),
      http.delete(apiUrl('/posts/:id'), ({ params, request }) => {
        deletes.push({ id: String(params['id']), csrf: request.headers.get('x-csrf-token') });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { user } = await renderWall({ ownerId: MIRA.id, ownerFirstName: MIRA.firstName });

    await user.click(await screen.findByRole('button', { name: 'delete post by Ada Brennan' }));
    expect(screen.getByRole('button', { name: 'delete post by Mira Novak' })).toBeInTheDocument();
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this post?' });
    await user.click(within(dialog).getByRole('button', { name: 'delete post' }));

    await waitFor(() => {
      expect(screen.queryByText(byAda.body)).not.toBeInTheDocument();
    });
    expect(deletes).toEqual([{ id: String(byAda.id), csrf: TEST_CSRF_TOKEN }]);
    expect(screen.getByText(byMira.body)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'wall' })).toHaveFocus();
    expect(await screen.findByText('Post deleted.')).toBeInTheDocument();
  });

  it('F-71: "cancel" keeps the post, and a refused delete keeps the dialog open with the reason', async () => {
    const byMira = post(MIRA_SUMMARY, ADA.id, 'Still here after all this.', 4);
    server.use(
      postsHandler(ADA.id, page([byMira])).handler,
      csrfTokenHandler(),
      http.delete(apiUrl('/posts/:id'), () => problemResponse(429, 'rate-limited')),
    );

    const { user } = await renderWall();

    await user.click(await screen.findByRole('button', { name: 'delete post by Mira Novak' }));
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText(byMira.body)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'delete post by Mira Novak' }));
    await user.click(screen.getByRole('button', { name: 'delete post' }));

    const dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Too many requests. Wait a moment and try again.',
    );
    expect(screen.getByText(byMira.body)).toBeInTheDocument();
  });

  it('F-71: a post that is already gone (404) leaves the wall without an error', async () => {
    const byMira = post(MIRA_SUMMARY, ADA.id, 'Deleted in another tab a moment ago.', 4);
    server.use(
      postsHandler(ADA.id, page([byMira])).handler,
      csrfTokenHandler(),
      http.delete(apiUrl('/posts/:id'), () => problemResponse(404, 'post-not-found')),
    );

    const { user } = await renderWall();

    await user.click(await screen.findByRole('button', { name: 'delete post by Mira Novak' }));
    await user.click(screen.getByRole('button', { name: 'delete post' }));

    await waitFor(() => {
      expect(screen.queryByText(byMira.body)).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('F-72: joins the wall room when connected, again after a reconnect, and leaves it on unmount', async () => {
    socket.connected = true;
    server.use(postsHandler(JONAS.id, page([])).handler);
    // Earlier tests' stores drop their entries after cleanup on the same fake socket, so only Jonas's room counts.
    const roomEvents = () => socket.emitted.filter(({ payload }) => JSON.stringify(payload) === '{"userId":3}');

    const { unmount } = await renderWall({ ownerId: JONAS.id, ownerFirstName: JONAS.firstName });
    await screen.findByText('No posts yet.');

    expect(roomEvents()).toEqual([{ event: 'wall:join', payload: { userId: JONAS.id } }]);
    socket.fire('connect');
    expect(roomEvents().map(({ event }) => event)).toEqual(['wall:join', 'wall:join']);

    unmount();
    await waitFor(() => {
      expect(roomEvents().map(({ event }) => event)).toEqual(['wall:join', 'wall:join', 'wall:leave']);
    });
    expect(socket.listenerCount('wall:post-created')).toBe(0);
    expect(socket.listenerCount('connect')).toBe(0);
  });

  it('F-72: posts created and deleted on this wall appear and disappear live; other walls are ignored', async () => {
    const existing = post(ADA, ADA.id, 'Morning swim at the harbour.', 30);
    server.use(postsHandler(ADA.id, page([existing])).handler);

    await renderWall();
    await screen.findByText(existing.body);

    const incoming = post(JONAS, ADA.id, 'Count me in for Saturday.', 0);
    socket.fire('wall:post-created', incoming);
    socket.fire('wall:post-created', incoming);
    socket.fire('wall:post-created', post(JONAS, 99, 'This belongs on another wall.', 0));
    socket.fire('wall:post-created', { ...post(JONAS, ADA.id, 'Smuggled field.', 0), email: 'x@example.com' });

    expect(await screen.findByText(incoming.body)).toBeInTheDocument();
    expect(postArticles()).toHaveLength(2);
    expect(postArticles()[0]).toHaveTextContent(incoming.body);
    expect(screen.queryByText('This belongs on another wall.')).not.toBeInTheDocument();
    expect(screen.queryByText('Smuggled field.')).not.toBeInTheDocument();

    socket.fire('wall:post-deleted', { id: existing.id, wallOwnerId: 99 });
    expect(screen.getByText(existing.body)).toBeInTheDocument();
    socket.fire('wall:post-deleted', { id: existing.id, wallOwnerId: ADA.id });
    await waitFor(() => {
      expect(screen.queryByText(existing.body)).not.toBeInTheDocument();
    });
  });

  it('B-86: an event that arrives before the first page does not throw and is applied once the page is in', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const existing = post(ADA, ADA.id, 'Loaded over HTTP.', 10);
    server.use(
      http.get(apiUrl('/users/2/posts'), async () => {
        await gate;
        return HttpResponse.json(page([existing]));
      }),
    );

    await renderWall();
    await waitFor(() => {
      expect(socket.listenerCount('wall:post-created')).toBe(1);
    });

    const early = post(JONAS, ADA.id, 'Arrived while the wall was loading.', 0);
    expect(() => {
      socket.fire('wall:post-created', early);
    }).not.toThrow();
    expect(screen.getByText('loading posts…')).toBeInTheDocument();

    release();
    expect(await screen.findByText(early.body)).toBeInTheDocument();
    expect(screen.getByText(existing.body)).toBeInTheDocument();
  });

  it('B-111: a post from someone else is announced politely; loading pages announces nothing', async () => {
    const existing = post(ADA, ADA.id, 'First light over the bay.', 30);
    server.use(postsHandler(ADA.id, page([existing])).handler);

    await renderWall();
    await screen.findByText(existing.body);
    expect(screen.queryByText(/new post/i)).not.toBeInTheDocument();

    socket.fire('wall:post-created', post(JONAS, ADA.id, 'Lovely picture.', 0));

    const announcement = await screen.findByText('New post from Jonas Lindqvist.');
    expect(announcement.closest('[role="status"]')).not.toBeNull();
  });

  it('B-111: the first post someone else writes on an empty wall is announced as well', async () => {
    server.use(postsHandler(ADA.id, page([])).handler);

    await renderWall();
    await screen.findByText('No posts yet.');
    expect(screen.queryByText(/new post/i)).not.toBeInTheDocument();

    socket.fire('wall:post-created', post(JONAS, ADA.id, 'First!', 0));

    const announcement = await screen.findByText('New post from Jonas Lindqvist.');
    expect(announcement.closest('[role="status"]')).not.toBeNull();
  });

  it("B-91: switching to another wall shows loading, never the previous wall's posts", async () => {
    const adaPost = post(ADA, ADA.id, "Only on Ada's wall.", 5);
    const jonasPost = post(JONAS, JONAS.id, "Only on Jonas's wall.", 5);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      postsHandler(ADA.id, page([adaPost])).handler,
      http.get(apiUrl('/users/3/posts'), async () => {
        await gate;
        return HttpResponse.json(page([jonasPost]));
      }),
    );

    function TwoProfiles() {
      const [owner, setOwner] = useState<typeof ADA | typeof JONAS>(ADA);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOwner(JONAS);
            }}
          >
            open Jonas
          </button>
          <Wall ownerId={owner.id} ownerFirstName={owner.firstName} canView canPost />
        </>
      );
    }
    const { store } = createTestStore();
    await signInAs(store);
    const { user } = renderWithProviders(<TwoProfiles />, { store });

    await screen.findByText(adaPost.body);
    await user.click(screen.getByRole('button', { name: 'open Jonas' }));

    expect(screen.queryByText(adaPost.body)).not.toBeInTheDocument();
    expect(screen.getByText('loading posts…')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: "write on Jonas's wall" })).toBeInTheDocument();
    release();
    expect(await screen.findByText(jonasPost.body)).toBeInTheDocument();
  });
});
