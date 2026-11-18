import type { Locator, Page, Request } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes } from './a11y.js';
import { expectStatus } from './fixtures/api.js';
import { socketHandshake } from './fixtures/socket.js';
import { befriend, expect, requestFriendship, test, type E2EUser } from './fixtures/test.js';
import {
  expectSameDocument,
  fullName,
  mainNav,
  markDocument,
  openHeaderPanelIfCollapsed,
  wholeName,
} from './fixtures/ui.js';

/**
 * Friendship journeys (FEATURES §6 "Friend button", §7 "Friends page"; BUILD-ORDER Phase 5 "friends + search"):
 * the friend button on a profile in every state (F-45, F-49–F-53), the three lists on `/friends` (F-54–F-57) and
 * the request badge in the navigation (F-52). Every user is registered fresh through the API, and preconditions that
 * are not the subject of a test (an existing request, an accepted friendship) are made through the API as well, so a
 * test only clicks what it proves. Assertions look for the test's own people, never for counts of other data.
 */

/** `ApiError.message` for a request without any response (apps/web/src/shared/api/problem.ts, `network`). */
const NETWORK_ERROR = 'The server could not be reached. Check your connection and try again.';

/** The 409 `friendship-exists` sentence (same file). */
const FRIENDSHIP_EXISTS = 'There is already a friend request between you two.';

const FRIENDSHIPS_PATH = '/api/friendships';

function isFriendshipRequest(request: Request, method: string): boolean {
  return request.method() === method && new URL(request.url()).pathname === FRIENDSHIPS_PATH;
}

/** The live region beside the "friends" link that holds the incoming-request count (F-52). */
function requestBadge(page: Page): Locator {
  return mainNav(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: wholeName('friends') }) })
    .getByRole('status');
}

/** The badge shows `count` and is read as "n friend request(s)"; with no request it is empty (F-52). */
async function expectRequestBadge(page: Page, count: number): Promise<void> {
  await openHeaderPanelIfCollapsed(page);
  const badge = requestBadge(page);
  if (count === 0) {
    await expect(badge).toBeEmpty();
    return;
  }
  await expect(badge.getByText(String(count), { exact: true })).toBeVisible();
  const spoken = `${String(count)} ${count === 1 ? 'friend request' : 'friend requests'}`;
  await expect(badge.getByText(spoken, { exact: true })).toBeAttached();
}

/**
 * Opens `path` and waits until the page's socket is connected: the Socket.IO CONNECT acknowledgement (`40…`) comes
 * after the handshake middleware put the socket into the user's room (socket-auth.ts), so from then on every
 * `friendship:changed` for this user reaches the page. Without the wait an event sent right after the page loaded
 * could arrive before the socket exists, and a real-time assertion would test a race.
 */
async function openWithRealtime(page: Page, path: string): Promise<void> {
  const connected = socketHandshake(page);
  await page.goto(path);
  await connected;
}

async function openProfile(page: Page, user: E2EUser): Promise<void> {
  await openWithRealtime(page, `/users/${String(user.id)}`);
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: fullName(user) })).toBeVisible();
}

async function openFriendsPage(page: Page): Promise<void> {
  await openWithRealtime(page, '/friends');
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: wholeName('friends') })).toBeVisible();
}

/** A friend button on a profile page, by its whole visible label ("add friend", "cancel request", …). */
function profileButton(page: Page, label: string): Locator {
  return page.getByRole('main').getByRole('button', { name: wholeName(label) });
}

/** One of the three lists on `/friends` ("friend requests", "friends", "sent requests"). */
function friendSection(page: Page, title: string): Locator {
  return page.getByRole('main').getByRole('region', { name: wholeName(title) });
}

function friendRow(section: Locator, user: E2EUser): Locator {
  return section.getByRole('listitem').filter({ has: section.page().getByRole('link', { name: fullName(user) }) });
}

/** A row action by its accessible name, which adds the person to the visible verb ("accept request from …"). */
function rowButton(section: Locator, label: string): Locator {
  return section.getByRole('button', { name: wholeName(label) });
}

/** What the server says about `viewer` and `other` (`GET /api/users/:id`, `relationship.state`). */
async function expectRelationship(viewer: E2EUser, other: E2EUser, state: string): Promise<void> {
  const path = `/api/users/${String(other.id)}`;
  const response = await viewer.api.get(path);
  await expectStatus(response, 200, `GET ${path} as ${String(viewer.id)}`);
  expect(await response.json()).toMatchObject({ relationship: { state } });
}

/** The ids in each of the viewer's three lists (`GET /api/friendships`). */
async function friendshipLists(
  viewer: E2EUser,
): Promise<{ friends: number[]; incoming: number[]; outgoing: number[] }> {
  const response = await viewer.api.get(FRIENDSHIPS_PATH);
  await expectStatus(response, 200, `GET ${FRIENDSHIPS_PATH} as ${String(viewer.id)}`);
  const body: unknown = await response.json();
  const ids = (key: string): number[] => {
    const list: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, key) : undefined;
    if (!Array.isArray(list)) throw new Error(`GET ${FRIENDSHIPS_PATH}: "${key}" is not a list`);
    return list.map((entry: unknown) => {
      const user: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'user') : undefined;
      const id: unknown = typeof user === 'object' && user !== null ? Reflect.get(user, 'id') : undefined;
      if (typeof id !== 'number') throw new Error(`GET ${FRIENDSHIPS_PATH}: an entry in "${key}" has no user id`);
      return id;
    });
  };
  return { friends: ids('friends'), incoming: ids('incoming'), outgoing: ids('outgoing') };
}

/** The toast on `/friends` that says what an action did; it sits in a polite live region. */
async function expectToast(page: Page, message: string): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible();
}

test.describe('friend button on a profile', () => {
  test('F-45: the button follows the server state through every step, live on both profiles', async ({
    createUser,
    pageAs,
  }) => {
    const ana = await createUser({ firstName: 'Ana' });
    const ben = await createUser({ firstName: 'Ben' });
    const anaPage = await pageAs(ana);
    const benPage = await pageAs(ben);
    await openProfile(anaPage, ben);
    await openProfile(benPage, ana);

    // none → pending_outgoing for Ana, pending_incoming for Ben, who sees it without a reload.
    await expect(profileButton(benPage, 'add friend')).toBeVisible();
    await profileButton(anaPage, 'add friend').click();
    await expect(profileButton(anaPage, 'cancel request')).toBeEnabled();
    await expect(anaPage.getByRole('main').getByText(`Friend request sent to ${fullName(ben)}.`)).toBeAttached();
    await expect(profileButton(benPage, 'accept request')).toBeVisible();
    await expect(profileButton(benPage, 'decline')).toBeVisible();
    await expect(profileButton(benPage, 'add friend')).toHaveCount(0);

    // Cancelling returns both profiles to none.
    await profileButton(anaPage, 'cancel request').click();
    await expect(profileButton(anaPage, 'add friend')).toBeEnabled();
    await expect(profileButton(benPage, 'add friend')).toBeVisible();
    await expectRelationship(ana, ben, 'none');
    await expectRelationship(ben, ana, 'none');

    // A new request, accepted by Ben: friends on both profiles.
    await profileButton(anaPage, 'add friend').click();
    await expect(profileButton(anaPage, 'cancel request')).toBeVisible();
    await profileButton(benPage, 'accept request').click();
    await expect(profileButton(benPage, 'unfriend')).toBeEnabled();
    await expect(profileButton(benPage, 'decline')).toHaveCount(0);
    await expect(profileButton(anaPage, 'unfriend')).toBeVisible();

    // The label is the server's state, not a client guess: a reload shows the same.
    await anaPage.reload();
    await expect(profileButton(anaPage, 'unfriend')).toBeVisible();
    await expectRelationship(ana, ben, 'friends');
    await expectRelationship(ben, ana, 'friends');

    await expectNoA11yViolations(anaPage);
    await expectNoA11yViolations(benPage);
  });

  test('F-49, B-27: the receiver declines a request on the profile', async ({ createUser, pageAs }) => {
    const ana = await createUser({ firstName: 'Ana' });
    const ben = await createUser({ firstName: 'Ben' });
    await requestFriendship(ana, ben);
    const anaPage = await pageAs(ana);
    const benPage = await pageAs(ben);
    await openProfile(anaPage, ben);
    await openProfile(benPage, ana);
    await expect(profileButton(anaPage, 'cancel request')).toBeVisible();

    await profileButton(benPage, 'decline').click();

    // The declined request is gone for both; the focus that sat on "decline" moved to the remaining button.
    const addFriend = profileButton(benPage, 'add friend');
    await expect(addFriend).toBeEnabled();
    await expect(addFriend).toBeFocused();
    await expect(profileButton(benPage, 'decline')).toHaveCount(0);
    await expect(profileButton(anaPage, 'add friend')).toBeVisible();
    await expectRelationship(ben, ana, 'none');
    await expectRelationship(ana, ben, 'none');

    await expectNoA11yViolations(benPage);
  });

  test('F-50: unfriending asks for confirmation, and only "unfriend" in the dialog ends the friendship', async ({
    createUser,
    pageAs,
  }) => {
    const ana = await createUser({ firstName: 'Ana' });
    const ben = await createUser({ firstName: 'Ben' });
    await befriend(ana, ben);
    const page = await pageAs(ana);
    await openProfile(page, ben);
    const dialog = page.getByRole('alertdialog', { name: `Unfriend ${fullName(ben)}?` });

    // "cancel" keeps the friendship; focus starts on it, the least destructive choice.
    await profileButton(page, 'unfriend').click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('You will no longer see each other’s walls.');
    const cancel = dialog.getByRole('button', { name: wholeName('cancel') });
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(dialog).toBeHidden();
    await expect(profileButton(page, 'unfriend')).toBeVisible();
    await expectRelationship(ana, ben, 'friends');

    // Escape keeps it too.
    await profileButton(page, 'unfriend').click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(profileButton(page, 'unfriend')).toBeVisible();
    await expectRelationship(ana, ben, 'friends');

    // Confirming ends it for both people.
    await profileButton(page, 'unfriend').click();
    await expectNoA11yViolations(page);
    await dialog.getByRole('button', { name: wholeName('unfriend') }).click();
    await expect(dialog).toBeHidden();
    await expect(profileButton(page, 'add friend')).toBeEnabled();
    await expectRelationship(ana, ben, 'none');
    await expectRelationship(ben, ana, 'none');

    await expectNoA11yViolations(page);
  });

  test('F-51, B-95: a double click sends one request, and the button is disabled while it runs', async ({
    createUser,
    pageAs,
  }) => {
    const ana = await createUser({ firstName: 'Ana' });
    const ben = await createUser({ firstName: 'Ben' });
    const page = await pageAs(ana);
    await openProfile(page, ben);

    const sent: Request[] = [];
    page.on('request', (request) => {
      if (isFriendshipRequest(request, 'POST')) sent.push(request);
    });
    // Hold the request at the network layer, so the in-flight state can be observed for as long as needed.
    const gate = Promise.withResolvers<undefined>();
    await page.route(`**${FRIENDSHIPS_PATH}`, async (route) => {
      if (route.request().method() === 'POST') await gate.promise;
      await route.continue();
    });

    const addFriend = profileButton(page, 'add friend');
    await addFriend.dblclick();
    await expect(addFriend).toBeDisabled();
    await expect(addFriend).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => sent.length).toBe(1);

    gate.resolve(undefined);
    await expect(profileButton(page, 'cancel request')).toBeEnabled();
    expect(sent).toHaveLength(1);
    expect(await friendshipLists(ben)).toEqual({ friends: [], incoming: [ana.id], outgoing: [] });

    await expectNoA11yViolations(page);
  });

  test('F-51: requests both people send at the same moment leave exactly one pending request', async ({
    createUser,
    pageAs,
  }) => {
    const ana = await createUser({ firstName: 'Ana' });
    const ben = await createUser({ firstName: 'Ben' });
    const anaPage = await pageAs(ana);
    const benPage = await pageAs(ben);
    await openProfile(anaPage, ben);
    await openProfile(benPage, ana);

    // Both clicks happen first; then both requests are let through together, so they race at the server.
    let held = 0;
    const gate = Promise.withResolvers<undefined>();
    for (const page of [anaPage, benPage]) {
      await page.route(`**${FRIENDSHIPS_PATH}`, async (route) => {
        if (route.request().method() === 'POST') {
          held += 1;
          await gate.promise;
        }
        await route.continue();
      });
    }
    const anaAnswer = anaPage.waitForResponse((response) => isFriendshipRequest(response.request(), 'POST'));
    const benAnswer = benPage.waitForResponse((response) => isFriendshipRequest(response.request(), 'POST'));
    await profileButton(anaPage, 'add friend').click();
    await profileButton(benPage, 'add friend').click();
    await expect.poll(() => held, { message: 'both requests are held' }).toBe(2);
    gate.resolve(undefined);

    const [anaStatus, benStatus] = [(await anaAnswer).status(), (await benAnswer).status()];
    expect([anaStatus, benStatus].toSorted((a, b) => a - b)).toEqual([201, 409]);
    const [sender, receiver] = anaStatus === 201 ? [ana, ben] : [ben, ana];
    const [senderPage, receiverPage] = anaStatus === 201 ? [anaPage, benPage] : [benPage, anaPage];

    // One row: the winner's request. The other side is told why and shows the request it received instead.
    expect(await friendshipLists(sender)).toEqual({ friends: [], incoming: [], outgoing: [receiver.id] });
    expect(await friendshipLists(receiver)).toEqual({ friends: [], incoming: [sender.id], outgoing: [] });
    await expect(profileButton(senderPage, 'cancel request')).toBeVisible();
    await expect(receiverPage.getByRole('main').getByText(FRIENDSHIP_EXISTS)).toBeVisible();
    await expect(profileButton(receiverPage, 'accept request')).toBeEnabled();
    await expect(profileButton(receiverPage, 'decline')).toBeVisible();

    await expectNoA11yViolations(receiverPage);
  });

  test('F-53: a failed request shows the error, and the button keeps its state until a retry succeeds', async ({
    createUser,
    pageAs,
  }) => {
    const ana = await createUser({ firstName: 'Ana' });
    const ben = await createUser({ firstName: 'Ben' });
    const page = await pageAs(ana);
    await openProfile(page, ben);

    await page.route(`**${FRIENDSHIPS_PATH}`, (route) =>
      route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
    );
    await profileButton(page, 'add friend').click();
    const error = page.getByRole('main').getByText(NETWORK_ERROR);
    await expect(error).toBeVisible();
    await expect(profileButton(page, 'add friend')).toBeEnabled();
    await expect(profileButton(page, 'cancel request')).toHaveCount(0);
    await expectRelationship(ana, ben, 'none');
    await expectNoA11yViolations(page);

    await page.unroute(`**${FRIENDSHIPS_PATH}`);
    await profileButton(page, 'add friend').click();
    await expect(profileButton(page, 'cancel request')).toBeEnabled();
    await expect(error).toBeHidden();
    await expectRelationship(ana, ben, 'pending_outgoing');

    await expectNoA11yViolations(page);
  });

  test('F-53: a failed unfriend keeps the dialog open with the error, and the friendship stays', async ({
    createUser,
    pageAs,
  }) => {
    const ana = await createUser({ firstName: 'Ana' });
    const ben = await createUser({ firstName: 'Ben' });
    await befriend(ana, ben);
    const page = await pageAs(ana);
    await openProfile(page, ben);
    await page.route(`**${FRIENDSHIPS_PATH}/${String(ben.id)}`, (route) =>
      route.request().method() === 'DELETE' ? route.abort('failed') : route.continue(),
    );

    await profileButton(page, 'unfriend').click();
    const dialog = page.getByRole('alertdialog', { name: `Unfriend ${fullName(ben)}?` });
    const confirm = dialog.getByRole('button', { name: wholeName('unfriend') });
    await confirm.click();
    await expect(dialog.getByText(NETWORK_ERROR)).toBeVisible();
    await expect(confirm).toBeEnabled();
    await expectNoA11yViolations(page);

    await dialog.getByRole('button', { name: wholeName('cancel') }).click();
    await expect(dialog).toBeHidden();
    await expect(profileButton(page, 'unfriend')).toBeEnabled();
    await expectRelationship(ana, ben, 'friends');

    await expectNoA11yViolations(page);
  });
});

test.describe('friends page', () => {
  test('F-54, F-56: a new user sees the three lists, each with its empty state', async ({ userPage }) => {
    await openFriendsPage(userPage);

    const requests = friendSection(userPage, 'friend requests');
    const friends = friendSection(userPage, 'friends');
    const sent = friendSection(userPage, 'sent requests');
    await expect(requests).toContainText('No friend requests right now.');
    await expect(requests).toContainText('When someone sends you a friend request, it appears here.');
    await expect(friends).toContainText('You have not added any friends yet.');
    await expect(friends).toContainText('Use the search in the header to find people you know.');
    await expect(sent).toContainText('No sent requests.');
    await expect(sent).toContainText('Requests you send wait here until they are answered.');
    for (const section of [requests, friends, sent]) {
      await expect(section.getByRole('listitem')).toHaveCount(0);
    }
    await expectRequestBadge(userPage, 0);

    await expectNoA11yViolationsInBothSchemes(userPage);
  });

  test('F-54, B-93: every entry shows avatar and name, links to the profile and has the actions of its list', async ({
    createUser,
    pageAs,
  }) => {
    const me = await createUser({ firstName: 'Mara' });
    const fiona = await createUser({ firstName: 'Fiona' });
    const ivo = await createUser({ firstName: 'Ivo' });
    const olga = await createUser({ firstName: 'Olga' });
    await befriend(me, fiona);
    await requestFriendship(ivo, me);
    await requestFriendship(me, olga);
    const page = await pageAs(me);
    await openFriendsPage(page);

    const lists = [
      {
        section: friendSection(page, 'friends'),
        person: fiona,
        meta: 'friends since',
        count: '1 friend',
        actions: [`unfriend ${fullName(fiona)}`],
      },
      {
        section: friendSection(page, 'friend requests'),
        person: ivo,
        meta: 'request received',
        count: '1 request',
        actions: [`accept request from ${fullName(ivo)}`, `decline request from ${fullName(ivo)}`],
      },
      {
        section: friendSection(page, 'sent requests'),
        person: olga,
        meta: 'request sent',
        count: '1 request',
        actions: [`cancel request to ${fullName(olga)}`],
      },
    ];
    for (const { section, person, meta, count, actions } of lists) {
      await expect(section.getByRole('listitem')).toHaveCount(1);
      await expect(section).toContainText(count);
      const row = friendRow(section, person);
      await expect(row.getByRole('img', { name: `${fullName(person)}'s profile picture` })).toBeVisible();
      await expect(row.getByRole('link', { name: fullName(person) })).toHaveAttribute(
        'href',
        `/users/${String(person.id)}`,
      );
      await expect(row).toContainText(meta);
      await expect(row.getByRole('button')).toHaveCount(actions.length);
      for (const action of actions) {
        await expect(rowButton(section, action)).toBeEnabled();
      }
    }
    await expectRequestBadge(page, 1);
    await expectNoA11yViolationsInBothSchemes(page);

    // The name is a real link into the app: the profile opens without a reload.
    const marker = await markDocument(page);
    await friendRow(friendSection(page, 'friend requests'), ivo)
      .getByRole('link', { name: fullName(ivo) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/users/${String(ivo.id)}$`));
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: fullName(ivo) })).toBeVisible();
    await expect(profileButton(page, 'accept request')).toBeVisible();
    await expectSameDocument(page, marker);

    await expectNoA11yViolations(page);
  });

  test('F-55, F-49, B-27: accept, decline, cancel and unfriend update the lists without a reload', async ({
    createUser,
    pageAs,
  }) => {
    const me = await createUser({ firstName: 'Mara' });
    const fiona = await createUser({ firstName: 'Fiona' });
    const ivo = await createUser({ firstName: 'Ivo' });
    const dora = await createUser({ firstName: 'Dora' });
    const olga = await createUser({ firstName: 'Olga' });
    await befriend(me, fiona);
    await requestFriendship(ivo, me);
    await requestFriendship(dora, me);
    await requestFriendship(me, olga);
    const page = await pageAs(me);
    await openFriendsPage(page);
    const marker = await markDocument(page);
    await expectRequestBadge(page, 2);

    const requests = friendSection(page, 'friend requests');
    const friends = friendSection(page, 'friends');
    const sent = friendSection(page, 'sent requests');

    // Accept: the request moves from "friend requests" to "friends".
    await rowButton(requests, `accept request from ${fullName(ivo)}`).click();
    await expect(friendRow(friends, ivo)).toBeVisible();
    await expect(friendRow(requests, ivo)).toHaveCount(0);
    await expect(friendRow(requests, dora)).toBeVisible();
    await expectToast(page, `You and ${fullName(ivo)} are now friends.`);
    await expectRequestBadge(page, 1);

    // Decline: the last request leaves, the empty state shows, and focus lands on the list's heading.
    await rowButton(requests, `decline request from ${fullName(dora)}`).click();
    await expect(friendRow(requests, dora)).toHaveCount(0);
    await expect(requests).toContainText('No friend requests right now.');
    await expect(requests.getByRole('heading', { name: wholeName('friend requests') })).toBeFocused();
    await expectToast(page, `Friend request from ${fullName(dora)} declined.`);
    await expectRequestBadge(page, 0);

    // Cancel a sent request.
    await rowButton(sent, `cancel request to ${fullName(olga)}`).click();
    await expect(friendRow(sent, olga)).toHaveCount(0);
    await expect(sent).toContainText('No sent requests.');

    // Unfriend asks first (F-50), then removes the row.
    await rowButton(friends, `unfriend ${fullName(fiona)}`).click();
    const dialog = page.getByRole('alertdialog', { name: `Unfriend ${fullName(fiona)}?` });
    await dialog.getByRole('button', { name: wholeName('unfriend') }).click();
    await expect(dialog).toBeHidden();
    await expect(friendRow(friends, fiona)).toHaveCount(0);
    await expect(friendRow(friends, ivo)).toBeVisible();

    await expectSameDocument(page, marker);
    expect(await friendshipLists(me)).toEqual({ friends: [ivo.id], incoming: [], outgoing: [] });
    await expectRelationship(dora, me, 'none');
    await expectRelationship(olga, me, 'none');
    await expectRelationship(fiona, me, 'none');

    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-52, F-57, B-92: a new request appears in the badge and the list in real time', async ({
    createUser,
    pageAs,
  }) => {
    const me = await createUser({ firstName: 'Mara' });
    const ben = await createUser({ firstName: 'Ben' });
    const cleo = await createUser({ firstName: 'Cleo' });
    const page = await pageAs(me);
    await openFriendsPage(page);
    const marker = await markDocument(page);
    const requests = friendSection(page, 'friend requests');
    await expect(requests).toContainText('No friend requests right now.');
    await expectRequestBadge(page, 0);

    await requestFriendship(ben, me);
    await expect(friendRow(requests, ben)).toBeVisible();
    await expectRequestBadge(page, 1);

    await requestFriendship(cleo, me);
    await expect(friendRow(requests, cleo)).toBeVisible();
    await expectRequestBadge(page, 2);

    // Ben withdraws his request elsewhere: it leaves the list and the badge.
    const withdrawal = await ben.api.delete(`${FRIENDSHIPS_PATH}/${String(me.id)}`);
    await expectStatus(withdrawal, 200, 'Ben cancels his request');
    await expect(friendRow(requests, ben)).toHaveCount(0);
    await expectRequestBadge(page, 1);

    await expectSameDocument(page, marker);
    await expectNoA11yViolations(page);
  });

  test('F-52: the badge counts requests on every page of the app, not only on /friends', async ({
    createUser,
    pageAs,
  }) => {
    const me = await createUser({ firstName: 'Mara' });
    const ben = await createUser({ firstName: 'Ben' });
    const page = await pageAs(me);
    await openWithRealtime(page, '/');
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: fullName(me) })).toBeVisible();
    const marker = await markDocument(page);
    await expectRequestBadge(page, 0);

    await requestFriendship(ben, me);
    await expectRequestBadge(page, 1);
    await expectSameDocument(page, marker);

    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-57: the lists are refetched when the page is opened and when a friendship event arrives', async ({
    createUser,
    pageAs,
  }) => {
    const me = await createUser({ firstName: 'Mara' });
    const cleo = await createUser({ firstName: 'Cleo' });
    await requestFriendship(me, cleo);
    const page = await pageAs(me);
    await openFriendsPage(page);
    const marker = await markDocument(page);
    const friends = friendSection(page, 'friends');
    const sent = friendSection(page, 'sent requests');
    await expect(friendRow(sent, cleo)).toBeVisible();

    // Cleo accepts elsewhere: the request moves to "friends" on this open page.
    const accepted = await cleo.api.post(`${FRIENDSHIPS_PATH}/${String(me.id)}/accept`);
    await expectStatus(accepted, 200, 'Cleo accepts the request');
    await expect(friendRow(friends, cleo)).toBeVisible();
    await expect(friendRow(sent, cleo)).toHaveCount(0);
    await expect(sent).toContainText('No sent requests.');

    // Leaving and opening the page again inside the app asks the server again, although the badge keeps the cache.
    await openHeaderPanelIfCollapsed(page);
    await mainNav(page)
      .getByRole('link', { name: wholeName('profile') })
      .click();
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: fullName(me) })).toBeVisible();
    const refetch = page.waitForRequest((request) => isFriendshipRequest(request, 'GET'));
    await openHeaderPanelIfCollapsed(page);
    await mainNav(page)
      .getByRole('link', { name: wholeName('friends') })
      .click();
    await refetch;
    await expect(page).toHaveURL(/\/friends$/);
    await expect(friendRow(friendSection(page, 'friends'), cleo)).toBeVisible();
    await expectSameDocument(page, marker);

    await expectNoA11yViolations(page);
  });

  test('F-53: a failed list action shows an error toast and keeps the entry', async ({ createUser, pageAs }) => {
    const me = await createUser({ firstName: 'Mara' });
    const ben = await createUser({ firstName: 'Ben' });
    await requestFriendship(ben, me);
    const page = await pageAs(me);
    await openFriendsPage(page);
    await page.route(`**${FRIENDSHIPS_PATH}/${String(ben.id)}`, (route) =>
      route.request().method() === 'DELETE' ? route.abort('failed') : route.continue(),
    );

    const requests = friendSection(page, 'friend requests');
    const decline = rowButton(requests, `decline request from ${fullName(ben)}`);
    await decline.click();
    // An error toast sits in the assertive live region and stays until it is dismissed.
    await expect(page.getByRole('alert').filter({ hasText: NETWORK_ERROR })).toBeVisible();
    await expect(friendRow(requests, ben)).toBeVisible();
    await expect(decline).toBeEnabled();
    await expectRequestBadge(page, 1);
    await expectRelationship(me, ben, 'pending_incoming');

    await expectNoA11yViolations(page);
  });
});
