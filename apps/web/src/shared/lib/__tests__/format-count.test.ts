import { describe, expect, it } from 'vitest';

import { formatCount, pluralize } from '../format-count';

describe('formatCount', () => {
  it('groups thousands the British way', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1284)).toBe('1,284');
  });
});

describe('pluralize', () => {
  it('uses the singular for exactly one and the plural otherwise', () => {
    expect(pluralize(1, 'person', 'people')).toBe('1 person');
    expect(pluralize(0, 'person', 'people')).toBe('0 people');
    expect(pluralize(1284, 'request', 'requests')).toBe('1,284 requests');
  });
});
