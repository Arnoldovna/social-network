import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast, toastMessage } from '../Toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('Toast', () => {
  it('keeps an empty polite and an empty assertive live region mounted while there is no message', () => {
    render(<Toast message={null} onDismiss={vi.fn()} />);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(screen.getByRole('status').parentElement).toHaveClass('toast-region');
  });

  it('shows the sentence with a "dismiss" button', () => {
    const onDismiss = vi.fn();
    render(<Toast message={toastMessage('Your bio is saved.')} onDismiss={onDismiss} />);

    expect(screen.getByRole('status')).toHaveTextContent('Your bio is saved.');
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('hides a status after six seconds', () => {
    const onDismiss = vi.fn();
    render(<Toast message={toastMessage('Your bio is saved.')} onDismiss={onDismiss} />);

    advance(5999);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('never hides sooner than six seconds', () => {
    const onDismiss = vi.fn();
    render(<Toast message={toastMessage('Your bio is saved.')} onDismiss={onDismiss} duration={1000} />);

    advance(5999);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('announces an error assertively and keeps it until dismissed', () => {
    const onDismiss = vi.fn();
    render(
      <Toast
        tone="error"
        message={toastMessage('The request could not be sent. Please try again.')}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The request could not be sent. Please try again.');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByText('The request could not be sent. Please try again.').parentElement).toHaveClass(
      'toast',
      'toast--error',
    );
    advance(60_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('pauses while the pointer is over it and restarts the full time after', () => {
    const onDismiss = vi.fn();
    render(<Toast message={toastMessage('Friend request sent.')} onDismiss={onDismiss} />);
    const toast = screen.getByText('Friend request sent.').parentElement;
    if (toast === null) {
      throw new Error('toast not rendered');
    }

    advance(4000);
    fireEvent.pointerEnter(toast);
    advance(30_000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerLeave(toast);
    advance(5999);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('pauses while focus is inside it', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <Toast message={toastMessage('Friend request sent.')} onDismiss={onDismiss} />
        <button type="button">elsewhere</button>
      </>,
    );

    act(() => {
      screen.getByRole('button', { name: 'dismiss' }).focus();
    });
    advance(30_000);
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      screen.getByRole('button', { name: 'elsewhere' }).focus();
    });
    advance(6000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('does not restart the timer when the parent re-renders with a new callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const saved = toastMessage('Your bio is saved.');
    const { rerender } = render(<Toast message={saved} onDismiss={first} />);

    advance(3000);
    rerender(<Toast message={saved} onDismiss={second} />);
    advance(3000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('starts a fresh time for a new message', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast message={toastMessage('Friend request sent.')} onDismiss={onDismiss} />);

    advance(4000);
    rerender(<Toast message={toastMessage('Friend request cancelled.')} onDismiss={onDismiss} />);
    advance(4000);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Friend request cancelled.');

    advance(2000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('treats the same sentence shown again as a new toast with a fresh time', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast message={toastMessage('Too many requests.')} onDismiss={onDismiss} />);
    const first = screen.getByText('Too many requests.');

    advance(4000);
    rerender(<Toast message={toastMessage('Too many requests.')} onDismiss={onDismiss} />);

    // A new element in the live region, so screen readers announce it again.
    expect(screen.getByText('Too many requests.')).not.toBe(first);
    advance(4000);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(2000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('puts each tone into its own region without changing any region’s role', () => {
    const { rerender } = render(<Toast message={toastMessage('Friend request sent.')} onDismiss={vi.fn()} />);
    const politeRegion = screen.getByRole('status');
    const assertiveRegion = screen.getByRole('alert');
    expect(politeRegion).toHaveTextContent('Friend request sent.');

    rerender(<Toast tone="error" message={toastMessage('The request could not be sent.')} onDismiss={vi.fn()} />);

    expect(screen.getByRole('status')).toBe(politeRegion);
    expect(screen.getByRole('alert')).toBe(assertiveRegion);
    expect(politeRegion).toBeEmptyDOMElement();
    expect(assertiveRegion).toHaveTextContent('The request could not be sent.');
  });
});
