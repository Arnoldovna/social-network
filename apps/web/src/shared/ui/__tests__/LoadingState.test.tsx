import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LoadingState } from '../LoadingState';

afterEach(cleanup);

describe('LoadingState', () => {
  it('says "loading…" in a polite status region (F-25)', () => {
    render(<LoadingState />);

    expect(screen.getByRole('status')).toHaveTextContent('loading…');
  });

  it('names what is loading', () => {
    render(<LoadingState label="loading posts…" />);

    expect(screen.getByRole('status')).toHaveTextContent('loading posts…');
  });
});
