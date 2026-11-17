import { SEARCH_LIMIT_DEFAULT } from '@app/shared';
import type { UserSummary } from '@app/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useParams } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as DebouncedValueModule from '../../../shared/lib/use-debounced-value';

import { apiUrl, HttpResponse, http, problemResponse, server } from '../../../shared/test/msw';
import { renderWithProviders } from '../../../shared/test/render';
import { HeaderSearch } from '../components/HeaderSearch';

/*
 * The real debounce, except that a test can hold it: the debounced value then stays what it was at mount, as if the
 * user were still typing. That proves "Enter searches at once" without racing a wall clock (fake timers would also
 * stop RTK Query's own scheduling).
 */
const debounce = vi.hoisted(() => ({ held: false }));

vi.mock('../../../shared/lib/use-debounced-value', async (importOriginal) => {
  const actual = await importOriginal<typeof DebouncedValueModule>();
  return {
    ...actual,
    useDebouncedValue: <T,>(value: T, delayMs?: number): T => {
      const settled = actual.useDebouncedValue(value, delayMs);
      const [atMount] = useState(value);
      return debounce.held ? atMount : settled;
    },
  };
});

afterEach(() => {
  debounce.held = false;
});

const MILAN: UserSummary = {
  id: 4,
  firstName: 'Milan',
  lastName: 'Horvat',
  avatarUrl: '/api/users/4/avatar?v=2c6d1e8a-5f43-4b9e-a7d2-91c3e0f4b5a6',
};
const MINA: UserSummary = { id: 7, firstName: 'Mina', lastName: 'Okafor', avatarUrl: null };
const MIRIAM: UserSummary = { id: 12, firstName: 'Miriam', lastName: 'Lindqvist', avatarUrl: null };

const PEOPLE = [MILAN, MINA, MIRIAM];

interface SearchRequest {
  q: string | null;
  limit: string | null;
}

/**
 * `GET /api/users/search` answering like the API (prefix match on first or last name, case-insensitive). Every
 * request is recorded, so tests can count them.
 */
function answerSearches(people: readonly UserSummary[] = PEOPLE) {
  const requests: SearchRequest[] = [];
  server.use(
    http.get(apiUrl('/users/search'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      const q = params.get('q');
      requests.push({ q, limit: params.get('limit') });
      const needle = (q ?? '').toLowerCase();
      const items = people.filter(
        (person) =>
          person.firstName.toLowerCase().startsWith(needle) || person.lastName.toLowerCase().startsWith(needle),
      );
      return HttpResponse.json({ items });
    }),
  );
  return requests;
}

function ProfileStandIn() {
  const { id } = useParams();
  return <h1>profile of user {id}</h1>;
}

/** The search with a button beside it (something to click "outside") and a stand-in profile route. */
function renderSearch({ onKeyDown }: { onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void } = {}) {
  const result = renderWithProviders(
    <div onKeyDown={onKeyDown}>
      <HeaderSearch />
      <button type="button">outside</button>
    </div>,
    { routes: [{ path: '/users/:id', element: <ProfileStandIn /> }] },
  );
  const input = screen.getByRole('combobox', { name: 'find people' });
  return { ...result, input };
}

async function openResults(user: ReturnType<typeof renderSearch>['user'], input: HTMLElement, text = 'mi') {
  await user.type(input, text);
  return screen.findByRole('listbox', { name: 'find people' });
}

describe('HeaderSearch', () => {
  it('F-59: is a labelled "find people" combobox inside a search landmark', () => {
    const { input } = renderSearch();

    expect(screen.getByRole('search')).toContainElement(input);
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('maxlength', '100');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('F-59: searches once after typing stops, with the trimmed query and the default limit', async () => {
    const requests = answerSearches();
    const { user, input } = renderSearch();

    const listbox = await openResults(user, input, '  mi ');

    expect(requests).toEqual([{ q: 'mi', limit: String(SEARCH_LIMIT_DEFAULT) }]);
    expect(within(listbox).getAllByRole('option')).toEqual([
      screen.getByRole('option', { name: 'Milan Horvat' }),
      screen.getByRole('option', { name: 'Mina Okafor' }),
      screen.getByRole('option', { name: 'Miriam Lindqvist' }),
    ]);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
  });

  it('F-59: Enter searches at once instead of waiting for the debounce', async () => {
    debounce.held = true;
    const requests = answerSearches();
    const { user, input } = renderSearch();

    await user.type(input, 'mina');
    expect(screen.getByRole('status')).toHaveTextContent('searching…');
    expect(requests).toEqual([]);

    await user.keyboard('{Enter}');

    expect(await screen.findByRole('option', { name: 'Mina Okafor' })).toBeInTheDocument();
    expect(requests).toEqual([{ q: 'mina', limit: String(SEARCH_LIMIT_DEFAULT) }]);
  });

  it('F-59: typing on after Enter goes back to the debounced search', async () => {
    debounce.held = true;
    const requests = answerSearches();
    const { user, input } = renderSearch();

    await user.type(input, 'mi{Enter}');
    await screen.findByRole('listbox');
    await user.type(input, 'n');

    expect(screen.getByRole('status')).toHaveTextContent('searching…');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(requests.map(({ q }) => q)).toEqual(['mi']);
  });

  it('does not search for blank input', async () => {
    const requests = answerSearches();
    const { user, input } = renderSearch();

    await user.type(input, '   {Enter}');

    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(requests).toEqual([]);
  });

  it('F-62: arrow keys move through the results and wrap; focus stays in the input', async () => {
    answerSearches();
    const { user, input } = renderSearch();
    await openResults(user, input);
    const [milan, mina, miriam] = screen.getAllByRole('option');

    expect(input).not.toHaveAttribute('aria-activedescendant');

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', milan?.id);
    expect(milan).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', miriam?.id);
    expect(milan).toHaveAttribute('aria-selected', 'false');

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', milan?.id);

    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', miriam?.id);

    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', mina?.id);
    expect(input).toHaveFocus();
  });

  it('F-62: Enter on the active result opens its profile and closes the list', async () => {
    answerSearches();
    const { user, input, router } = renderSearch();
    await openResults(user, input);

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(await screen.findByRole('heading', { name: 'profile of user 7' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/users/7');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('B-93: every result is a link to /users/:id that a click follows', async () => {
    answerSearches();
    const { user, input, router } = renderSearch();
    await openResults(user, input);

    expect(screen.getAllByRole('option').map((option) => option.getAttribute('href'))).toEqual([
      '/users/4',
      '/users/7',
      '/users/12',
    ]);

    await user.click(screen.getByRole('option', { name: 'Miriam Lindqvist' }));

    expect(await screen.findByRole('heading', { name: 'profile of user 12' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/users/12');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('B-94: Escape closes the list, keeps the text and focus, and only then lets Escape through', async () => {
    answerSearches();
    const escapes: boolean[] = [];
    const { user, input } = renderSearch({
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          escapes.push(event.defaultPrevented);
        }
      },
    });
    await openResults(user, input);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveValue('mi');
    expect(input).toHaveFocus();

    // The second Escape is not the search's: the header menu around it may use it.
    await user.keyboard('{Escape}');
    expect(escapes).toEqual([true, false]);

    // ArrowDown reopens the list on the first result.
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]?.id);
  });

  it('B-94: clicking outside closes the list', async () => {
    answerSearches();
    const { user, input } = renderSearch();
    await openResults(user, input);

    await user.click(screen.getByRole('button', { name: 'outside' }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('F-62: moving focus out of the search with Tab closes the list', async () => {
    answerSearches();
    const { user, input } = renderSearch();
    await openResults(user, input);

    await user.tab();

    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('announces the number of results in a polite live region', async () => {
    answerSearches();
    const { user, input } = renderSearch();

    await openResults(user, input, 'min');

    expect(screen.getByRole('status')).toHaveTextContent('1 person found.');

    await user.type(input, '{Backspace}');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('3 people found.');
    });
  });

  it('F-63, B-49: no match shows "No people found for …" instead of a list', async () => {
    answerSearches();
    const { user, input } = renderSearch();

    await user.type(input, 'zq');

    expect(await screen.findByText('No people found for "zq".')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('No people found for "zq".');
    expect(screen.getByText('Try the beginning of a first or last name.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows "searching…" until the answer arrives', async () => {
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.use(
      http.get(apiUrl('/users/search'), async () => {
        await answered;
        return HttpResponse.json({ items: [MINA] });
      }),
    );
    const { user, input } = renderSearch();

    await user.type(input, 'mina');

    expect(screen.getByRole('status')).toHaveTextContent('searching…');
    answer();
    expect(await screen.findByRole('option', { name: 'Mina Okafor' })).toBeInTheDocument();
  });

  it('F-105: a failed search says so and "try again" searches again', async () => {
    let calls = 0;
    server.use(
      http.get(apiUrl('/users/search'), () => {
        calls += 1;
        return calls === 1 ? problemResponse(429, 'rate-limited') : HttpResponse.json({ items: [MINA] });
      }),
    );
    const { user, input } = renderSearch();

    await user.type(input, 'mina');

    expect(await screen.findByText('Too many requests. Wait a moment and try again.')).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'try again' }));

    expect(await screen.findByRole('option', { name: 'Mina Okafor' })).toBeInTheDocument();
    expect(calls).toBe(2);
    expect(input).toHaveFocus();
  });

  it('treats a response with fields beyond UserSummary as an error, never as data', async () => {
    server.use(
      http.get(apiUrl('/users/search'), () =>
        HttpResponse.json({ items: [{ ...MINA, email: 'mina.okafor@example.com' }] }),
      ),
    );
    const { user, input } = renderSearch();

    await user.type(input, 'mina');

    expect(await screen.findByText('The server sent an unexpected answer. Please try again.')).toBeVisible();
    expect(screen.queryByText('Mina Okafor')).not.toBeInTheDocument();
  });

  it('shows avatars as decorative pictures, so each result is named by the person alone', async () => {
    answerSearches([MILAN]);
    const { user, input } = renderSearch();

    await openResults(user, input);

    const option = screen.getByRole('option', { name: 'Milan Horvat' });
    expect(within(option).getByRole('presentation')).toHaveAttribute('alt', '');
  });
});
