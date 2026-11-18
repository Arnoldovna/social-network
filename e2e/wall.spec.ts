import { randomUUID } from 'node:crypto';

import type { APIResponse, Locator, Page } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes } from './a11y.js';
import { expectStatus, isRecord, uploadAvatar } from './fixtures/api.js';
import { befriend, expect, requestFriendship, test, type E2EUser } from './fixtures/test.js';
import { escapeRegExp, fullName, uniqueText } from './fixtures/ui.js';

/**
 * Wall journeys (FEATURES §9: F-65, F-66, F-69–F-75; BUGS B-21, B-22, B-23, B-40, B-83) against the production stack
 * behind nginx. Every test registers its own users (ADR-0016), so each wall here belongs to this test alone and its
 * post counts are this test's own posts. Posts that set up a journey are written through the real API; the journey
 * itself goes through the UI.
 *
 * Real-time checks wait for the server's acknowledgement of `wall:join` (read from the page's WebSocket frames) before
 * another user posts, so "the post appears without a reload" never races the room join.
 */

// Absolute timestamps are checked in a fixed zone and locale, so the expected text does not depend on the host.
const TIME_ZONE = 'UTC';
test.use({ timezoneId: TIME_ZONE, locale: 'en-GB' });

const PAGE_SIZE = 20; // PAGE_LIMIT_DEFAULT in packages/shared (F-70)

/** `WallPost` from packages/shared (API.md §1), restated because the root workspace does not depend on it. */
interface WallPostDto {
  id: number;
  wallOwnerId: number;
  author: { id: number; firstName: string; lastName: string; avatarUrl: string | null };
  body: string;
  createdAt: string;
}

function parseWallPost(value: unknown, step: string): WallPostDto {
  const post = isRecord(value) ? value['post'] : undefined;
  const author = isRecord(post) ? post['author'] : undefined;
  if (
    isRecord(post) &&
    isRecord(author) &&
    typeof post['id'] === 'number' &&
    typeof post['wallOwnerId'] === 'number' &&
    typeof post['body'] === 'string' &&
    typeof post['createdAt'] === 'string' &&
    typeof author['id'] === 'number' &&
    typeof author['firstName'] === 'string' &&
    typeof author['lastName'] === 'string' &&
    (author['avatarUrl'] === null || typeof author['avatarUrl'] === 'string')
  ) {
    return {
      id: post['id'],
      wallOwnerId: post['wallOwnerId'],
      body: post['body'],
      createdAt: post['createdAt'],
      author: {
        id: author['id'],
        firstName: author['firstName'],
        lastName: author['lastName'],
        avatarUrl: author['avatarUrl'],
      },
    };
  }
  throw new Error(`${step}: response does not match the WallPost contract: ${JSON.stringify(value)}`);
}

/** `POST /api/users/:id/posts` as `author` (with the author's CSRF token): the stored post (B-41). */
async function writePost(author: E2EUser, ownerId: number, body: string): Promise<WallPostDto> {
  const step = `POST /api/users/${String(ownerId)}/posts (by ${String(author.id)})`;
  const response = await author.api.post(`/api/users/${String(ownerId)}/posts`, { body });
  await expectStatus(response, 201, step);
  return parseWallPost(await response.json(), step);
}

/** An RFC 9457 problem with the given status and code (`type` ends in `:problem:<code>`, ADR-0004). */
async function expectProblem(response: APIResponse, status: number, code: string): Promise<void> {
  expect(response.status(), await response.text()).toBe(status);
  expect(response.headers()['content-type']).toContain('application/problem+json');
  const problem: unknown = await response.json();
  expect(problem).toMatchObject({ status, type: expect.stringMatching(new RegExp(`:problem:${code}$`, 'u')) });
}

/** Matches `text` literally anywhere in an element's text (for `toHaveText` on a list of posts). */
function containing(text: string): RegExp {
  return new RegExp(escapeRegExp(text), 'u');
}

function profileUrl(user: E2EUser): string {
  return `/users/${String(user.id)}`;
}

/** The wall section of a profile page (`<section aria-labelledby>` with the heading "wall"). */
function wallOf(page: Page): Locator {
  return page.getByRole('region', { name: 'wall', exact: true });
}

/** The post (`<article>`) on this wall whose text contains `body`. */
function postIn(wall: Locator, body: string): Locator {
  return wall.getByRole('article').filter({ hasText: body });
}

/** The composer's textarea, found by its visible label (F-75). */
function composerOf(page: Page, ownerFirstName: string): Locator {
  return page.getByRole('textbox', { name: `write on ${ownerFirstName}'s wall`, exact: true });
}

/** Opens a profile page and waits until its header shows whose it is. */
async function openProfile(page: Page, path: string, owner: E2EUser): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: fullName(owner) })).toBeVisible();
}

/** "18 Nov 2026, 14:05" in TIME_ZONE: the absolute form the `<time>` title carries (F-69, F-108). */
function absoluteDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: TIME_ZONE,
  }).format(new Date(iso));
}

/**
 * Socket.IO packets of type EVENT (`42<ackId>[...]`) and ACK (`43<ackId>[...]`) on the default namespace, as
 * socket.io-client writes them with its default JSON parser (ADR-0008).
 */
function parseAckedPacket(payload: string | Buffer, type: '42' | '43'): { ackId: string; args: unknown[] } | null {
  if (typeof payload !== 'string' || !payload.startsWith(type)) return null;
  const match = /^\d{2}(\d+)(\[[\s\S]*\])$/.exec(payload);
  if (!match?.[1] || !match[2]) return null;
  const args: unknown = JSON.parse(match[2]);
  return Array.isArray(args) ? { ackId: match[1], args } : null;
}

/**
 * Records which walls the page's sockets are currently joined to, as acknowledged by the server (`wall:join` answered
 * `{ ok: true }`, minus later `wall:leave`). Call it before the page navigates, so the first socket is seen too.
 */
function watchWallRooms(page: Page): { isJoined: (ownerId: number) => boolean } {
  const joined = new Set<number>();
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.startsWith('/socket.io/')) return;
    const pendingJoins = new Map<string, number>(); // ack ids restart per socket
    socket.on('framesent', ({ payload }) => {
      const packet = parseAckedPacket(payload, '42');
      const [event, room] = packet?.args ?? [];
      if (!packet || !isRecord(room) || typeof room['userId'] !== 'number') return;
      if (event === 'wall:join') pendingJoins.set(packet.ackId, room['userId']);
      if (event === 'wall:leave') joined.delete(room['userId']);
    });
    socket.on('framereceived', ({ payload }) => {
      const packet = parseAckedPacket(payload, '43');
      const ownerId = packet ? pendingJoins.get(packet.ackId) : undefined;
      if (!packet || ownerId === undefined) return;
      pendingJoins.delete(packet.ackId);
      const [ack] = packet.args;
      if (isRecord(ack) && ack['ok'] === true) joined.add(ownerId);
    });
    socket.on('close', () => {
      joined.clear(); // rooms do not survive a reconnect; the client joins again on `connect`
    });
  });
  return { isJoined: (ownerId) => joined.has(ownerId) };
}

async function expectInRoom(rooms: ReturnType<typeof watchWallRooms>, owner: E2EUser): Promise<void> {
  await expect
    .poll(() => rooms.isJoined(owner.id), { message: `the server acknowledged wall:join for user ${String(owner.id)}` })
    .toBe(true);
}

test.describe('wall', () => {
  test('F-65: only the owner and accepted friends can read a wall; everyone else is asked to become friends', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const friend = await createUser({ firstName: 'Ada' });
    const stranger = await createUser({ firstName: 'Tom' });
    await befriend(owner, friend);
    const body = uniqueText('only for friends');
    await writePost(owner, owner.id, body);

    // An accepted friend reads the wall.
    const friendPage = await pageAs(friend);
    await openProfile(friendPage, profileUrl(owner), owner);
    await expect(postIn(wallOf(friendPage), body)).toBeVisible();

    // A stranger with a pending request is still a stranger: the wall says how to get access and asks for nothing.
    await requestFriendship(stranger, owner);
    const strangerPage = await pageAs(stranger);
    const postRequests: string[] = [];
    strangerPage.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/users/${String(owner.id)}/posts`) postRequests.push(request.url());
    });
    await openProfile(strangerPage, profileUrl(owner), owner);
    const lockedWall = wallOf(strangerPage);
    await expect(lockedWall.getByText('Become friends with Mira to see their wall.', { exact: true })).toBeVisible();
    await expect(lockedWall.getByRole('article')).toHaveCount(0);
    await expect(lockedWall.getByText(body)).toHaveCount(0);
    await expect(lockedWall.getByText('No posts yet.')).toHaveCount(0);
    await expect(composerOf(strangerPage, 'Mira')).toHaveCount(0);
    expect(postRequests, 'a wall without read access requests no posts').toEqual([]);
    await expectNoA11yViolationsInBothSchemes(strangerPage);

    // Once the owner accepts, the same visitor reads the wall.
    const accept = await owner.api.post(`/api/friendships/${String(stranger.id)}/accept`);
    await expectStatus(accept, 200, 'accept the friend request');
    await strangerPage.reload();
    await expect(postIn(wallOf(strangerPage), body)).toBeVisible();
    await expect(lockedWall.getByText('Become friends with Mira to see their wall.')).toHaveCount(0);
    await expectNoA11yViolations(strangerPage);
  });

  test('F-66: the owner writes on their own wall and an accepted friend writes on it too', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const friend = await createUser({ firstName: 'Ada' });
    await befriend(owner, friend);

    const ownerPage = await pageAs(owner);
    await openProfile(ownerPage, '/', owner);
    const ownBody = uniqueText('my own wall');
    await composerOf(ownerPage, 'Mira').fill(ownBody);
    await wallOf(ownerPage).getByRole('button', { name: 'post', exact: true }).click();
    const ownPost = postIn(wallOf(ownerPage), ownBody);
    await expect(ownPost).toBeVisible();
    await expect(ownPost.getByRole('heading', { name: fullName(owner) })).toBeVisible();
    await expect(ownerPage.getByRole('status').filter({ hasText: 'Your post is on the wall.' })).toBeAttached();

    const friendPage = await pageAs(friend);
    await openProfile(friendPage, profileUrl(owner), owner);
    const friendBody = uniqueText('hello from a friend');
    await composerOf(friendPage, 'Mira').fill(friendBody);
    await wallOf(friendPage).getByRole('button', { name: 'post', exact: true }).click();
    const friendPost = postIn(wallOf(friendPage), friendBody);
    await expect(friendPost).toBeVisible();
    await expect(friendPost.getByRole('heading', { name: fullName(friend) })).toBeVisible();
    await expect(composerOf(friendPage, 'Mira')).toHaveValue('');

    // Both posts are stored on the owner's wall, newest first.
    await friendPage.reload();
    await expect(wallOf(friendPage).getByRole('article')).toHaveText([containing(friendBody), containing(ownBody)]);
    await expectNoA11yViolations(friendPage);
  });

  test('F-65, F-66, F-71, B-21, B-22, B-23: the server refuses strangers whatever the UI shows', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const friend = await createUser({ firstName: 'Ada' });
    const stranger = await createUser({ firstName: 'Tom' });
    await befriend(owner, friend);
    const ownerPost = await writePost(owner, owner.id, uniqueText('owner post'));
    const friendPost = await writePost(friend, owner.id, uniqueText('friend post'));
    const postsPath = `/api/users/${String(owner.id)}/posts`;

    // B-23: reading needs friendship; B-22: so does writing, with a valid session and CSRF token.
    await expectProblem(await stranger.api.get(postsPath), 403, 'wall-forbidden');
    await expectProblem(
      await stranger.api.post(postsPath, { body: uniqueText('sneaky') }),
      403,
      'wall-write-forbidden',
    );

    // B-21: only the author or the wall owner may delete; another friend of the owner may not either.
    await expectProblem(await stranger.api.delete(`/api/posts/${String(friendPost.id)}`), 403, 'post-delete-forbidden');
    await expectProblem(await friend.api.delete(`/api/posts/${String(ownerPost.id)}`), 403, 'post-delete-forbidden');

    // Mutations without the CSRF token are refused before any of that (F-23).
    await expectProblem(
      await friend.api.post(postsPath, { body: uniqueText('no token') }, { csrf: false }),
      403,
      'csrf-invalid',
    );
    await expectProblem(
      await friend.api.delete(`/api/posts/${String(friendPost.id)}`, { csrf: false }),
      403,
      'csrf-invalid',
    );

    // Nothing of the refused writes or deletes happened.
    const listing = await owner.api.get(postsPath);
    await expectStatus(listing, 200, `GET ${postsPath}`);
    expect(await listing.json()).toMatchObject({
      items: [
        { id: friendPost.id, body: friendPost.body },
        { id: ownerPost.id, body: ownerPost.body },
      ],
      nextCursor: null,
    });

    // And the stranger's page offers neither the posts nor a composer.
    const strangerPage = await pageAs(stranger);
    await openProfile(strangerPage, profileUrl(owner), owner);
    await expect(wallOf(strangerPage).getByText('Become friends with Mira to see their wall.')).toBeVisible();
    await expect(composerOf(strangerPage, 'Mira')).toHaveCount(0);
    await expectNoA11yViolations(strangerPage);
  });

  test('F-69: a post shows the author avatar, the linked name, the text and a relative time with the absolute date', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const friend = await createUser({ firstName: 'Ada' });
    await befriend(owner, friend);
    const avatarUrl = await uploadAvatar(friend);
    const body = uniqueText('a post with a face');
    const post = await writePost(friend, owner.id, body);

    // The viewer's clock is five minutes ahead of the post, so the relative label is predictable (B-99).
    const page = await pageAs(owner);
    await page.clock.setFixedTime(new Date(Date.parse(post.createdAt) + 5 * 60_000 + 10_000));
    await openProfile(page, '/', owner);
    const shown = postIn(wallOf(page), body);
    await expect(shown).toBeVisible();

    const avatar = shown.getByRole('img', { name: `${fullName(friend)}'s profile picture`, exact: true });
    await expect(avatar).toHaveAttribute('src', avatarUrl);
    await expect
      .poll(() => avatar.evaluate((element) => (element instanceof HTMLImageElement ? element.naturalWidth : 0)))
      .toBeGreaterThan(0);

    const time = shown.locator('time');
    await expect(time).toHaveText('5 minutes ago');
    await expect(time).toHaveAttribute('datetime', new Date(post.createdAt).toISOString());
    await expect(time).toHaveAttribute('title', absoluteDateTime(post.createdAt));
    await expect(shown.getByText(body, { exact: true })).toBeVisible();
    await expectNoA11yViolationsInBothSchemes(page);

    // The name links to the author's profile.
    await shown.getByRole('link', { name: fullName(friend), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/users/${String(friend.id)}$`, 'u'));
    await expect(page.getByRole('heading', { level: 1, name: fullName(friend) })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('F-70, B-73: posts are newest first, 20 per page, and "load older posts" brings the rest in order', async ({
    user,
    userPage,
  }) => {
    const total = PAGE_SIZE + 5;
    const tag = randomUUID().slice(0, 8);
    const bodies = Array.from({ length: total }, (_, index) => `post ${String(index + 1).padStart(2, '0')} ${tag}`);
    for (const body of bodies) {
      await writePost(user, user.id, body); // sequential: each one is newer than the one before
    }
    const newestFirst = [...bodies].reverse().map((body) => containing(body));

    await openProfile(userPage, '/', user);
    const wall = wallOf(userPage);
    await expect(wall.getByRole('article')).toHaveText(newestFirst.slice(0, PAGE_SIZE));
    const loadOlder = wall.getByRole('button', { name: 'load older posts' });
    await expect(loadOlder).toBeVisible();

    await loadOlder.click();
    await expect(wall.getByRole('article')).toHaveText(newestFirst);
    await expect(wall.getByRole('button', { name: /older posts/u })).toHaveCount(0);
    await expectNoA11yViolations(userPage);
  });

  test("F-71: the wall owner deletes a friend's post after confirming; cancelling keeps it", async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const friend = await createUser({ firstName: 'Ada' });
    await befriend(owner, friend);
    const keptBody = uniqueText('stays');
    const doomedBody = uniqueText('goes away');
    await writePost(owner, owner.id, keptBody);
    await writePost(friend, owner.id, doomedBody);

    const page = await pageAs(owner);
    await openProfile(page, '/', owner);
    const wall = wallOf(page);
    const doomed = postIn(wall, doomedBody);
    const deleteButton = doomed.getByRole('button', { name: `delete post by ${fullName(friend)}`, exact: true });

    // Cancel: nothing happens, focus goes back to the button.
    await deleteButton.click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete this post?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'cancel', exact: true })).toBeFocused();
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(doomed).toBeVisible();
    await expect(deleteButton).toBeFocused();

    // Confirm: the post is gone, focus lands on the wall heading and the deletion is announced.
    await deleteButton.click();
    await dialog.getByRole('button', { name: 'delete post', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(doomed).toHaveCount(0);
    await expect(postIn(wall, keptBody)).toBeVisible();
    await expect(wall.getByRole('heading', { name: 'wall', level: 2 })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Post deleted.' })).toBeAttached();

    // It is deleted on the server, not just hidden.
    await page.reload();
    await expect(postIn(wall, keptBody)).toBeVisible();
    await expect(postIn(wall, doomedBody)).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test('F-71, B-21: the delete button is shown only to the author and the wall owner', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const author = await createUser({ firstName: 'Ada' });
    const otherFriend = await createUser({ firstName: 'Tom' });
    await befriend(owner, author);
    await befriend(owner, otherFriend);
    const ownerBody = uniqueText('by the owner');
    const authorBody = uniqueText('by the author');
    await writePost(owner, owner.id, ownerBody);
    await writePost(author, owner.id, authorBody);

    // Another friend of the owner reads both posts but may delete neither.
    const otherPage = await pageAs(otherFriend);
    await openProfile(otherPage, profileUrl(owner), owner);
    await expect(postIn(wallOf(otherPage), authorBody)).toBeVisible();
    await expect(postIn(wallOf(otherPage), ownerBody)).toBeVisible();
    await expect(wallOf(otherPage).getByRole('button', { name: /^delete post/u })).toHaveCount(0);

    // The author may delete their own post, not the owner's.
    const authorPage = await pageAs(author);
    await openProfile(authorPage, profileUrl(owner), owner);
    const authorWall = wallOf(authorPage);
    await expect(postIn(authorWall, ownerBody).getByRole('button', { name: /^delete post/u })).toHaveCount(0);
    await postIn(authorWall, authorBody)
      .getByRole('button', { name: `delete post by ${fullName(author)}`, exact: true })
      .click();
    await authorPage
      .getByRole('alertdialog', { name: 'Delete this post?' })
      .getByRole('button', { name: 'delete post', exact: true })
      .click();
    await expect(postIn(authorWall, authorBody)).toHaveCount(0);
    await expect(postIn(authorWall, ownerBody)).toBeVisible();
    await expectNoA11yViolations(authorPage);
  });

  test('F-72, B-40: new and deleted posts reach viewers of that wall in real time, and only them', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const poster = await createUser({ firstName: 'Ada' });
    const viewer = await createUser({ firstName: 'Tom' }); // may read the owner's wall, but is looking at another one
    const otherOwner = await createUser({ firstName: 'Lena' });
    await befriend(owner, poster);
    await befriend(owner, viewer);
    await befriend(otherOwner, viewer);

    const ownerPage = await pageAs(owner);
    const ownerRooms = watchWallRooms(ownerPage);
    await openProfile(ownerPage, '/', owner);
    await expect(wallOf(ownerPage).getByText('No posts yet.')).toBeVisible();
    await expectInRoom(ownerRooms, owner);

    const viewerPage = await pageAs(viewer);
    const viewerRooms = watchWallRooms(viewerPage);
    await openProfile(viewerPage, profileUrl(otherOwner), otherOwner);
    await expectInRoom(viewerRooms, otherOwner);

    // A post on the owner's wall appears there without a reload and is announced politely (B-111).
    const liveBody = uniqueText('live on the wall');
    const livePost = await writePost(poster, owner.id, liveBody);
    await expect(postIn(wallOf(ownerPage), liveBody)).toBeVisible();
    await expect(
      ownerPage.getByRole('status').filter({ hasText: `New post from ${fullName(poster)}.` }),
    ).toBeAttached();

    // The viewer of another wall gets nothing. A later post on the wall they look at is the sync point: it arrives,
    // so the earlier one would have arrived before it if it had been sent to them (legacy B-40 put it on any wall).
    const markerBody = uniqueText('on the other wall');
    await writePost(otherOwner, otherOwner.id, markerBody);
    await expect(postIn(wallOf(viewerPage), markerBody)).toBeVisible();
    await expect(wallOf(viewerPage).getByText(liveBody)).toHaveCount(0);
    await expect(wallOf(viewerPage).getByRole('article')).toHaveCount(1);

    // A deletion disappears live as well.
    const deleted = await poster.api.delete(`/api/posts/${String(livePost.id)}`);
    await expectStatus(deleted, 204, 'delete the live post');
    await expect(postIn(wallOf(ownerPage), liveBody)).toHaveCount(0);
    await expect(wallOf(ownerPage).getByText('No posts yet.')).toBeVisible();
    await expectNoA11yViolations(ownerPage);
  });

  test('F-73, B-83: incoming posts never clear an unsent draft; only the own saved post does', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const friend = await createUser({ firstName: 'Ada' });
    await befriend(owner, friend);

    const page = await pageAs(owner);
    const rooms = watchWallRooms(page);
    await openProfile(page, '/', owner);
    await expectInRoom(rooms, owner);
    const composer = composerOf(page, 'Mira');
    const draft = uniqueText('half-written thought');
    await composer.fill(draft);

    const incoming = [uniqueText('incoming one'), uniqueText('incoming two')] as const;
    for (const body of incoming) {
      await writePost(friend, owner.id, body);
      await expect(postIn(wallOf(page), body)).toBeVisible();
    }
    await expect(composer).toHaveValue(draft);

    await wallOf(page).getByRole('button', { name: 'post', exact: true }).click();
    await expect(postIn(wallOf(page), draft)).toBeVisible();
    await expect(composer).toHaveValue('');
    await expect(wallOf(page).getByRole('article')).toHaveText([
      containing(draft),
      containing(incoming[1]),
      containing(incoming[0]),
    ]);
    await expectNoA11yViolations(page);
  });

  test('F-74: an empty wall says "No posts yet." and invites everyone who may post to write the first one', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Mira' });
    const friend = await createUser({ firstName: 'Ada' });
    await befriend(owner, friend);

    const friendPage = await pageAs(friend);
    await openProfile(friendPage, profileUrl(owner), owner);
    await expect(wallOf(friendPage).getByText('No posts yet.', { exact: true })).toBeVisible();
    await expect(wallOf(friendPage).getByText('Write the first one.', { exact: true })).toBeVisible();

    const ownerPage = await pageAs(owner);
    await openProfile(ownerPage, '/', owner);
    const wall = wallOf(ownerPage);
    await expect(wall.getByText('No posts yet.', { exact: true })).toBeVisible();
    await expect(wall.getByText('Write the first one.', { exact: true })).toBeVisible();
    await expectNoA11yViolations(ownerPage);

    // The first post replaces the empty state.
    const first = uniqueText('the first one');
    await composerOf(ownerPage, 'Mira').fill(first);
    await wall.getByRole('button', { name: 'post', exact: true }).click();
    await expect(postIn(wall, first)).toBeVisible();
    await expect(wall.getByText('No posts yet.')).toHaveCount(0);
    await expect(wall.getByText('Write the first one.')).toHaveCount(0);
    await expectNoA11yViolations(ownerPage);
  });

  test('F-75, B-104: the textarea has a visible label and Ctrl+Enter or Cmd+Enter submits it', async ({
    user,
    userPage,
  }) => {
    await openProfile(userPage, '/', user);
    const label = userPage.getByText(`write on ${user.firstName}'s wall`, { exact: true });
    await expect(label).toBeVisible();
    const composer = composerOf(userPage, user.firstName);
    const wall = wallOf(userPage);

    // Plain Enter is a line break, not a submit.
    const firstLine = uniqueText('first line');
    const secondLine = uniqueText('second line');
    await composer.fill(firstLine);
    await composer.press('Enter');
    await composer.pressSequentially(secondLine);
    await expect(composer).toHaveValue(`${firstLine}\n${secondLine}`);
    await expect(wall.getByRole('article')).toHaveCount(0);

    await composer.press('Control+Enter');
    const multiLine = postIn(wall, firstLine);
    await expect(multiLine).toBeVisible();
    await expect(multiLine).toContainText(secondLine);
    await expect(composer).toHaveValue('');
    await expect(composer).toBeFocused();

    const viaMeta = uniqueText('posted with cmd enter');
    await composer.fill(viaMeta);
    await composer.press('Meta+Enter');
    await expect(postIn(wall, viaMeta)).toBeVisible();
    await expect(composer).toHaveValue('');
    await expect(wall.getByRole('article')).toHaveCount(2);
    await expectNoA11yViolations(userPage);
  });
});
