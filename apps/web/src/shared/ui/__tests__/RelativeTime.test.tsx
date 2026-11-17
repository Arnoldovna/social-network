import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDate, formatDateTime } from '../../lib/format-date';
import { RelativeTime } from '../RelativeTime';

/*
 * The component shows the viewer's (device) zone (F-108), and no instant falls on the same date in every zone, so the
 * absolute texts are expected from `format-date` itself (its own tests pin zones and the en-GB format).
 */
const NOW = new Date('2026-11-17T12:00:00.000Z');

function isoBefore(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RelativeTime', () => {
  it.each([
    [10, 'just now'],
    [90, '2 minutes ago'],
    [5 * 60, '5 minutes ago'],
    [3 * 3600, '3 hours ago'],
    // Whole days back, so the calendar-day difference is the same in every zone (F-108: days count midnights).
    [24 * 3600, 'yesterday'],
    [4 * 86400, '4 days ago'],
  ])('reads %i seconds ago as "%s" (F-69)', (seconds, text) => {
    render(<RelativeTime dateTime={isoBefore(seconds)} />);

    expect(screen.getByText(text).tagName).toBe('TIME');
  });

  it('shows the en-GB date for anything older than a week', () => {
    render(<RelativeTime dateTime="2026-11-02T12:00:00.000Z" />);

    expect(screen.getByText(formatDate('2026-11-02T12:00:00.000Z')).tagName).toBe('TIME');
  });

  it('reads a timestamp slightly in the future (clock skew) as "just now"', () => {
    render(<RelativeTime dateTime={isoBefore(-20)} />);

    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('puts the machine-readable instant in datetime and the absolute date and time in the title', () => {
    render(<RelativeTime dateTime="2026-11-17T11:55:00Z" />);

    const time = screen.getByText('5 minutes ago');
    expect(time).toHaveAttribute('datetime', '2026-11-17T11:55:00.000Z');
    expect(time).toHaveAttribute('title', formatDateTime('2026-11-17T11:55:00Z'));
    expect(time.getAttribute('title')).toMatch(/^\d{1,2} Nov 2026, \d{2}:\d{2}$/);
  });

  it('moves on while it stays mounted', () => {
    render(<RelativeTime dateTime={isoBefore(5)} />);
    expect(screen.getByText('just now')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    expect(screen.getByText('2 minutes ago')).toBeInTheDocument();
  });

  it('shares one timer between all timestamps and stops it after the last unmount', () => {
    const { unmount } = render(
      <>
        <RelativeTime dateTime={isoBefore(60)} />
        <RelativeTime dateTime={isoBefore(120)} />
        <RelativeTime dateTime={isoBefore(180)} />
      </>,
    );
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows an unparsable value as it is, without a time element', () => {
    render(<RelativeTime dateTime="not a date" />);

    expect(screen.getByText('not a date').tagName).toBe('SPAN');
  });

  it("mixes in the parent's element class", () => {
    render(<RelativeTime dateTime={isoBefore(10)} className="wall-post__date" />);

    expect(screen.getByText('just now')).toHaveAttribute('class', 'relative-time wall-post__date');
  });
});
