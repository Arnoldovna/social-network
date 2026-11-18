import { AVATAR_FIELD, AVATAR_MAX_BYTES } from '@app/shared';
import type { Me } from '@app/shared';
import type { TagDescription } from '@reduxjs/toolkit/query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA, signInAs } from '../../../shared/api/__tests__/fixtures';
import { baseApi } from '../../../shared/api/baseApi';
import type { TagType } from '../../../shared/api/baseApi';
import { meApi } from '../../../shared/api/me.api';
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
import { AvatarButton } from '../index';

const NEW_AVATAR_URL = '/api/users/1/avatar?v=0b8e5f3c-2d47-4a61-9c1e-7f2a3b4c5d6e';
const MIRA_WITH_NEW_AVATAR: Me = { ...MIRA, avatarUrl: NEW_AVATAR_URL };
const UPLOAD_URL = apiUrl('/me/avatar');

const MESSAGES = {
  type: 'Please choose a JPEG, PNG, WebP or GIF image.',
  size: 'The image must be 2 MB or smaller.',
  pixels: 'The image must be at most 8192 × 8192 pixels.',
  network: 'The server could not be reached. Check your connection and try again.',
  saved: 'Your profile picture is saved.',
};

/*
 * happy-dom's XMLHttpRequest sends through its own fetch (MSW answers it at the Node http level) and never fires the
 * `upload` events a browser fires while the body goes out. This subclass keeps the real request and lets a test
 * report upload progress the way a browser would, and records whether the request was aborted.
 */
const sentRequests: BrowserLikeXhr[] = [];

class BrowserLikeXhr extends XMLHttpRequest {
  aborted = false;

  override send(body?: Document | XMLHttpRequestBodyInit | null): void {
    sentRequests.push(this);
    super.send(body);
  }

  override abort(): void {
    this.aborted = true;
    super.abort();
  }

  /** The browser sent `loaded` of `total` bytes. */
  reportProgress(loaded: number, total: number): void {
    this.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded, total }));
  }

  /** The whole body is sent; the server now processes it. */
  reportBodySent(): void {
    this.upload.dispatchEvent(new ProgressEvent('load', { lengthComputable: true, loaded: 1, total: 1 }));
  }
}

beforeEach(() => {
  sentRequests.length = 0;
  vi.stubGlobal('XMLHttpRequest', BrowserLikeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sentRequest(): Promise<BrowserLikeXhr> {
  await waitFor(() => {
    expect(sentRequests).toHaveLength(1);
  });
  const [request] = sentRequests;
  if (request === undefined) {
    throw new Error('no upload was sent');
  }
  return request;
}

function imageFile(name = 'holiday-2026.png', type = 'image/png', size = 256): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** A promise the test resolves itself, to hold a response while the dialog shows its progress. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    opened: promise,
    open: () => {
      resolve(undefined);
    },
  };
}

async function renderSignedIn(variant: 'header' | 'profile' = 'header') {
  const testStore = createTestStore();
  await signInAs(testStore.store);
  const utils = renderWithProviders(<AvatarButton variant={variant} />, { store: testStore.store });
  // `applyAccept: false`: the picker's `accept` filter would drop the wrong files before the dialog could refuse them.
  const user = userEvent.setup({ applyAccept: false });
  return { ...testStore, ...utils, user };
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Change profile picture' });
}

function fileInput(): HTMLInputElement {
  const input = screen.getByLabelText('choose an image');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('the "choose an image" label does not point at an input');
  }
  return input;
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'save' });
}

function preview(): HTMLElement {
  return screen.getByRole('img', { name: 'Preview of your new profile picture' });
}

function headerPicture(): HTMLImageElement {
  const image = trigger().querySelector('img');
  if (image === null) {
    throw new Error('the avatar button shows no picture');
  }
  return image;
}

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger());
  return screen.getByRole('dialog', { name: 'Change profile picture' });
}

function cachedUser(store: ReturnType<typeof createTestStore>['store']): Me | undefined {
  return meApi.endpoints.getMe.select(undefined)(store.getState()).data?.user;
}

describe('AvatarButton (F-33, B-103)', () => {
  it('renders nothing for a visitor', async () => {
    let meRequests = 0;
    server.use(
      http.get(apiUrl('/me'), () => {
        meRequests += 1;
        return problemResponse(401, 'unauthorized');
      }),
    );
    const { container } = renderWithProviders(<AvatarButton variant="header" />);

    await waitFor(() => {
      expect(meRequests).toBe(1);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('is a real button named "Change profile picture" around a decorative picture in the header', async () => {
    await renderSignedIn('header');

    const button = trigger();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(headerPicture()).toHaveAttribute('alt', '');
    expect(headerPicture()).toHaveAttribute('src', MIRA.avatarUrl);
  });

  it('shows its label on the profile, so the visible text is the accessible name (WCAG 2.5.3)', async () => {
    await renderSignedIn('profile');

    expect(screen.getByRole('button', { name: 'change profile picture' })).toBeVisible();
  });
});

describe('AvatarUploadDialog (F-34, F-35, F-38; B-96, B-97)', () => {
  it('opens as a modal with the file field focused and the current picture shown', async () => {
    const { user } = await renderSignedIn();

    const dialog = await openDialog(user);

    expect(dialog).toHaveProperty('open', true);
    expect(fileInput()).toHaveFocus();
    expect(fileInput()).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,image/gif');
    expect(fileInput()).toHaveAccessibleDescription('JPEG, PNG, WebP or GIF, up to 2 MB. It is cropped to a square.');
    expect(within(dialog).getByRole('img', { name: "Mira Novak's profile picture" })).toBeInTheDocument();
    // Nothing to upload yet (B-33).
    expect(within(dialog).getByText('no image chosen')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('closes with "close" and returns focus to the avatar button (B-96)', async () => {
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'close' }));

    expect(dialog).toHaveProperty('open', false);
    expect(trigger()).toHaveFocus();
  });

  it('closes on Escape (B-96)', async () => {
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);

    // happy-dom has no Escape handling of its own; the browser turns Escape into a cancelable `cancel` event.
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });

    expect(dialog).toHaveProperty('open', false);
    expect(trigger()).toHaveFocus();
  });

  it('starts empty again after it was closed with a file chosen', async () => {
    const { user } = await renderSignedIn();
    await openDialog(user);
    await user.upload(fileInput(), imageFile());
    await user.click(screen.getByRole('button', { name: 'close' }));

    await openDialog(user);

    expect(fileInput().files).toHaveLength(0);
    expect(screen.queryByRole('img', { name: 'Preview of your new profile picture' })).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('previews a valid image and enables "save" (F-35)', async () => {
    const { user } = await renderSignedIn();
    await openDialog(user);

    await user.upload(fileInput(), imageFile());

    expect(preview().getAttribute('src')).toMatch(/^blob:/);
    expect(screen.getByText('holiday-2026.png')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(fileInput()).not.toHaveAttribute('aria-invalid');
  });

  it('refuses a file of another type with a specific message and stays open (F-38)', async () => {
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);

    await user.upload(fileInput(), imageFile('cv.pdf', 'application/pdf'));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(MESSAGES.type);
    // The refused file is still the one chosen: its name stays next to the message, never "no image chosen".
    expect(within(dialog).getByText('cv.pdf')).toBeInTheDocument();
    expect(within(dialog).queryByText('no image chosen')).not.toBeInTheDocument();
    expect(fileInput()).toHaveAttribute('aria-invalid', 'true');
    expect(fileInput()).toHaveAccessibleDescription(expect.stringContaining(MESSAGES.type) as string);
    expect(saveButton()).toBeDisabled();
    expect(dialog).toHaveProperty('open', true);
    expect(screen.queryByRole('img', { name: 'Preview of your new profile picture' })).not.toBeInTheDocument();
  });

  it('refuses a file over 2 MB with a specific message (F-38)', async () => {
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);

    await user.upload(fileInput(), imageFile('scan.png', 'image/png', AVATAR_MAX_BYTES + 1));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(MESSAGES.size);
    expect(within(dialog).getByText('scan.png')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('clears the message when a valid file replaces a refused one', async () => {
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile('cv.pdf', 'application/pdf'));

    await user.upload(fileInput(), imageFile());

    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('refuses an image larger than 8192 px per side once the preview knows its size', async () => {
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile());
    const image = preview();

    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 9000 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 600 });
    fireEvent.load(image);

    expect(within(dialog).getByRole('alert')).toHaveTextContent(MESSAGES.pixels);
    expect(saveButton()).toBeDisabled();
  });

  it('refuses a file the browser cannot decode', async () => {
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile('renamed.png'));

    fireEvent.error(preview());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(MESSAGES.type);
    expect(saveButton()).toBeDisabled();
  });
});

describe('uploading (F-35, F-37, ADR-0012)', () => {
  it('sends the file with the CSRF token, shows progress, then updates the avatar everywhere it reads Me', async () => {
    const response = gate();
    const received: { method: string; csrf: string | null; fileName: string | undefined }[] = [];
    server.use(
      csrfTokenHandler(),
      http.put(UPLOAD_URL, async ({ request }) => {
        const part = (await request.formData()).get(AVATAR_FIELD);
        received.push({
          method: request.method,
          csrf: request.headers.get('x-csrf-token'),
          fileName: part instanceof File ? part.name : undefined,
        });
        await response.opened;
        return HttpResponse.json({ user: MIRA_WITH_NEW_AVATAR });
      }),
    );
    const { user, store } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile());

    await user.click(saveButton());
    const xhr = await sentRequest();

    const status = within(dialog).getByRole('status');
    expect(status).toHaveTextContent('uploading…');
    expect(saveButton()).toHaveAttribute('aria-disabled', 'true');
    act(() => {
      xhr.reportProgress(400, 1000);
    });
    expect(within(dialog).getByRole('progressbar', { name: 'uploading…' })).toHaveAttribute('value', '40');
    act(() => {
      xhr.reportBodySent();
    });
    expect(status).toHaveTextContent('saving…');
    expect(within(dialog).getByRole('progressbar', { name: 'saving…' })).toHaveAttribute('value', '100');

    await waitFor(() => {
      expect(received).toHaveLength(1);
    });
    // One multipart part named `avatar`, under a neutral filename: the local one never leaves the browser.
    expect(received[0]).toEqual({ method: 'PUT', csrf: TEST_CSRF_TOKEN, fileName: 'avatar' });

    response.open();

    await waitFor(() => {
      expect(dialog).toHaveProperty('open', false);
    });
    expect(cachedUser(store)).toEqual(MIRA_WITH_NEW_AVATAR);
    expect(headerPicture()).toHaveAttribute('src', NEW_AVATAR_URL);
    expect(trigger()).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(MESSAGES.saved);
  });

  it('refetches the own profile and every list with avatars, and nothing else (F-37)', async () => {
    const requests: Record<string, number> = {};
    let meRequests = 0;
    server.use(
      csrfTokenHandler(),
      http.put(UPLOAD_URL, () => HttpResponse.json({ user: MIRA_WITH_NEW_AVATAR })),
      http.get(apiUrl('/me'), () => {
        meRequests += 1;
        return HttpResponse.json({ user: MIRA_WITH_NEW_AVATAR });
      }),
      http.get(apiUrl('/probe/:name'), ({ params }) => {
        const name = String(params['name']);
        requests[name] = (requests[name] ?? 0) + 1;
        return HttpResponse.json({ name });
      }),
    );
    const { user, store } = await renderSignedIn();
    const probes = Object.keys(PROBE_TAGS);
    const subscriptions = probes.map((name) => store.dispatch(probeApi.endpoints.probe.initiate(name)));
    await Promise.all(subscriptions);
    expect(Object.keys(requests)).toHaveLength(probes.length);

    await openDialog(user);
    await user.upload(fileInput(), imageFile());
    await user.click(saveButton());

    await waitFor(() => {
      expect(requests).toEqual({
        'own-profile': 2,
        'other-profile': 1,
        chat: 2,
        wall: 2,
        friendships: 2,
        presence: 2,
      });
    });
    // `Me` is written from the response, not refetched.
    expect(meRequests).toBe(0);
    expect(cachedUser(store)).toEqual(MIRA_WITH_NEW_AVATAR);
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
  });

  it.each([
    ['a 415 for bytes that are no image', () => problemResponse(415, 'unsupported-media-type'), MESSAGES.type],
    ['a 413 problem', () => problemResponse(413, 'file-too-large'), MESSAGES.size],
    [
      "nginx's own 413 page (not JSON)",
      () =>
        new HttpResponse('<html><body>413 Request Entity Too Large</body></html>', {
          status: 413,
          headers: { 'content-type': 'text/html' },
        }),
      MESSAGES.size,
    ],
    ['a 422 for too many pixels', () => problemResponse(422, 'validation-failed'), MESSAGES.pixels],
    ['a network failure', () => HttpResponse.error(), MESSAGES.network],
  ])('shows %s in the dialog and keeps the current picture (B-97)', async (_case, reply, message) => {
    server.use(csrfTokenHandler(), http.put(UPLOAD_URL, reply));
    const { user, store } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile());

    await user.click(saveButton());

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(dialog).toHaveProperty('open', true);
    expect(cachedUser(store)).toEqual(MIRA);
    expect(within(dialog).queryByRole('progressbar')).not.toBeInTheDocument();
    // The same file may be sent again (the failure may have been temporary).
    expect(saveButton()).toBeEnabled();
    expect(saveButton()).not.toHaveAttribute('aria-disabled');
  });

  it('clears a server error when another file is chosen', async () => {
    server.use(
      csrfTokenHandler(),
      http.put(UPLOAD_URL, () => problemResponse(415, 'unsupported-media-type')),
    );
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile('renamed.png'));
    await user.click(saveButton());
    await within(dialog).findByRole('alert');

    await user.upload(fileInput(), imageFile('portrait.png'));

    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries once with a fresh token when the session rotated (csrf-invalid)', async () => {
    const tokens = ['stale-token', 'fresh-token'];
    const sentTokens: (string | null)[] = [];
    server.use(
      http.get(apiUrl('/csrf-token'), () => HttpResponse.json({ token: tokens.shift() ?? 'unexpected' })),
      http.put(UPLOAD_URL, ({ request }) => {
        const token = request.headers.get('x-csrf-token');
        sentTokens.push(token);
        return token === 'fresh-token'
          ? HttpResponse.json({ user: MIRA_WITH_NEW_AVATAR })
          : problemResponse(403, 'csrf-invalid');
      }),
    );
    const { user, store } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile());

    await user.click(saveButton());

    await waitFor(() => {
      expect(dialog).toHaveProperty('open', false);
    });
    expect(sentTokens).toEqual(['stale-token', 'fresh-token']);
    expect(cachedUser(store)).toEqual(MIRA_WITH_NEW_AVATAR);
  });

  it('signals an expired session once for a signed-in user (F-22)', async () => {
    server.use(
      csrfTokenHandler(),
      http.put(UPLOAD_URL, () => problemResponse(401, 'unauthorized')),
    );
    const { user, actionsOfType } = await renderSignedIn();
    await openDialog(user);
    await user.upload(fileInput(), imageFile());

    await user.click(saveButton());

    await waitFor(() => {
      expect(actionsOfType('session/expired')).toHaveLength(1);
    });
  });

  it('shows the error when no CSRF token can be loaded, without sending the file', async () => {
    server.use(http.get(apiUrl('/csrf-token'), () => HttpResponse.error()));
    const { user } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile());

    await user.click(saveButton());

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(MESSAGES.network);
    expect(sentRequests).toHaveLength(0);
  });

  it('cancels the upload when the dialog closes while it runs, then refetches the user', async () => {
    const response = gate();
    let meRequests = 0;
    server.use(
      csrfTokenHandler(),
      http.put(UPLOAD_URL, async () => {
        await response.opened;
        return HttpResponse.json({ user: MIRA_WITH_NEW_AVATAR });
      }),
      http.get(apiUrl('/me'), () => {
        meRequests += 1;
        return HttpResponse.json({ user: MIRA });
      }),
    );
    const { user, store } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile());
    await user.click(saveButton());
    const xhr = await sentRequest();
    act(() => {
      xhr.reportBodySent();
    });

    await user.click(within(dialog).getByRole('button', { name: 'close' }));

    expect(dialog).toHaveProperty('open', false);
    expect(xhr.aborted).toBe(true);
    // The body had been sent, so the server may have saved it: the user is fetched instead of guessed.
    await waitFor(() => {
      expect(meRequests).toBe(1);
    });
    expect(cachedUser(store)).toEqual(MIRA);
    expect(screen.queryByText(MESSAGES.saved)).not.toBeInTheDocument();
    response.open();
  });

  it('cancels without a refetch when the body had not left yet', async () => {
    const response = gate();
    server.use(
      csrfTokenHandler(),
      http.put(UPLOAD_URL, async () => {
        await response.opened;
        return HttpResponse.json({ user: MIRA_WITH_NEW_AVATAR });
      }),
    );
    const { user, store } = await renderSignedIn();
    const dialog = await openDialog(user);
    await user.upload(fileInput(), imageFile());
    await user.click(saveButton());
    const xhr = await sentRequest();

    await user.click(within(dialog).getByRole('button', { name: 'close' }));

    expect(xhr.aborted).toBe(true);
    // No `/me` handler: a refetch would fail the test as an unhandled request.
    expect(cachedUser(store)).toEqual(MIRA);
    response.open();
  });
});

/** Stand-ins for the queries of other features, one per tag the upload must (or must not) invalidate. */
const PROBE_TAGS: Record<string, TagDescription<TagType>[]> = {
  'own-profile': [{ type: 'User', id: MIRA.id }],
  'other-profile': [{ type: 'User', id: 2 }],
  chat: ['Chat'],
  wall: [{ type: 'Wall', id: 2 }],
  friendships: ['Friendships'],
  presence: ['Presence'],
};

const probeApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    probe: build.query<{ name: string }, string>({
      query: (name) => `/probe/${name}`,
      providesTags: (_result, _error, name) => PROBE_TAGS[name] ?? [],
    }),
  }),
});
