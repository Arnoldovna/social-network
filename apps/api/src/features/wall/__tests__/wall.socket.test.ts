import { describe, expect, it } from 'vitest';

import { joinWhilePermitted, type RoomMembership } from '../wall.socket.js';
import { WallForbiddenError } from '../wall.service.js';

/**
 * `joinWhilePermitted` (B-39): the race between `wall:join` and a concurrent unfriend, made deterministic. The
 * end-to-end join rules (owner, friends, pending, strangers) are covered by `wall.socket.int.test.ts`.
 */

interface Recorder {
  steps: string[];
  membership: RoomMembership;
}

/** Records every check, join and leave in order; `onJoin` runs at the moment the socket enters the room. */
function recorder(onJoin: () => void = () => undefined): Recorder {
  const steps: string[] = [];
  return {
    steps,
    membership: {
      join() {
        steps.push('join');
        onJoin();
      },
      leave() {
        steps.push('leave');
      },
    },
  };
}

describe('joinWhilePermitted (B-39)', () => {
  it('joins when the permission holds before and after the join', async () => {
    const { steps, membership } = recorder();
    const assertPermitted = (): Promise<void> => {
      steps.push('check');
      return Promise.resolve();
    };

    await joinWhilePermitted(assertPermitted, membership);

    expect(steps).toEqual(['check', 'join', 'check']);
  });

  it('never joins when the permission is missing', async () => {
    const { steps, membership } = recorder();
    const assertPermitted = (): Promise<void> => {
      steps.push('check');
      return Promise.reject(new WallForbiddenError());
    };

    await expect(joinWhilePermitted(assertPermitted, membership)).rejects.toBeInstanceOf(WallForbiddenError);
    expect(steps).toEqual(['check']);
  });

  it('leaves again when an unfriend ended the friendship while the socket was joining', async () => {
    let friends = true;
    // The unfriend lands between the first check and the join: its room removal found no socket to remove.
    const { steps, membership } = recorder(() => {
      friends = false;
    });
    const assertPermitted = (): Promise<void> => {
      steps.push('check');
      return friends ? Promise.resolve() : Promise.reject(new WallForbiddenError());
    };

    await expect(joinWhilePermitted(assertPermitted, membership)).rejects.toBeInstanceOf(WallForbiddenError);
    expect(steps).toEqual(['check', 'join', 'check', 'leave']);
  });

  it('leaves again when the second check fails unexpectedly, and passes that error on', async () => {
    const failure = new Error('connection reset');
    let checks = 0;
    const { steps, membership } = recorder();
    const assertPermitted = (): Promise<void> => {
      checks += 1;
      steps.push('check');
      return checks === 1 ? Promise.resolve() : Promise.reject(failure);
    };

    await expect(joinWhilePermitted(assertPermitted, membership)).rejects.toBe(failure);
    expect(steps).toEqual(['check', 'join', 'check', 'leave']);
  });
});
