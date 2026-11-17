import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorState } from '../ErrorState';

afterEach(cleanup);

describe('ErrorState', () => {
  it('says what happened and what to do, and retries (F-105)', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This could not be loaded.');
    expect(alert).toHaveTextContent('Check your connection, then try again.');

    await user.click(screen.getByRole('button', { name: 'try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('takes its own sentences and disables the button while retrying', () => {
    render(
      <ErrorState
        title="The friends list could not be loaded."
        message="Please try again in a moment."
        onRetry={vi.fn()}
        retrying
      />,
    );

    expect(screen.getByText('The friends list could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Please try again in a moment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'try again' })).toBeDisabled();
  });

  it('shows no button without a retry handler', () => {
    render(<ErrorState />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
