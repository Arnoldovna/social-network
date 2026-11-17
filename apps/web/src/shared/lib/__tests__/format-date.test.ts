import { describe, expect, it } from 'vitest';

import { formatDate, formatDateTime, formatRelative, formatTime, toDate } from '../format-date';

// 15 Nov 2026, 14:05 UTC: 15:05 in Berlin (CET), 09:05 in New York (EST), 03:05 the next day in Auckland (NZDT).
const ISO = '2026-11-15T14:05:00.000Z';
const NOW = Date.parse(ISO);

const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();
const minutesAgo = (m: number) => secondsAgo(m * 60);
const hoursAgo = (h: number) => minutesAgo(h * 60);
const daysAgo = (d: number) => hoursAgo(d * 24);

describe('toDate', () => {
  it('reads ISO strings, epoch milliseconds and dates', () => {
    expect(toDate(ISO)?.getTime()).toBe(NOW);
    expect(toDate(NOW)?.toISOString()).toBe(ISO);
    expect(toDate(new Date(NOW))?.toISOString()).toBe(ISO);
  });

  it('returns null for values that are not dates', () => {
    expect(toDate('yesterday')).toBeNull();
    expect(toDate('')).toBeNull();
    expect(toDate(Number.NaN)).toBeNull();
  });

  it('returns a copy, so callers cannot mutate the input', () => {
    const input = new Date(NOW);
    const copy = toDate(input);
    copy?.setFullYear(2000);
    expect(input.toISOString()).toBe(ISO);
  });
});

describe('absolute formats (en-GB, F-108)', () => {
  it('formats the date as "15 Nov 2026"', () => {
    expect(formatDate(ISO, { timeZone: 'UTC' })).toBe('15 Nov 2026');
  });

  it('formats the time on a 24-hour clock', () => {
    expect(formatTime(ISO, { timeZone: 'UTC' })).toBe('14:05');
    expect(formatTime('2026-11-15T00:07:00.000Z', { timeZone: 'UTC' })).toBe('00:07');
  });

  it('formats date and time together', () => {
    expect(formatDateTime(ISO, { timeZone: 'UTC' })).toBe('15 Nov 2026, 14:05');
  });

  it('shows the instant in the viewer’s time zone, including a date change', () => {
    expect(formatTime(ISO, { timeZone: 'Europe/Berlin' })).toBe('15:05');
    expect(formatTime(ISO, { timeZone: 'America/New_York' })).toBe('09:05');
    expect(formatDateTime(ISO, { timeZone: 'Pacific/Auckland' })).toBe('16 Nov 2026, 03:05');
  });

  it('uses the device time zone when none is given', () => {
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(formatDateTime(ISO)).toBe(formatDateTime(ISO, { timeZone: deviceZone }));
  });

  it('shows an unreadable value as it came instead of "Invalid Date"', () => {
    expect(formatDate('not a date')).toBe('not a date');
    expect(formatTime('')).toBe('');
  });
});

describe('formatRelative (Intl.RelativeTimeFormat)', () => {
  it.each([
    [secondsAgo(0), 'just now'],
    [secondsAgo(44), 'just now'],
    [secondsAgo(45), '1 minute ago'],
    [minutesAgo(5), '5 minutes ago'],
    [minutesAgo(44), '44 minutes ago'],
    [minutesAgo(45), '1 hour ago'],
    [hoursAgo(3), '3 hours ago'],
    [hoursAgo(21), '21 hours ago'],
    [hoursAgo(22), 'yesterday'],
    [daysAgo(4), '4 days ago'],
    [daysAgo(6), '6 days ago'],
  ])('%s reads "%s"', (value, expected) => {
    // Days are calendar days in the viewer's zone, so the zone is pinned: the device's may put NOW on another date.
    expect(formatRelative(value, NOW, { timeZone: 'UTC' })).toBe(expected);
  });

  describe('counts days by the calendar in the viewer’s time zone (F-108)', () => {
    const BERLIN = { timeZone: 'Europe/Berlin' };

    it('keeps a post from the same day in hours, even 22 hours and more later', () => {
      // 01:00 and 23:30 on 15 Nov in Berlin: 22.5 hours apart, but the same day.
      expect(formatRelative('2026-11-15T00:00:00.000Z', Date.parse('2026-11-15T22:30:00.000Z'), BERLIN)).toBe(
        '23 hours ago',
      );
    });

    it('reads "yesterday" for the previous calendar day, however few hours that is', () => {
      // 22:00 on 14 Nov to 21:00 on 15 Nov in Berlin: 23 hours, one midnight.
      expect(formatRelative('2026-11-14T21:00:00.000Z', Date.parse('2026-11-15T20:00:00.000Z'), BERLIN)).toBe(
        'yesterday',
      );
    });

    it('counts midnights, not 24-hour blocks, for older days', () => {
      // 23:00 on 13 Nov to 00:30 on 15 Nov in Berlin: 25.5 hours, but two midnights.
      expect(formatRelative('2026-11-13T22:00:00.000Z', Date.parse('2026-11-14T23:30:00.000Z'), BERLIN)).toBe(
        '2 days ago',
      );
    });

    it('uses the viewer’s zone, not UTC, to decide the day', () => {
      // 00:30 and 23:00 UTC on 15 Nov: the same day in UTC, but 09:30 on 15 Nov and 08:00 on 16 Nov in Tokyo.
      const post = '2026-11-15T00:30:00.000Z';
      const now = Date.parse('2026-11-15T23:00:00.000Z');
      expect(formatRelative(post, now, { timeZone: 'UTC' })).toBe('23 hours ago');
      expect(formatRelative(post, now, { timeZone: 'Asia/Tokyo' })).toBe('yesterday');
    });

    it('shows the date from the seventh calendar day back', () => {
      // 01:30 on 9 Nov to 23:30 on 15 Nov in Berlin: almost seven days, but six midnights.
      expect(formatRelative('2026-11-09T00:30:00.000Z', Date.parse('2026-11-15T22:30:00.000Z'), BERLIN)).toBe(
        '6 days ago',
      );
      // 23:30 on 8 Nov to 01:30 on 15 Nov in Berlin: only just over six days, but seven midnights.
      expect(formatRelative('2026-11-08T22:30:00.000Z', Date.parse('2026-11-15T00:30:00.000Z'), BERLIN)).toBe(
        '8 Nov 2026',
      );
    });
  });

  it('switches to the date from a week on', () => {
    expect(formatRelative(daysAgo(7), NOW, { timeZone: 'UTC' })).toBe('8 Nov 2026');
    expect(formatRelative('2025-01-03T09:00:00.000Z', NOW, { timeZone: 'UTC' })).toBe('3 Jan 2025');
  });

  it('reads "just now" for a timestamp slightly in the future (clock skew)', () => {
    expect(formatRelative(secondsAgo(-90), NOW)).toBe('just now');
  });

  it('accepts "now" as a Date and defaults it to the current time', () => {
    expect(formatRelative(minutesAgo(5), new Date(NOW))).toBe('5 minutes ago');
    expect(formatRelative(new Date())).toBe('just now');
  });

  it('shows an unreadable value as it came', () => {
    expect(formatRelative('soon', NOW)).toBe('soon');
  });
});
