import type { AvatarDesign } from '@app/shared/demo-seed';

/**
 * The demo's whole database as one JSON-serialisable document (ADR-0020), kept in memory and written to IndexedDB
 * after every change. Uploaded avatar images are stored next to it as blobs, keyed by user id.
 */

/** Bumped when the shape changes; a stored state of another version is discarded and the demo seeds afresh. */
export const DEMO_STATE_VERSION = 1;

/** The password of every seeded account in the demo, shown in the demo banner. Never a real credential. */
export const DEMO_PASSWORD = 'lets-chat-demo';

export type DemoAvatar =
  /** A generated abstract avatar, the same design the real seed renders (served as SVG). */
  | { kind: 'design'; design: AvatarDesign; version: string }
  /** An image the visitor uploaded, stored as a blob in IndexedDB. */
  | { kind: 'upload'; version: string; contentType: string };

export interface DemoUser {
  id: number;
  firstName: string;
  lastName: string;
  /** Lower case, as the real API stores it. */
  email: string;
  bio: string | null;
  /** SHA-256 of salt and password, hex (the demo never stores a password in clear). */
  passwordHash: string;
  salt: string;
  avatar: DemoAvatar | null;
  createdAt: string;
}

export interface DemoFriendship {
  requesterId: number;
  addresseeId: number;
  status: 'pending' | 'accepted';
  createdAt: string;
  acceptedAt: string | null;
}

export interface DemoPost {
  id: number;
  wallOwnerId: number;
  authorId: number;
  body: string;
  createdAt: string;
}

export interface DemoMessage {
  id: number;
  authorId: number;
  body: string;
  createdAt: string;
}

export interface DemoState {
  version: typeof DEMO_STATE_VERSION;
  users: DemoUser[];
  friendships: DemoFriendship[];
  posts: DemoPost[];
  messages: DemoMessage[];
  /** The last id handed out per table; ids are never reused, like identity columns. */
  lastIds: { users: number; posts: number; messages: number };
  /** The signed-in user of this browser, the demo's session cookie. */
  sessionUserId: number | null;
}

export function isDemoState(value: unknown): value is DemoState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === DEMO_STATE_VERSION &&
    'users' in value &&
    Array.isArray(value.users)
  );
}
