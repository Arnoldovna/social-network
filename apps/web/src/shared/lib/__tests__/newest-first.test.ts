import { describe, expect, it } from 'vitest';

import { isLoaded, isNewer, newestFirstIndex } from '../newest-first';
import type { Chronological } from '../newest-first';

function entry(id: number, createdAt: string): Chronological {
  return { id, createdAt };
}

describe('isNewer (ADR-0014: created_at DESC, id DESC)', () => {
  it('puts the later instant first', () => {
    expect(isNewer(entry(1, '2026-11-17T09:02:00.000Z'), entry(2, '2026-11-17T09:01:59.999Z'))).toBe(true);
    expect(isNewer(entry(2, '2026-11-17T09:01:59.999Z'), entry(1, '2026-11-17T09:02:00.000Z'))).toBe(false);
  });

  it('breaks a tie within one millisecond by the higher id', () => {
    expect(isNewer(entry(8, '2026-11-17T09:02:00.000Z'), entry(7, '2026-11-17T09:02:00.000Z'))).toBe(true);
    expect(isNewer(entry(7, '2026-11-17T09:02:00.000Z'), entry(8, '2026-11-17T09:02:00.000Z'))).toBe(false);
  });

  it('treats the same instant in another notation as a tie, not as older or newer', () => {
    expect(isNewer(entry(8, '2026-11-17T09:02:00Z'), entry(7, '2026-11-17T10:02:00.000+01:00'))).toBe(true);
    expect(isNewer(entry(7, '2026-11-17T09:02:00Z'), entry(8, '2026-11-17T10:02:00.000+01:00'))).toBe(false);
  });

  it('is never true for an entry and itself', () => {
    const same = entry(3, '2026-11-17T09:02:00.000Z');
    expect(isNewer(same, same)).toBe(false);
  });
});

describe('newestFirstIndex', () => {
  const items = [
    entry(30, '2026-11-17T09:03:00.000Z'),
    entry(20, '2026-11-17T09:02:00.000Z'),
    entry(10, '2026-11-17T09:01:00.000Z'),
  ];

  it('is 0 for the newest entry', () => {
    expect(newestFirstIndex(items, entry(31, '2026-11-17T09:04:00.000Z'))).toBe(0);
  });

  it('is the place between two entries', () => {
    expect(newestFirstIndex(items, entry(25, '2026-11-17T09:02:30.000Z'))).toBe(1);
    expect(newestFirstIndex(items, entry(21, '2026-11-17T09:02:00.000Z'))).toBe(1);
  });

  it('is the length for an entry older than all of them, and 0 for an empty list', () => {
    expect(newestFirstIndex(items, entry(5, '2026-11-17T09:00:00.000Z'))).toBe(3);
    expect(newestFirstIndex([], entry(5, '2026-11-17T09:00:00.000Z'))).toBe(0);
  });
});

describe('isLoaded', () => {
  const pages = [
    { items: [entry(30, '2026-11-17T09:03:00.000Z')] },
    { items: [entry(10, '2026-11-17T09:01:00.000Z')] },
  ];

  it('finds an id on any page, and nothing in an empty history', () => {
    expect(isLoaded(pages, 10)).toBe(true);
    expect(isLoaded(pages, 20)).toBe(false);
    expect(isLoaded([], 10)).toBe(false);
  });
});
