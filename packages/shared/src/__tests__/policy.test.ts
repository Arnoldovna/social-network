import { describe, expect, it } from 'vitest';

import { canDeleteWallPost, type WallPost } from '../index.js';

const author = (id: number) => ({ id, firstName: 'A', lastName: 'B', avatarUrl: null });
const postBy = (authorId: number, wallOwnerId: number): WallPost => ({
  id: 1,
  wallOwnerId,
  author: author(authorId),
  body: 'Hello',
  createdAt: '2026-11-15T14:05:00.000Z',
});

// F-71: author or wall owner, nobody else.
describe('canDeleteWallPost', () => {
  it('lets the author delete a post on their own wall', () => {
    expect(canDeleteWallPost(1, postBy(1, 1))).toBe(true);
  });

  it('lets the author delete a post on a friend’s wall', () => {
    expect(canDeleteWallPost(1, postBy(1, 2))).toBe(true);
  });

  it('lets the wall owner delete a friend’s post on their wall', () => {
    expect(canDeleteWallPost(2, postBy(1, 2))).toBe(true);
  });

  it('refuses everybody else', () => {
    expect(canDeleteWallPost(3, postBy(1, 2))).toBe(false);
  });

  it('works with the minimal shape the server has before loading the author', () => {
    expect(canDeleteWallPost(5, { wallOwnerId: 5, author: { id: 6 } })).toBe(true);
    expect(canDeleteWallPost(7, { wallOwnerId: 5, author: { id: 6 } })).toBe(false);
  });
});
