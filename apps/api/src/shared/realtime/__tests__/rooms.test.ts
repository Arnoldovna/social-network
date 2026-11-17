import { describe, expect, it } from 'vitest';

import { rooms } from '../rooms.js';

describe('rooms (ADR-0008)', () => {
  it('builds every room name in one format', () => {
    expect(rooms.user(7)).toBe('user:7');
    expect(rooms.session('abc-DEF_123')).toBe('session:abc-DEF_123');
    expect(rooms.wall(42)).toBe('wall:42');
    expect(rooms.chat).toBe('chat');
  });

  it('keeps users and walls of the same id apart', () => {
    expect(rooms.user(3)).not.toBe(rooms.wall(3));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects the id %s instead of building a shared room like "user:NaN"',
    (id) => {
      expect(() => rooms.user(id)).toThrow(RangeError);
      expect(() => rooms.wall(id)).toThrow(RangeError);
    },
  );

  it('rejects an empty session id, which would put unrelated sockets into one room', () => {
    expect(() => rooms.session('')).toThrow(RangeError);
  });
});
