import { BIO_MAX } from '@app/shared';
import type { Me } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createTestStore, MIRA, signInAs } from '../../../shared/api/__tests__/fixtures';
import { selectCurrentUser } from '../../../shared/api/me.api';
import {
  apiUrl,
  csrfTokenHandler,
  HttpResponse,
  http,
  problemResponse,
  server,
  TEST_CSRF_TOKEN,
} from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { OwnProfilePage } from '../pages/OwnProfilePage';

// Rule 7: the own profile composes the wall and the avatar button; trivial stand-ins keep these tests independent of
// the sibling units and their network calls.
vi.mock('../../wall', () => ({
  Wall: (props: { ownerId: number; ownerFirstName: string; canView: boolean; canPost: boolean }) => (
    <section
      aria-label="wall stand-in"
      data-owner-id={props.ownerId}
      data-can-view={String(props.canView)}
      data-can-post={String(props.canPost)}
    />
  ),
}));
vi.mock('../../avatars', () => ({
  AvatarButton: ({ variant }: { variant: 'header' | 'profile' }) => (
    <button type="button" data-variant={variant}>
      Change profile picture
    </button>
  ),
}));

const WITHOUT_BIO: Me = { ...MIRA, bio: null };

async function renderOwnProfile(user: Me = MIRA) {
  const { store } = createTestStore();
  await signInAs(store, user);
  return renderWithProviders(<OwnProfilePage />, { store });
}

interface RecordedPatch {
  body: unknown;
  csrfToken: string | null;
}

/** `PATCH /api/me` answering like the API (trimmed, blank → null), recording what the client sent. */
function patchMeHandler(patches: RecordedPatch[], user: Me = MIRA) {
  return http.patch(apiUrl('/me'), async ({ request }) => {
    const body = (await request.json()) as { bio: string | null };
    patches.push({ body, csrfToken: request.headers.get('x-csrf-token') });
    return HttpResponse.json({ user: { ...user, bio: body.bio } });
  });
}

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

function bioField() {
  return screen.getByRole('textbox', { name: 'bio' });
}

describe('OwnProfilePage (F-24, F-25)', () => {
  it('F-24: shows the avatar button, the full name as the only h1, the bio and the own wall', async () => {
    await renderOwnProfile();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Mira Novak' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change profile picture' })).toHaveAttribute('data-variant', 'profile');
    expect(screen.getByText(MIRA.bio ?? '')).toBeInTheDocument();
    const wall = screen.getByRole('region', { name: 'wall stand-in' });
    expect(wall).toHaveAttribute('data-owner-id', String(MIRA.id));
    expect(wall).toHaveAttribute('data-can-view', 'true');
    expect(wall).toHaveAttribute('data-can-post', 'true');
    expect(document.title).toBe("Mira Novak · Let's chat!");
  });

  it('F-25, B-82: shows "loading profile…" instead of a blank page until the user arrived', async () => {
    const { promise, release } = gate();
    server.use(
      http.get(apiUrl('/me'), async () => {
        await promise;
        return HttpResponse.json({ user: MIRA });
      }),
    );

    renderWithProviders(<OwnProfilePage />);

    expect(await screen.findByRole('status')).toHaveTextContent('loading profile…');
    expect(screen.queryByRole('heading', { name: 'Mira Novak' })).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Novak' })).toBeInTheDocument();
  });

  it('B-82: shows an error with "try again" when the user cannot be loaded, and recovers', async () => {
    let fail = true;
    server.use(
      http.get(apiUrl('/me'), () => (fail ? problemResponse(500, 'internal') : HttpResponse.json({ user: MIRA }))),
    );
    const { user } = renderWithProviders(<OwnProfilePage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your profile could not be loaded.');
    expect(alert).toHaveTextContent('Something went wrong on our side. Please try again.');

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Novak' })).toBeInTheDocument();
  });
});

describe('BioEditor (F-26–F-32)', () => {
  it('F-26: without a bio, says so and offers "add bio"', async () => {
    await renderOwnProfile(WITHOUT_BIO);

    expect(screen.getByText('You have not written a bio yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'add bio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edit bio' })).not.toBeInTheDocument();
  });

  it('F-32: renders the bio as plain text with its line breaks, never as HTML', async () => {
    const bio = 'Glazes <b>everything</b>.\n<img src=x onerror=alert(1)>\nThird line.';
    await renderOwnProfile({ ...MIRA, bio });

    const text = screen.getByText((_content, element) => element?.textContent === bio && element.tagName === 'P');
    expect(text.querySelector('b, img')).toBeNull();
    expect(text.textContent).toContain('\n');
  });

  it('F-27, B-77: "edit bio" opens a labelled textarea prefilled with the current bio, focused', async () => {
    const { user } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));

    expect(bioField()).toHaveValue(MIRA.bio);
    expect(bioField()).toHaveFocus();
    expect(screen.getByRole('button', { name: 'save' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'cancel' })).toBeInTheDocument();
  });

  it('F-28, B-77: saving without changes sends nothing and keeps the bio', async () => {
    const patches: RecordedPatch[] = [];
    server.use(patchMeHandler(patches));
    const { user } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(screen.queryByRole('textbox', { name: 'bio' })).not.toBeInTheDocument();
    expect(screen.getByText(MIRA.bio ?? '')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'edit bio' })).toHaveFocus();
    expect(patches).toEqual([]);
  });

  it('F-28: only whitespace added around the bio counts as no change (it is trimmed)', async () => {
    const patches: RecordedPatch[] = [];
    server.use(patchMeHandler(patches));
    const { user } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.type(bioField(), '   ');
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(screen.queryByRole('textbox', { name: 'bio' })).not.toBeInTheDocument();
    expect(patches).toEqual([]);
  });

  it('saves a changed bio trimmed, with the CSRF header, updates the cached user and returns focus', async () => {
    const patches: RecordedPatch[] = [];
    server.use(csrfTokenHandler(), patchMeHandler(patches));
    const { user, store } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.clear(bioField());
    await user.type(bioField(), '  Throwing bowls in Leipzig.{Enter}Maps on weekdays.  ');
    await user.click(screen.getByRole('button', { name: 'save' }));

    const saved = 'Throwing bowls in Leipzig.\nMaps on weekdays.';
    expect(await screen.findByRole('button', { name: 'edit bio' })).toHaveFocus();
    expect(patches).toEqual([{ body: { bio: saved }, csrfToken: TEST_CSRF_TOKEN }]);
    expect(
      screen.getByText((_content, element) => element?.textContent === saved && element.tagName === 'P'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your bio was saved.');
    expect(selectCurrentUser(store.getState())?.bio).toBe(saved);
  });

  it('F-28: emptying the field is an explicit change and removes the bio', async () => {
    const patches: RecordedPatch[] = [];
    server.use(csrfTokenHandler(), patchMeHandler(patches));
    const { user } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.clear(bioField());
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(await screen.findByText('You have not written a bio yet.')).toBeInTheDocument();
    expect(patches).toEqual([{ body: { bio: null }, csrfToken: TEST_CSRF_TOKEN }]);
    expect(screen.getByRole('button', { name: 'add bio' })).toHaveFocus();
  });

  it('F-29: shows the remaining characters live, counted after trimming', async () => {
    const { user } = await renderOwnProfile(WITHOUT_BIO);

    await user.click(screen.getByRole('button', { name: 'add bio' }));
    expect(screen.getByText('1,000 characters left')).toBeInTheDocument();

    await user.type(bioField(), '  Hello');
    expect(screen.getByText('995 characters left')).toBeInTheDocument();
    expect(bioField()).toHaveAccessibleDescription(expect.stringContaining('995 characters left'));
  });

  it('F-29: refuses more than 1,000 characters on the client, without a request', async () => {
    const patches: RecordedPatch[] = [];
    server.use(patchMeHandler(patches));
    const { user } = await renderOwnProfile(WITHOUT_BIO);

    await user.click(screen.getByRole('button', { name: 'add bio' }));
    await user.click(bioField());
    await user.paste('a'.repeat(BIO_MAX + 1));
    expect(screen.getByText('1 character too many')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(await screen.findByText('Keep your bio under 1,000 characters.')).toBeInTheDocument();
    expect(bioField()).toHaveAttribute('aria-invalid', 'true');
    expect(patches).toEqual([]);
  });

  it('F-29, F-31: shows the server’s 422 field error under the textarea and keeps the draft', async () => {
    server.use(
      csrfTokenHandler(),
      http.patch(apiUrl('/me'), () =>
        problemResponse(422, 'validation-failed', {
          errors: [{ location: 'body', path: 'bio', message: 'Keep your bio under 1,000 characters.' }],
        }),
      ),
    );
    const { user } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.type(bioField(), ' More.');
    await user.click(screen.getByRole('button', { name: 'save' }));

    expect(await screen.findByText('Keep your bio under 1,000 characters.')).toBeInTheDocument();
    expect(bioField()).toHaveValue(`${MIRA.bio ?? ''} More.`);
    expect(bioField()).toHaveAttribute('aria-invalid', 'true');
  });

  it('F-31: a failed save keeps the editor open with the draft and shows an error', async () => {
    server.use(
      csrfTokenHandler(),
      http.patch(apiUrl('/me'), () => problemResponse(500, 'internal')),
    );
    const { user, store } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.clear(bioField());
    await user.type(bioField(), 'A new bio.');
    await user.click(screen.getByRole('button', { name: 'save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side. Please try again.');
    expect(bioField()).toHaveValue('A new bio.');
    expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
    expect(selectCurrentUser(store.getState())?.bio).toBe(MIRA.bio);
  });

  it('disables "save" and "cancel" while the save is running', async () => {
    const { promise, release } = gate();
    server.use(
      csrfTokenHandler(),
      http.patch(apiUrl('/me'), async () => {
        await promise;
        return HttpResponse.json({ user: { ...MIRA, bio: 'Short.' } });
      }),
    );
    const { user } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.clear(bioField());
    await user.type(bioField(), 'Short.');
    await user.click(screen.getByRole('button', { name: 'save' }));

    const busy = await screen.findByRole('button', { name: 'saving…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();

    release();
    expect(await screen.findByText('Short.')).toBeInTheDocument();
  });

  it('F-30: cancel restores the previous bio and returns focus to the edit button', async () => {
    const { user } = await renderOwnProfile();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    await user.clear(bioField());
    await user.type(bioField(), 'Something else entirely.');
    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(screen.queryByRole('textbox', { name: 'bio' })).not.toBeInTheDocument();
    expect(screen.getByText(MIRA.bio ?? '')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'edit bio' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'edit bio' }));
    expect(bioField()).toHaveValue(MIRA.bio);
  });

  it('F-30: Escape in the textarea cancels like the button', async () => {
    const { user } = await renderOwnProfile(WITHOUT_BIO);

    await user.click(screen.getByRole('button', { name: 'add bio' }));
    await user.type(bioField(), 'Draft');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'add bio' })).toHaveFocus();
    });
    expect(screen.getByText('You have not written a bio yet.')).toBeInTheDocument();
  });
});
