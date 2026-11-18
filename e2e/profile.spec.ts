import type { Locator, Page, Request } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes } from './a11y.js';
import { expectStatus, isRecord, PROBLEM_TYPE_PREFIX, setBio, uploadAvatar } from './fixtures/api.js';
import { befriend, expect, test, type E2EUser } from './fixtures/test.js';
import { fullName, holdGets } from './fixtures/ui.js';

/**
 * Profile journeys (FEATURES §3 "Own profile and bio", §5 "Other user's profile"): F-24–F-32, F-40–F-42, F-44 and the
 * legacy bugs they close (B-55, B-77, B-78, B-82, B-98). Every test registers its own users through the real API and
 * asserts only on their content (ADR-0016), so the spec shares the e2e stack with the other phase-5 specs.
 *
 * Labels are matched as the UI writes them: buttons are lowercase ("add bio", "save"), messages sentence case
 * (FEATURES "Label casing").
 */

/** `BIO_MAX` in `packages/shared/src/user.ts` (F-29); restated because the root workspace does not depend on it. */
const BIO_MAX = 1000;
/** `ID_MAX` in `packages/shared/src/ids.ts`: a valid id no user of a fresh stack has (F-42). */
const ID_MAX = 2_147_483_647;

const NO_OWN_BIO = 'You have not written a bio yet.';
const NO_OTHER_BIO = 'No bio yet.';
const USER_MISSING = 'This user does not exist.';
const BIO_SAVED = 'Your bio was saved.';
const BIO_TOO_LONG = 'Keep your bio under 1,000 characters.';
/** `MESSAGES.internal` in `apps/web/src/shared/api/problem.ts`: what a 500 problem reads like (F-31). */
const SERVER_ERROR = 'Something went wrong on our side. Please try again.';
/** Every label the friend button can have on a profile (F-45); none of them may show for a missing user (B-98). */
const FRIEND_BUTTON_NAME = /^(add friend|cancel request|accept request|decline|unfriend)$/;

/** The fallback avatar shows the initials (ADR-0010); the fixture names start with ASCII letters. */
function initials(user: Pick<E2EUser, 'firstName' | 'lastName'>): string {
  return `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase();
}

/** `GET /api/me` as the user's own API session: the stored state, independent of what the page shows. */
async function storedMe(user: E2EUser): Promise<Record<string, unknown>> {
  const response = await user.api.get('/api/me');
  await expectStatus(response, 200, 'GET /api/me');
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body['user'])) {
    throw new Error(`GET /api/me: unexpected body ${JSON.stringify(body)}`);
  }
  return body['user'];
}

/** Records every request the page sends with `method` to `pathname` (e.g. to prove that nothing was sent). */
function recordRequests(page: Page, method: string, pathname: string | RegExp): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    const matches = typeof pathname === 'string' ? path === pathname : pathname.test(path);
    if (request.method() === method && matches) requests.push(request);
  });
  return requests;
}

/** The visible text of an element as the user reads it (`innerText` applies `white-space`, so line breaks count). */
function renderedText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => (element instanceof HTMLElement ? element.innerText : ''));
}

/** The live counter under the bio field (F-29): visible, and the field's accessible description. */
async function expectCount(field: Locator, text: string): Promise<void> {
  await expect(field).toHaveAccessibleDescription(text);
  await expect(field.page().getByRole('main').getByText(text, { exact: true })).toBeVisible();
}

/** The pieces of the own profile on `/`. */
function ownProfile(page: Page) {
  const main = page.getByRole('main');
  return {
    main,
    name: main.getByRole('heading', { level: 1 }),
    avatarButton: main.getByRole('button', { name: 'Change profile picture' }),
    addBio: main.getByRole('button', { name: 'add bio', exact: true }),
    editBio: main.getByRole('button', { name: 'edit bio', exact: true }),
    bioField: main.getByRole('textbox', { name: 'bio', exact: true }),
    save: main.getByRole('button', { name: 'save', exact: true }),
    cancel: main.getByRole('button', { name: 'cancel', exact: true }),
    status: main.getByRole('status').filter({ hasText: BIO_SAVED }),
  };
}

test.describe('own profile', () => {
  test('F-24: / shows the default avatar, the full name and the bio', async ({ user, userPage: page }) => {
    await setBio(user, 'Collects old maps and paints the coastline.');
    const profile = ownProfile(page);

    await page.goto('/');

    await expect(profile.name).toHaveText(fullName(user));
    // No picture yet: the default avatar (initials) inside the "Change profile picture" button (F-33).
    await expect(profile.avatarButton).toBeVisible();
    await expect(profile.avatarButton.locator('img')).toHaveCount(0);
    await expect(profile.avatarButton).toContainText(initials(user));
    await expect(profile.main.getByText('Collects old maps and paints the coastline.')).toBeVisible();
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-25 / B-82: a loading state is shown instead of a blank page while the profile loads', async ({
    user,
    userPage: page,
  }) => {
    const me = await holdGets(page, '/api/me');
    const loading = page.getByRole('status').filter({ hasText: /loading/ });

    await page.goto('/', { waitUntil: 'commit' });

    await expect(loading).toBeVisible();
    await expect(page.getByRole('heading', { name: fullName(user) })).toHaveCount(0);

    me.release();

    await expect(ownProfile(page).name).toHaveText(fullName(user));
    await expect(loading).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test('F-26: without a bio the profile says so and offers "add bio"', async ({ userPage: page }) => {
    const profile = ownProfile(page);

    await page.goto('/');

    await expect(profile.main.getByText(NO_OWN_BIO, { exact: true })).toBeVisible();
    await expect(profile.addBio).toBeVisible();
    await expect(profile.editBio).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test('F-27: "add bio" and "edit bio" open a labelled textarea prefilled with the bio, with save and cancel', async ({
    user,
    userPage: page,
  }) => {
    const profile = ownProfile(page);
    await page.goto('/');

    await test.step('add bio: an empty, focused field', async () => {
      await profile.addBio.click();

      await expect(profile.bioField).toBeVisible();
      await expect(profile.bioField).toHaveValue('');
      await expect(profile.bioField).toBeFocused();
      await expect(profile.save).toBeVisible();
      await expect(profile.cancel).toBeVisible();
      await profile.cancel.click();
    });

    await test.step('edit bio: prefilled with the current bio (B-77)', async () => {
      await setBio(user, 'Line cook by day.');
      await page.reload();

      await profile.editBio.click();

      await expect(profile.bioField).toHaveValue('Line cook by day.');
      await expect(profile.bioField).toBeFocused();
      await expect(profile.save).toBeVisible();
      await expect(profile.cancel).toBeVisible();
    });

    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-28 / B-77: saving without changes keeps the bio and sends nothing', async ({ user, userPage: page }) => {
    await setBio(user, 'Keeps bees on the roof.');
    const patches = recordRequests(page, 'PATCH', '/api/me');
    const profile = ownProfile(page);
    await page.goto('/');

    await test.step('unchanged', async () => {
      await profile.editBio.click();
      await profile.save.click();

      await expect(profile.bioField).toHaveCount(0);
      await expect(profile.main.getByText('Keeps bees on the roof.', { exact: true })).toBeVisible();
    });

    await test.step('only surrounding whitespace added: equal after trimming', async () => {
      await profile.editBio.click();
      await profile.bioField.fill('  Keeps bees on the roof.   ');
      await profile.save.click();

      await expect(profile.bioField).toHaveCount(0);
      await expect(profile.main.getByText('Keeps bees on the roof.', { exact: true })).toBeVisible();
    });

    expect(patches).toHaveLength(0);
    expect((await storedMe(user))['bio']).toBe('Keeps bees on the roof.');
    await page.reload();
    await expect(profile.main.getByText('Keeps bees on the roof.', { exact: true })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('F-28: an emptied bio is removed, and only after that explicit change', async ({ user, userPage: page }) => {
    await setBio(user, 'Temporary bio.');
    const patches = recordRequests(page, 'PATCH', '/api/me');
    const profile = ownProfile(page);
    await page.goto('/');

    await profile.editBio.click();
    await profile.bioField.fill('');
    const saved = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/me' && response.request().method() === 'PATCH',
    );
    await profile.save.click();

    expect((await saved).status()).toBe(200);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.postDataJSON()).toEqual({ bio: null });
    await expect(profile.main.getByText(NO_OWN_BIO, { exact: true })).toBeVisible();
    await expect(profile.addBio).toBeFocused();
    await expect(profile.status).toBeVisible();
    expect((await storedMe(user))['bio']).toBeNull();
    await expectNoA11yViolations(page);
  });

  test('F-29: a live counter shows the remaining characters and an over-long bio is not sent', async ({
    user,
    userPage: page,
  }) => {
    const patches = recordRequests(page, 'PATCH', '/api/me');
    const profile = ownProfile(page);
    await page.goto('/');
    await profile.addBio.click();

    await expectCount(profile.bioField, '1,000 characters left');
    await profile.bioField.fill('Hello');
    await expectCount(profile.bioField, '995 characters left');
    // The counter counts the trimmed text, which is what will be stored.
    await profile.bioField.fill('   Hello   ');
    await expectCount(profile.bioField, '995 characters left');
    await profile.bioField.fill('x'.repeat(BIO_MAX));
    await expectCount(profile.bioField, '0 characters left');
    await profile.bioField.fill('x'.repeat(BIO_MAX + 1));
    await expectCount(profile.bioField, '1 character too many');

    await profile.save.click();

    await expect(profile.main.getByRole('alert').filter({ hasText: BIO_TOO_LONG })).toBeVisible();
    await expect(profile.bioField).toHaveAttribute('aria-invalid', 'true');
    await expect(profile.bioField).toHaveAccessibleDescription(`${BIO_TOO_LONG} 1 character too many`);
    await expect(profile.bioField).toHaveValue('x'.repeat(BIO_MAX + 1));
    expect(patches).toHaveLength(0);
    expect((await storedMe(user))['bio']).toBeNull();
    await expectNoA11yViolations(page);
  });

  test('F-29: the bio is trimmed before it is stored', async ({ user, userPage: page }) => {
    const profile = ownProfile(page);
    await page.goto('/');

    await profile.addBio.click();
    await profile.bioField.fill('   Restores bicycles.   ');
    await profile.save.click();

    await expect(profile.status).toBeVisible();
    await expect(profile.main.getByText('Restores bicycles.', { exact: true })).toBeVisible();
    expect((await storedMe(user))['bio']).toBe('Restores bicycles.');
    await expectNoA11yViolations(page);
  });

  test('F-29: through the proxy the server stores 1,000 trimmed characters and rejects more with 422', async ({
    user,
  }) => {
    const longest = 'y'.repeat(BIO_MAX);
    const accepted = await user.api.patch('/api/me', { bio: `  ${longest}  ` });
    expect(accepted.status()).toBe(200);
    expect((await storedMe(user))['bio']).toBe(longest);

    const rejected = await user.api.patch('/api/me', { bio: 'z'.repeat(BIO_MAX + 1) });

    expect(rejected.status()).toBe(422);
    expect(rejected.headers()['content-type']).toContain('application/problem+json');
    const problem: unknown = await rejected.json();
    expect(problem).toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}validation-failed`,
      status: 422,
      errors: [{ location: 'body', path: 'bio' }],
    });
    expect((await storedMe(user))['bio']).toBe(longest);
  });

  test('F-30: cancel and Escape restore the previous bio and return focus to the edit button', async ({
    user,
    userPage: page,
  }) => {
    await setBio(user, 'Plays the cello badly.');
    const patches = recordRequests(page, 'PATCH', '/api/me');
    const profile = ownProfile(page);
    await page.goto('/');

    await test.step('cancel', async () => {
      await profile.editBio.click();
      await profile.bioField.fill('A draft that is thrown away');
      await profile.cancel.click();

      await expect(profile.bioField).toHaveCount(0);
      await expect(profile.main.getByText('Plays the cello badly.', { exact: true })).toBeVisible();
      await expect(profile.editBio).toBeFocused();
    });

    await test.step('Escape in the textarea', async () => {
      await profile.editBio.click();
      // The draft from before is gone: the editor starts from the stored bio again.
      await expect(profile.bioField).toHaveValue('Plays the cello badly.');
      await profile.bioField.fill('Another discarded draft');
      await page.keyboard.press('Escape');

      await expect(profile.bioField).toHaveCount(0);
      await expect(profile.main.getByText('Plays the cello badly.', { exact: true })).toBeVisible();
      await expect(profile.editBio).toBeFocused();
    });

    expect(patches).toHaveLength(0);
    await expectNoA11yViolations(page);
  });

  test('F-31: a failed save keeps the editor open with the draft and shows an error', async ({
    user,
    userPage: page,
  }) => {
    await setBio(user, 'Before the outage.');
    const profile = ownProfile(page);
    await page.goto('/');
    // The stack itself is healthy, so the failure is simulated at the browser's network layer: a generic 500 problem.
    await page.route(
      (url) => url.pathname === '/api/me',
      async (route) => {
        if (route.request().method() !== 'PATCH') {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 }),
        });
      },
    );

    await profile.editBio.click();
    await profile.bioField.fill('A draft worth keeping');
    await profile.save.click();

    // A form-level error, announced as an alert; the field itself is valid.
    await expect(profile.main.getByRole('alert').filter({ hasText: SERVER_ERROR })).toBeVisible();
    await expect(profile.bioField).not.toHaveAttribute('aria-invalid', 'true');
    await expect(profile.bioField).toBeVisible();
    await expect(profile.bioField).toHaveValue('A draft worth keeping');
    await expect(profile.save).toBeEnabled();
    expect((await storedMe(user))['bio']).toBe('Before the outage.');
    await expectNoA11yViolations(page);

    await test.step('the same draft saves once the server answers again', async () => {
      await page.unrouteAll({ behavior: 'wait' });
      await profile.save.click();

      await expect(profile.status).toBeVisible();
      await expect(profile.main.getByText('A draft worth keeping', { exact: true })).toBeVisible();
      expect((await storedMe(user))['bio']).toBe('A draft worth keeping');
    });
  });

  test('F-32: the bio is rendered as plain text with its line breaks, for the owner and for friends', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser();
    const friend = await createUser();
    await befriend(owner, friend);
    const bio = 'First line\n<b>not bold</b> <img src="/x" alt="markup">\nThird line';
    const ownerPage = await pageAs(owner);
    const profile = ownProfile(ownerPage);
    await ownerPage.goto('/');

    await profile.addBio.click();
    await profile.bioField.fill(bio);
    await profile.save.click();
    await expect(profile.status).toBeVisible();

    const ownBio = profile.main.getByText('First line');
    await expect(ownBio).toBeVisible();
    expect(await renderedText(ownBio)).toBe(bio);
    await expect(ownBio.locator('*')).toHaveCount(0);
    expect((await storedMe(owner))['bio']).toBe(bio);

    const friendPage = await pageAs(friend);
    await friendPage.goto(`/users/${String(owner.id)}`);
    const theirBio = friendPage.getByRole('main').getByText('First line');
    await expect(theirBio).toBeVisible();
    expect(await renderedText(theirBio)).toBe(bio);
    await expect(theirBio.locator('*')).toHaveCount(0);
    await expect(friendPage.getByRole('img', { name: 'markup' })).toHaveCount(0);
    await expectNoA11yViolations(friendPage);
  });
});

test.describe("another user's profile", () => {
  test("F-40 / B-78: /users/:id shows that user's avatar, name and bio", async ({ createUser, pageAs }) => {
    const other = await createUser({ firstName: 'Noor' });
    const viewer = await createUser();
    await setBio(other, 'Repairs radios and writes about it.');
    const avatarUrl = await uploadAvatar(other);
    const page = await pageAs(viewer);

    await page.goto(`/users/${String(other.id)}`);

    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(fullName(other));
    const picture = main.getByRole('img', { name: `${fullName(other)}'s profile picture` });
    await expect(picture).toHaveAttribute('src', avatarUrl);
    await expect
      .poll(() => picture.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0))
      .toBe(true);
    await expect(main.getByText('Repairs radios and writes about it.', { exact: true })).toBeVisible();
    // Not a friend yet: the friend button is there and the wall says how to get access (F-45, F-65).
    await expect(main.getByRole('button', { name: 'add friend', exact: true })).toBeVisible();
    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-40: another user without a bio reads "No bio yet." and the default avatar', async ({
    createUser,
    pageAs,
  }) => {
    const other = await createUser({ firstName: 'Ilse' });
    const viewer = await createUser();
    const page = await pageAs(viewer);

    await page.goto(`/users/${String(other.id)}`);

    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(fullName(other));
    await expect(main.getByText(NO_OTHER_BIO, { exact: true })).toBeVisible();
    await expect(main.getByText(NO_OWN_BIO)).toHaveCount(0);
    await expect(main.getByRole('img', { name: `${fullName(other)}'s profile picture` })).toHaveText(initials(other));
    await expectNoA11yViolations(page);
  });

  test('F-41: /users/<own id> redirects to /', async ({ user, userPage: page, baseURL }) => {
    await page.goto(`/users/${String(user.id)}`);

    await expect(page).toHaveURL(new URL('/', baseURL).href);
    await expect(ownProfile(page).name).toHaveText(fullName(user));
    await expect(ownProfile(page).addBio).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('F-42 / B-98: a non-existent id shows "This user does not exist." without friend button or wall', async ({
    user,
    userPage: page,
  }) => {
    const missingId = String(ID_MAX);
    const posts = recordRequests(page, 'GET', /\/posts$/);
    const profileResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/users/${missingId}`,
    );

    await page.goto(`/users/${missingId}`);

    expect((await profileResponse).status()).toBe(404);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(USER_MISSING);
    await expect(main.getByRole('button', { name: FRIEND_BUTTON_NAME })).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'wall' })).toHaveCount(0);
    expect(posts).toHaveLength(0);
    await expectNoA11yViolationsInBothSchemes(page);

    await test.step('the API answers 404 user-not-found as problem+json', async () => {
      const response = await user.api.get(`/api/users/${missingId}`);
      expect(response.status()).toBe(404);
      expect(response.headers()['content-type']).toContain('application/problem+json');
      expect(await response.json()).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}user-not-found`, status: 404 });
    });
  });

  test('F-42 / B-55: a malformed id shows the same message and is never sent to the API as a user id', async ({
    user,
    userPage: page,
  }) => {
    const userRequests = recordRequests(page, 'GET', /^\/api\/users\//);
    const main = page.getByRole('main');

    for (const malformed of ['abc', '0', '07', '1e3', String(ID_MAX + 1)]) {
      await test.step(`/users/${malformed}`, async () => {
        await page.goto(`/users/${malformed}`);

        await expect(main.getByRole('heading', { level: 1 })).toHaveText(USER_MISSING);
        await expect(main.getByRole('button', { name: FRIEND_BUTTON_NAME })).toHaveCount(0);
        await expect(main.getByRole('region', { name: 'wall' })).toHaveCount(0);

        // The API itself refuses the same id with 400 instead of passing it to SQL (B-55).
        const response = await user.api.get(`/api/users/${malformed}`);
        expect(response.status()).toBe(400);
        expect(response.headers()['content-type']).toContain('application/problem+json');
      });
    }

    expect(userRequests.map((request) => request.url())).toEqual([]);
    await expectNoA11yViolations(page);
  });

  test('F-44: a loading state is shown while another profile loads', async ({ createUser, pageAs }) => {
    const other = await createUser({ firstName: 'Tomas' });
    await setBio(other, 'Bakes sourdough on Sundays.');
    const viewer = await createUser();
    const page = await pageAs(viewer);
    const profile = await holdGets(page, `/api/users/${String(other.id)}`);
    const main = page.getByRole('main');
    const loading = main.getByRole('status').filter({ hasText: 'loading profile…' });

    await page.goto(`/users/${String(other.id)}`);

    await expect(loading).toBeVisible();
    await expect(main.getByRole('heading', { name: fullName(other) })).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'wall' })).toHaveCount(0);

    profile.release();

    await expect(main.getByRole('heading', { level: 1 })).toHaveText(fullName(other));
    await expect(main.getByText('Bakes sourdough on Sundays.', { exact: true })).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expectNoA11yViolations(page);
  });
});
