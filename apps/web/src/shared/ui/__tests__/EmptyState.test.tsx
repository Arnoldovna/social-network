import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from '../Button';
import { EmptyState } from '../EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('shows one sentence, one line of text and one action (F-56, F-74)', () => {
    render(<EmptyState title="No posts yet." text="Write the first one." action={<Button>write a post</Button>} />);

    expect(screen.getByText('No posts yet.')).toHaveClass('empty-state__title');
    expect(screen.getByText('Write the first one.')).toHaveClass('empty-state__text');
    expect(screen.getByRole('button', { name: 'write a post' })).toBeInTheDocument();
  });

  it('never adds a heading to the page outline (F-103)', () => {
    render(<EmptyState title="Nobody else is online right now." />);

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(document.querySelector('.empty-state__text')).toBeNull();
  });

  it('stands in for a whole page list by default and has a compact size under a section label', () => {
    const { rerender, container } = render(<EmptyState title="No friends yet." />);
    expect(container.firstElementChild).toHaveClass('empty-state');
    expect(container.firstElementChild).not.toHaveClass('empty-state--section');

    rerender(<EmptyState size="section" title="No friends yet." />);
    expect(container.firstElementChild).toHaveClass('empty-state', 'empty-state--section');
  });
});
