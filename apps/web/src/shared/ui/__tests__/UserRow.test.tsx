import type { UserSummary } from '@app/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from '../Button';
import { UserRow } from '../UserRow';

afterEach(cleanup);

const ada: UserSummary = {
  id: 12,
  firstName: 'Ada',
  lastName: 'Brennan',
  avatarUrl: '/api/users/12/avatar?v=0f5b8c1e-4c1d-4f7e-9a39-3c3b5b0f2d11',
};

describe('UserRow', () => {
  it("links the person's name to their profile (F-54, F-86)", () => {
    render(
      <MemoryRouter>
        <ul>
          <UserRow user={ada} />
        </ul>
      </MemoryRouter>,
    );

    const item = screen.getByRole('listitem');
    const link = within(item).getByRole('link', { name: 'Ada Brennan' });
    expect(link).toHaveAttribute('href', '/users/12');
    expect(within(item).getByRole('img', { name: "Ada Brennan's profile picture" })).toBeInTheDocument();
  });

  it('shows the name like every other place in the UI, without a stray space for a blank part', () => {
    render(
      <MemoryRouter>
        <ul>
          <UserRow user={{ ...ada, lastName: ' ' }} />
        </ul>
      </MemoryRouter>,
    );

    // The accessible name is whitespace-normalised, so the text itself is compared.
    expect(screen.getByRole('link').textContent).toBe('Ada');
  });

  it('shows the meta line and the actions', () => {
    render(
      <MemoryRouter>
        <ul>
          <UserRow user={ada} meta="request sent 15 Nov 2026" actions={<Button>cancel</Button>} />
        </ul>
      </MemoryRouter>,
    );

    expect(screen.getByText('request sent 15 Nov 2026')).toHaveClass('user-row__meta');
    expect(screen.getByRole('button', { name: 'cancel' }).parentElement).toHaveClass('user-row__actions');
  });

  it('leaves out empty meta and actions', () => {
    render(
      <MemoryRouter>
        <ul>
          <UserRow user={{ ...ada, avatarUrl: null }} />
        </ul>
      </MemoryRouter>,
    );

    expect(document.querySelector('.user-row__meta')).toBeNull();
    expect(document.querySelector('.user-row__actions')).toBeNull();
    expect(screen.getByRole('img', { name: "Ada Brennan's profile picture" })).toHaveTextContent('AB');
  });

  it('renders as a div outside lists', () => {
    const { container } = render(
      <MemoryRouter>
        <UserRow user={ada} as="div" />
      </MemoryRouter>,
    );

    expect(container.firstElementChild?.tagName).toBe('DIV');
    expect(container.firstElementChild).toHaveClass('user-row');
  });
});
