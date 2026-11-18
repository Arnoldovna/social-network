import type { Locator, Page, Request } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothSchemes, setColorScheme } from './a11y.js';
import { AVATAR_PATH, expectStatus, isRecord, PROBLEM_TYPE_PREFIX } from './fixtures/api.js';
import {
  htmlDisguisedAsPng,
  oversizedForApi,
  oversizedForProxy,
  pngAvatar,
  textFile,
  tooWidePng,
  truncatedPng,
  validAvatars,
  type UploadFile,
} from './fixtures/images.js';
import { befriend, expect, test, type E2EUser } from './fixtures/test.js';
import { fullName } from './fixtures/ui.js';

/**
 * Avatar journeys (FEATURES §4 "Avatar upload"): F-33–F-35, F-37, F-38 and the legacy bugs they close (B-29, B-32,
 * B-96, B-97, B-103). Uploads are in-memory solid-colour images from `fixtures/images.ts`, never photos. Every test
 * registers its own users (ADR-0016), so the spec shares the e2e stack with the other phase-5 specs.
 */

const TRIGGER_NAME = 'Change profile picture';
const DIALOG_NAME = 'Change profile picture';
const PREVIEW_NAME = 'Preview of your new profile picture';
const SAVED_MESSAGE = 'Your profile picture is saved.';

/** F-38 fixes the first two sentences; the others are the dialog's own (`validate-avatar-file.ts`). */
const MESSAGES = {
  type: 'Please choose a JPEG, PNG, WebP or GIF image.',
  size: 'The image must be 2 MB or smaller.',
  pixels: 'The image must be at most 8192 × 8192 pixels.',
} as const;
/** `AVATAR_FILE_HINT`: the file input's description, followed by the error while there is one. */
const FILE_HINT = 'JPEG, PNG, WebP or GIF, up to 2 MB. It is cropped to a square.';

/** `avatarUrl` of a `MeResponse` body (`{ user: Me }`). */
function avatarUrlOf(body: unknown, step: string): string | null {
  const avatarUrl = isRecord(body) && isRecord(body['user']) ? body['user']['avatarUrl'] : undefined;
  if (avatarUrl === null || typeof avatarUrl === 'string') return avatarUrl;
  throw new Error(`${step}: unexpected body ${JSON.stringify(body)}`);
}

async function storedAvatarUrl(user: E2EUser): Promise<string | null> {
  const response = await user.api.get('/api/me');
  await expectStatus(response, 200, 'GET /api/me');
  return avatarUrlOf(await response.json(), 'GET /api/me');
}

/** `PUT /api/me/avatar` as the user's API session, through nginx like the browser's request. */
function putAvatar(user: E2EUser, file: UploadFile) {
  return user.api.put(AVATAR_PATH, { avatar: file });
}

function isAvatarUpload(request: Request): boolean {
  return request.method() === 'PUT' && new URL(request.url()).pathname === AVATAR_PATH;
}

function recordUploads(page: Page): Request[] {
  const uploads: Request[] = [];
  page.on('request', (request) => {
    if (isAvatarUpload(request)) uploads.push(request);
  });
  return uploads;
}

/** True once the browser has decoded the image (a broken or still-loading `<img>` has no natural width). */
function isDecoded(image: Locator): Promise<boolean> {
  return image.evaluate(
    (element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
  );
}

/** The two triggers on `/` (header and profile) and the open upload dialog. */
function avatarUi(page: Page) {
  const dialog = page.getByRole('dialog', { name: DIALOG_NAME });
  return {
    headerTrigger: page.getByRole('banner').getByRole('button', { name: TRIGGER_NAME }),
    profileTrigger: page.getByRole('main').getByRole('button', { name: TRIGGER_NAME }),
    dialog,
    fileInput: dialog.getByLabel('choose an image'),
    preview: dialog.getByRole('img', { name: PREVIEW_NAME }),
    save: dialog.getByRole('button', { name: 'save', exact: true }),
    close: dialog.getByRole('button', { name: 'close', exact: true }),
    error: dialog.getByRole('alert'),
    toast: page.getByRole('status').filter({ hasText: SAVED_MESSAGE }),
  };
}

/** Chooses `file` in the open dialog and expects the refusal F-38 describes: the message, no preview, no "save". */
async function expectRefused(
  ui: ReturnType<typeof avatarUi>,
  what: string,
  file: UploadFile,
  message: string,
): Promise<void> {
  await test.step(what, async () => {
    await ui.fileInput.setInputFiles(file);

    await expect(ui.error).toHaveText(message);
    await expect(ui.fileInput).toHaveAttribute('aria-invalid', 'true');
    await expect(ui.fileInput).toHaveAccessibleDescription(`${FILE_HINT} ${message}`);
    await expect(ui.dialog.getByText(file.name, { exact: true })).toBeVisible();
    await expect(ui.preview).toHaveCount(0);
    await expect(ui.save).toBeDisabled();
    await expect(ui.dialog).toBeVisible();
  });
}

test.describe('avatar upload', () => {
  test('F-33 / B-103: header and profile pictures are real buttons named "Change profile picture"', async ({
    userPage: page,
  }) => {
    const ui = avatarUi(page);
    await page.goto('/');

    for (const [where, trigger] of [
      ['header', ui.headerTrigger],
      ['profile', ui.profileTrigger],
    ] as const) {
      await test.step(`${where}: a <button> that opens the dialog by click and by keyboard`, async () => {
        await expect(trigger).toBeVisible();
        expect(await trigger.evaluate((element) => element.tagName)).toBe('BUTTON');
        await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');

        await trigger.click();
        await expect(ui.dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(ui.dialog).toHaveCount(0);

        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(ui.dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(ui.dialog).toHaveCount(0);
      });
    }

    await expectNoA11yViolationsInBothSchemes(page);
  });

  test('F-34 / B-96: the dialog is modal, traps focus, closes with Escape, "close" and the backdrop, and returns focus', async ({
    userPage: page,
  }) => {
    const ui = avatarUi(page);
    await page.goto('/');
    /**
     * Where Tab put the focus: a control of the open dialog (its accessible name or tag), `browser` when no element
     * has focus, or `page behind` for any element outside the dialog. A native modal `<dialog>` makes the page behind
     * inert, but, per the HTML spec, lets Tab leave the last control for the browser's own UI (in headless Chromium:
     * no focused element), from where the next Tab comes back into the dialog. That is the trap F-34 asks for.
     */
    const focusTarget = () =>
      page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'browser';
        if (active.closest('dialog[open]') === null) return 'page behind';
        return active instanceof HTMLInputElement ? `input[type=${active.type}]` : active.textContent.trim();
      });

    await test.step('modal, focus starts on the file input and never reaches the page behind', async () => {
      await ui.headerTrigger.click();

      await expect(ui.dialog).toBeVisible();
      expect(await ui.dialog.evaluate((dialog) => dialog.matches(':modal'))).toBe(true);
      await expect(ui.fileInput).toBeFocused();
      const visited: string[] = [];
      for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        visited.push(await focusTarget());
      }
      const sequence = visited.join(' → ');
      expect(visited, sequence).not.toContain('page behind');
      // Both Tab stops (the disabled "save" is none without a file) are reached, and focus never stays in the browser.
      expect(visited, sequence).toContain('close');
      expect(visited, sequence).toContain('input[type=file]');
      expect(
        visited.some((target, index) => target === 'browser' && visited[index + 1] === 'browser'),
        sequence,
      ).toBe(false);
      await expectNoA11yViolationsInBothSchemes(page);
      await setColorScheme(page, 'light');
      await page.keyboard.press('Escape');
      await expect(ui.dialog).toHaveCount(0);
    });

    const closeWays: readonly (readonly [string, () => Promise<void>])[] = [
      ['Escape', () => page.keyboard.press('Escape')],
      ['the "close" button', () => ui.close.click()],
      // The dialog box is centred with a margin on every side, so the top-left corner is backdrop at both widths.
      ['a backdrop click', () => page.mouse.click(4, 4)],
    ];
    for (const [where, trigger] of [
      ['header', ui.headerTrigger],
      ['profile', ui.profileTrigger],
    ] as const) {
      for (const [how, closeDialog] of closeWays) {
        await test.step(`${where} trigger, closed with ${how}`, async () => {
          await trigger.click();
          await expect(ui.dialog).toBeVisible();

          await closeDialog();

          await expect(ui.dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
        });
      }
    }

    await expectNoA11yViolations(page);
  });

  test('F-35: a chosen file shows a preview and nothing is uploaded before "save", which shows progress', async ({
    user,
    userPage: page,
  }) => {
    const ui = avatarUi(page);
    const uploads = recordUploads(page);
    await page.goto('/');
    await ui.profileTrigger.click();

    await expect(ui.save).toBeDisabled();
    await ui.fileInput.setInputFiles(pngAvatar({ rgb: [20, 120, 70] }));

    await expect(ui.preview).toBeVisible();
    await expect.poll(() => isDecoded(ui.preview)).toBe(true);
    await expect(ui.dialog.getByText('avatar.png', { exact: true })).toBeVisible();
    await expect(ui.save).toBeEnabled();
    // Legacy uploaded on `change`; now nothing leaves the browser until the user saves.
    expect(uploads).toHaveLength(0);
    await expectNoA11yViolations(page);

    // Hold the upload at the browser's network layer so the progress state can be asserted without racing the stack.
    // A paused request emits no `request` event yet, so the handler counts it.
    const gate = Promise.withResolvers<undefined>();
    const held: Request[] = [];
    await page.route(
      (url) => url.pathname === AVATAR_PATH,
      async (route) => {
        held.push(route.request());
        await gate.promise;
        await route.continue();
      },
    );
    const response = page.waitForResponse((candidate) => isAvatarUpload(candidate.request()));
    await ui.save.click();

    const progress = ui.dialog.getByRole('progressbar');
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAccessibleName(/^(uploading|saving)…$/);
    await expect(ui.save).toHaveAttribute('aria-disabled', 'true');
    await expect(ui.fileInput).toBeDisabled();
    // The progress state starts before the request leaves, so wait for the handler to have it.
    await expect.poll(() => held.map((request) => request.method())).toEqual(['PUT']);

    gate.resolve(undefined);

    expect((await response).status()).toBe(200);
    await expect(ui.dialog).toHaveCount(0);
    await expect(ui.toast).toBeVisible();
    await expect(ui.profileTrigger).toBeFocused();
    expect(await storedAvatarUrl(user)).not.toBeNull();
    await expectNoA11yViolations(page);
  });

  test('F-35: each allowed type (JPEG, PNG, WebP, GIF) can be previewed and saved', async ({
    user,
    userPage: page,
  }) => {
    const ui = avatarUi(page);
    await page.goto('/');
    let previousUrl = await storedAvatarUrl(user);

    for (const [type, file] of Object.entries(validAvatars())) {
      await test.step(type, async () => {
        await ui.profileTrigger.click();
        await ui.fileInput.setInputFiles(file);
        await expect.poll(() => isDecoded(ui.preview)).toBe(true);
        const response = page.waitForResponse((candidate) => isAvatarUpload(candidate.request()));

        await ui.save.click();

        expect((await response).status()).toBe(200);
        await expect(ui.dialog).toHaveCount(0);
        const stored = await storedAvatarUrl(user);
        expect(stored).not.toBeNull();
        expect(stored).not.toBe(previousUrl);
        previousUrl = stored;
      });
    }
  });

  test('F-37, B-37: a new avatar appears at once in the header and on the profile, and in every entry rendered afterwards', async ({
    createUser,
    pageAs,
  }) => {
    const owner = await createUser({ firstName: 'Petra' });
    const friend = await createUser();
    await befriend(owner, friend);
    const ownerName = fullName(owner);
    // An existing picture, so the test proves a replacement, not only the first upload.
    const first = await putAvatar(owner, pngAvatar({ rgb: [200, 30, 30] }));
    await expectStatus(first, 200, 'PUT /api/me/avatar (first picture)');
    const oldUrl = avatarUrlOf(await first.json(), 'PUT /api/me/avatar');
    await expectStatus(
      await owner.api.post(`/api/users/${String(owner.id)}/posts`, { body: 'A post from before the new picture.' }),
      201,
      'POST /api/users/:id/posts',
    );

    const page = await pageAs(owner);
    const ui = avatarUi(page);
    await page.goto('/');
    const headerPicture = ui.headerTrigger.locator('img');
    const profilePicture = ui.profileTrigger.locator('img');
    const wallPicture = page
      .getByRole('main')
      .getByRole('article')
      .filter({ hasText: 'A post from before the new picture.' })
      .getByRole('img', { name: `${ownerName}'s profile picture` });
    await expect(headerPicture).toHaveAttribute('src', oldUrl ?? '');
    await expect(wallPicture).toHaveAttribute('src', oldUrl ?? '');

    await ui.headerTrigger.click();
    await ui.fileInput.setInputFiles(pngAvatar({ rgb: [30, 200, 30] }));
    await expect.poll(() => isDecoded(ui.preview)).toBe(true);
    const response = page.waitForResponse((candidate) => isAvatarUpload(candidate.request()));
    await ui.save.click();
    const uploaded = await response;
    expect(uploaded.status()).toBe(200);
    const newUrl = avatarUrlOf(await uploaded.json(), 'PUT /api/me/avatar');
    if (newUrl === null) throw new Error('The upload answered without an avatarUrl.');
    expect(newUrl).not.toBe(oldUrl);

    await test.step('header and profile, without a reload', async () => {
      await expect(ui.dialog).toHaveCount(0);
      await expect(ui.toast).toBeVisible();
      await expect(headerPicture).toHaveAttribute('src', newUrl);
      await expect(profilePicture).toHaveAttribute('src', newUrl);
      await expect.poll(() => isDecoded(headerPicture)).toBe(true);
      await expect.poll(() => isDecoded(profilePicture)).toBe(true);
    });

    await test.step('the own wall entry', async () => {
      await expect(wallPicture).toHaveAttribute('src', newUrl);
      await wallPicture.scrollIntoViewIfNeeded();
      await expect.poll(() => isDecoded(wallPicture)).toBe(true);
    });
    await expectNoA11yViolations(page);

    await test.step('a friend sees it on the profile, the wall and the friends list', async () => {
      const friendPage = await pageAs(friend);
      const friendMain = friendPage.getByRole('main');
      await friendPage.goto(`/users/${String(owner.id)}`);

      const pictures = friendMain.getByRole('img', { name: `${ownerName}'s profile picture` });
      // The large profile picture and the wall post's author picture.
      await expect(pictures).toHaveCount(2);
      for (const picture of await pictures.all()) await expect(picture).toHaveAttribute('src', newUrl);
      await expect.poll(() => isDecoded(pictures.first())).toBe(true);

      await friendPage.goto('/friends');
      const row = friendMain.getByRole('listitem').filter({ hasText: ownerName });
      await expect(row.getByRole('img', { name: `${ownerName}'s profile picture` })).toHaveAttribute('src', newUrl);
      await expectNoA11yViolations(friendPage);
    });
  });

  test('F-38 / B-97: an invalid file shows a specific message and keeps the dialog open', async ({
    user,
    userPage: page,
  }) => {
    const ui = avatarUi(page);
    const uploads = recordUploads(page);
    await page.goto('/');
    await ui.profileTrigger.click();

    await expectRefused(ui, 'a text file', textFile(), MESSAGES.type);
    await expectRefused(ui, 'an image over 2 MB', oversizedForApi(), MESSAGES.size);
    await expectRefused(ui, 'an image wider than 8192 px', tooWidePng(), MESSAGES.pixels);
    // Allowed by name and type, refused once the preview cannot decode it (the server would answer 415).
    await expectRefused(ui, 'HTML named and typed as a PNG', htmlDisguisedAsPng(), MESSAGES.type);
    await expectRefused(ui, 'a PNG without image data', truncatedPng(), MESSAGES.type);
    await expectNoA11yViolationsInBothSchemes(page);
    await setColorScheme(page, 'light');

    await test.step('a valid file afterwards clears the message', async () => {
      await ui.fileInput.setInputFiles(pngAvatar());

      await expect(ui.error).toHaveCount(0);
      await expect(ui.fileInput).not.toHaveAttribute('aria-invalid', 'true');
      await expect(ui.fileInput).toHaveAccessibleDescription(FILE_HINT);
      await expect(ui.preview).toBeVisible();
      await expect(ui.save).toBeEnabled();
    });

    expect(uploads).toHaveLength(0);
    expect(await storedAvatarUrl(user)).toBeNull();
  });

  test('B-32: nginx and the API answer an oversized upload with 413 file-too-large problem+json', async ({ user }) => {
    for (const [what, file] of [
      ['over AVATAR_MAX_BYTES (multer)', oversizedForApi()],
      ['over client_max_body_size (nginx)', oversizedForProxy()],
    ] as const) {
      await test.step(what, async () => {
        const response = await putAvatar(user, file);

        expect(response.status()).toBe(413);
        expect(response.headers()['content-type']).toContain('application/problem+json');
        expect(await response.json()).toMatchObject({ type: `${PROBLEM_TYPE_PREFIX}file-too-large`, status: 413 });
      });
    }
    expect(await storedAvatarUrl(user)).toBeNull();
  });

  test('B-29: HTML disguised as a PNG is refused with 415 through the proxy and never becomes the avatar', async ({
    user,
  }) => {
    const response = await putAvatar(user, htmlDisguisedAsPng());

    expect(response.status()).toBe(415);
    expect(response.headers()['content-type']).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}unsupported-media-type`,
      status: 415,
    });
    expect(await storedAvatarUrl(user)).toBeNull();
    const media = await user.api.get(`/api/users/${String(user.id)}/avatar`);
    expect(media.status()).toBe(404);
  });
});
