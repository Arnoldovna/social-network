import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { VisuallyHidden } from '../VisuallyHidden';

afterEach(cleanup);

describe('VisuallyHidden', () => {
  it('keeps text for assistive technology, styled by the utilities.css class', () => {
    render(
      <button type="button">
        accept <VisuallyHidden>the friend request from Ada Brennan</VisuallyHidden>
      </button>,
    );

    expect(screen.getByRole('button', { name: 'accept the friend request from Ada Brennan' })).toBeInTheDocument();
    expect(screen.getByText('the friend request from Ada Brennan')).toHaveAttribute('class', 'visually-hidden');
  });

  it('can be a block live region', () => {
    render(
      <VisuallyHidden as="div" role="status" id="search-status">
        3 people found
      </VisuallyHidden>,
    );

    const region = screen.getByRole('status');
    expect(region.tagName).toBe('DIV');
    expect(region).toHaveAttribute('id', 'search-status');
    expect(region).toHaveTextContent('3 people found');
  });
});
