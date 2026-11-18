import { describe, expect, it, vi } from 'vitest';

import { createMemoryPersistence } from '../persistence';
import { createSyncedPersistence } from '../sync';
import type { SyncChannel, SyncMessage } from '../sync';
import { createTestBackend } from './fakes';

/** Two `BroadcastChannel`s of one name: a message posted on one reaches the other, never the sender. */
function channelPair(): [SyncChannel, SyncChannel] {
  const listeners = new Map<SyncChannel, ((event: MessageEvent<unknown>) => void)[]>();
  const make = (): SyncChannel => {
    const channel: SyncChannel = {
      postMessage(message: SyncMessage) {
        for (const [other, handlers] of listeners) {
          if (other !== channel)
            for (const handler of handlers) handler(new MessageEvent('message', { data: message }));
        }
      },
      addEventListener(_type, listener) {
        listeners.get(channel)?.push(listener);
      },
    };
    listeners.set(channel, []);
    return channel;
  };
  return [make(), make()];
}

describe('demo tab sync (ADR-0020)', () => {
  it('lets a tab adopt what another tab saved, so it never writes an outdated copy back', async () => {
    const shared = createMemoryPersistence();
    const [channelA, channelB] = channelPair();
    const { state } = await createTestBackend();
    const adopted = vi.fn();
    const tabA = createSyncedPersistence(shared, channelA, { onRemoteState: vi.fn(), onRemoteReset: vi.fn() });
    createSyncedPersistence(shared, channelB, { onRemoteState: adopted, onRemoteReset: vi.fn() });

    await tabA.persistence.save({ ...state, sessionUserId: 3 });

    await vi.waitFor(() => {
      expect(adopted).toHaveBeenCalledWith(expect.objectContaining({ sessionUserId: 3 }));
    });
  });

  it('freezes the resetting tab, clears the data and makes the other tabs start over', async () => {
    const shared = createMemoryPersistence();
    const [channelA, channelB] = channelPair();
    const { state } = await createTestBackend();
    await shared.save(state);
    const otherTabReset = vi.fn();
    const tabA = createSyncedPersistence(shared, channelA, { onRemoteState: vi.fn(), onRemoteReset: vi.fn() });
    const tabB = createSyncedPersistence(shared, channelB, { onRemoteState: vi.fn(), onRemoteReset: otherTabReset });

    await tabA.reset();
    // A simulated reply that fires after the reset, in either tab, writes nothing back.
    await tabA.persistence.save(state);
    await tabB.persistence.save(state);
    await tabA.persistence.saveAvatar(1, new Blob(['x']));

    expect(otherTabReset).toHaveBeenCalledOnce();
    expect(await shared.load()).toBeUndefined();
    expect(await shared.loadAvatar(1)).toBeUndefined();
  });

  it('works without BroadcastChannel (one tab)', async () => {
    const shared = createMemoryPersistence();
    const { state } = await createTestBackend();
    const tab = createSyncedPersistence(shared, null, { onRemoteState: vi.fn(), onRemoteReset: vi.fn() });

    await tab.persistence.save(state);

    expect((await shared.load())?.users).toHaveLength(state.users.length);
  });
});
