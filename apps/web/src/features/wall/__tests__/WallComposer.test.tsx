import type { WallPost } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
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
import { WallComposer } from '../components/WallComposer';
import { socket } from './fakes';

vi.mock('../../../shared/realtime/socket', async () => (await import('./fakes')).socketModule);

const ADA = { id: 2, firstName: 'Ada', lastName: 'Brennan', avatarUrl: null };
const JONAS = { id: 3, firstName: 'Jonas', lastName: 'Lindqvist', avatarUrl: null };
const MIRA_SUMMARY = { id: MIRA.id, firstName: MIRA.firstName, lastName: MIRA.lastName, avatarUrl: MIRA.avatarUrl };

let nextPostId = 500;

function post(author: WallPost['author'], body: string): WallPost {
  nextPostId += 1;
  return { id: nextPostId, wallOwnerId: ADA.id, author, body, createdAt: new Date().toISOString() };
}

/** `POST /api/users/2/posts` answering like the API (201, the stored post), recording what was sent. */
function createPostHandler(respond?: (body: string) => Promise<Response> | Response) {
  const sent: { body: unknown; csrf: string | null }[] = [];
  const handler = http.post(apiUrl('/users/2/posts'), async ({ request }) => {
    const json = (await request.json()) as { body: string };
    sent.push({ body: json, csrf: request.headers.get('x-csrf-token') });
    if (respond !== undefined) {
      return respond(json.body);
    }
    return HttpResponse.json({ post: post(MIRA_SUMMARY, json.body) }, { status: 201 });
  });
  return { handler, sent };
}

async function renderComposer() {
  const { store } = createTestStore();
  await signInAs(store);
  return renderWithProviders(<WallComposer ownerId={ADA.id} ownerFirstName={ADA.firstName} />, { store });
}

function field() {
  return screen.getByRole('textbox', { name: "write on Ada's wall" });
}

beforeEach(() => {
  socket.reset();
});

describe('WallComposer', () => {
  it('F-75: has a visible label naming the wall, the shortcut hint and a character count', async () => {
    await renderComposer();

    expect(screen.getByText("write on Ada's wall")).toBeVisible();
    expect(field()).toHaveAccessibleDescription(/Ctrl\+Enter or Cmd\+Enter posts it\./);
    expect(field()).toHaveAccessibleDescription(/2,000 characters left/);
    expect(screen.getByRole('button', { name: 'post' })).toHaveAttribute('type', 'submit');
  });

  it('F-67: an empty or blank post is not sent and says what to do', async () => {
    const { user } = await renderComposer();

    await user.click(screen.getByRole('button', { name: 'post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write something first.');
    expect(field()).toHaveAttribute('aria-invalid', 'true');

    await user.type(field(), '   ');
    await user.click(screen.getByRole('button', { name: 'post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write something first.');
  });

  it('F-67: more than 2,000 characters is counted and refused before sending', async () => {
    const { user } = await renderComposer();

    await user.click(field());
    await user.paste('a'.repeat(2001));

    expect(screen.getByText('1 character too many')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep your post under 2,000 characters.');
  });

  it('F-66, F-73: posts the trimmed text with the CSRF token, then clears the draft and says so', async () => {
    const { handler, sent } = createPostHandler();
    server.use(csrfTokenHandler(), handler);
    const { user } = await renderComposer();

    await user.type(field(), '  Dinner at ours on Friday?  ');
    await user.click(screen.getByRole('button', { name: 'post' }));

    await waitFor(() => {
      expect(field()).toHaveValue('');
    });
    expect(sent).toEqual([{ body: { body: 'Dinner at ours on Friday?' }, csrf: TEST_CSRF_TOKEN }]);
    expect(await screen.findByText('Your post is on the wall.')).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it.each([
    ['Ctrl+Enter', '{Control>}{Enter}{/Control}'],
    ['Cmd+Enter', '{Meta>}{Enter}{/Meta}'],
  ])('F-75: %s submits from the textarea', async (_name, keys) => {
    const { handler, sent } = createPostHandler();
    server.use(csrfTokenHandler(), handler);
    const { user } = await renderComposer();

    await user.type(field(), 'Sent with the keyboard.');
    await user.keyboard(keys);

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    await waitFor(() => {
      expect(field()).toHaveValue('');
    });
  });

  it('F-51: "post" is disabled while saving, and text typed meanwhile is kept', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = createPostHandler(async (body) => {
      await gate;
      return HttpResponse.json({ post: post(MIRA_SUMMARY, body) }, { status: 201 });
    });
    server.use(csrfTokenHandler(), handler);
    const { user } = await renderComposer();

    await user.type(field(), 'First thought.');
    await user.keyboard('{Control>}{Enter}{/Control}');

    const busy = await screen.findByRole('button', { name: 'posting…' });
    expect(busy).toBeDisabled();
    await user.type(field(), ' Second thought.');
    release();

    expect(await screen.findByRole('button', { name: 'post' })).toBeEnabled();
    expect(field()).toHaveValue('First thought. Second thought.');
  });

  it('F-53: a refused post keeps the draft and shows the reason', async () => {
    const { handler } = createPostHandler(() => problemResponse(403, 'wall-write-forbidden'));
    server.use(csrfTokenHandler(), handler);
    const { user } = await renderComposer();

    await user.type(field(), 'Are we still on for Sunday?');
    await user.click(screen.getByRole('button', { name: 'post' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Only friends can write on this wall.');
    expect(field()).toHaveValue('Are we still on for Sunday?');
  });

  it('F-67: a field error from the server is shown on the textarea', async () => {
    const { handler } = createPostHandler(() =>
      problemResponse(422, 'validation-failed', {
        errors: [{ location: 'body', path: 'body', message: 'Write something first.' }],
      }),
    );
    server.use(csrfTokenHandler(), handler);
    const { user } = await renderComposer();

    await user.type(field(), 'x');
    await user.click(screen.getByRole('button', { name: 'post' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Write something first.');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(field()).toHaveValue('x');
  });

  it("B-83, F-73: posts from others arriving on the wall never clear the viewer's draft", async () => {
    const existing = post(ADA, 'Who is coming to the market on Saturday?');
    server.use(http.get(apiUrl('/users/2/posts'), () => HttpResponse.json({ items: [existing], nextCursor: null })));
    const { store } = createTestStore();
    await signInAs(store);
    const { user } = renderWithProviders(<Wall ownerId={ADA.id} ownerFirstName={ADA.firstName} canView canPost />, {
      store,
    });
    await screen.findByText(existing.body);

    await user.type(field(), 'Count me in, I will bring');
    socket.fire('wall:post-created', post(JONAS, 'I can bring the big basket.'));
    socket.fire('wall:post-deleted', { id: existing.id, wallOwnerId: ADA.id });

    expect(await screen.findByText('I can bring the big basket.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(existing.body)).not.toBeInTheDocument();
    });
    expect(field()).toHaveValue('Count me in, I will bring');
    expect(within(screen.getByRole('list')).getAllByRole('article')).toHaveLength(1);
  });
});
