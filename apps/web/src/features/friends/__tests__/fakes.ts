import type { FriendEntry, FriendshipsResponse, UserSummary } from '@app/shared';

/*
 * Test doubles of the friends unit (BUILD-ORDER rule 5): a stand-in for the tab's socket, so a test can deliver a
 * server event, and friends-list fixtures from the seed's point of view of Mira Novak (DATA-MODEL "Friendship graph").
 */

type Handler = (payload: unknown) => void;

/** Just the part of socket.io-client's `Socket` that `friends.api.ts` uses: `on`/`off` and a way to receive. */
export class FakeSocket {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): this {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }

  off(event: string, handler: Handler): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  /** Delivers an event from the server to every handler registered for it. */
  receive(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

export const fakeSocket = new FakeSocket();

/** Replacement for `shared/realtime/socket`: `vi.mock('…/shared/realtime/socket', async () => (await import('./fakes')).socketModule)`. */
export const socketModule = {
  getSocket: () => fakeSocket,
};

function person(id: number, firstName: string, lastName: string, avatar = true): UserSummary {
  return {
    id,
    firstName,
    lastName,
    avatarUrl: avatar
      ? `/api/users/${String(id)}/avatar?v=0b7c4e1a-2f3d-4c5b-9a8e-${String(id).padStart(12, '0')}`
      : null,
  };
}

export const TOMAS = person(2, 'Tomás', 'Herrera');
export const AIKO = person(3, 'Aiko', 'Tanaka');
/** A name with lowercase particles, rendered exactly as stored (F-58, B-110). */
export const LUCIA = person(15, 'lucía', 'de la Cruz', false);
export const SOFIA = person(9, 'Sofia', 'Lindqvist');
export const YUSUF = person(10, 'Yusuf', 'Demir');
export const CLARA = person(11, 'Clara', 'Moreau', false);

function entry(user: UserSummary, since: string): FriendEntry {
  return { user, since };
}

/** Mira's lists: three friends, two incoming requests (Sofia, Yusuf), one sent request (Clara); server order. */
export function miraFriendships(): FriendshipsResponse {
  return {
    friends: [
      entry(AIKO, '2026-10-02T09:30:00.000Z'),
      entry(LUCIA, '2026-11-01T18:00:00.000Z'),
      entry(TOMAS, '2026-09-14T12:15:00.000Z'),
    ],
    incoming: [entry(SOFIA, '2026-11-14T08:05:00.000Z'), entry(YUSUF, '2026-11-15T14:05:00.000Z')],
    outgoing: [entry(CLARA, '2026-11-12T16:40:00.000Z')],
  };
}

export function noFriendships(): FriendshipsResponse {
  return { friends: [], incoming: [], outgoing: [] };
}
