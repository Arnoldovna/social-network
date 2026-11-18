import type { DemoPersistence } from './persistence';
import type { DemoState } from './state';

/** The part of `BroadcastChannel` the sync uses (a fake in tests). */
export interface SyncChannel {
  postMessage: (message: SyncMessage) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void;
}

export type SyncMessage = 'changed' | 'reset';

export interface SyncedPersistence {
  /** Saves like the wrapped store, then tells the other tabs; does nothing once a reset started. */
  persistence: DemoPersistence;
  /**
   * "reset demo data": stops all further saves of this tab (a late simulated reply must not write the old state back),
   * deletes the stored data and tells the other tabs to start over.
   */
  reset(): Promise<void>;
}

export interface SyncHandlers {
  /** Another tab stored a newer state. */
  onRemoteState: (state: DemoState) => void;
  /** Another tab reset the demo. */
  onRemoteReset: () => void;
}

/**
 * Keeps the demo's tabs of one browser consistent (ADR-0020). Each tab runs its own backend over one IndexedDB
 * record, so without this a tab would overwrite another tab's changes with its own outdated copy. After every save a
 * tab announces it on a `BroadcastChannel`; the others load the stored state and adopt it. A reset freezes this tab's
 * store first, so nothing in flight can restore the old data, and makes the other tabs reload.
 */
export function createSyncedPersistence(
  inner: DemoPersistence,
  channel: SyncChannel | null,
  { onRemoteState, onRemoteReset }: SyncHandlers,
): SyncedPersistence {
  let frozen = false;

  channel?.addEventListener('message', (event) => {
    if (frozen) return;
    if (event.data === 'reset') {
      frozen = true;
      onRemoteReset();
      return;
    }
    if (event.data === 'changed') {
      void inner.load().then((state) => {
        if (state !== undefined && !frozen) onRemoteState(state);
      });
    }
  });

  const announce = () => {
    channel?.postMessage('changed');
  };

  return {
    // Only the writes are gated; reads and `clear` are the wrapped store's.
    persistence: {
      ...inner,
      save: async (state) => {
        if (frozen) return;
        await inner.save(state);
        announce();
      },
      saveAvatar: async (userId, image) => {
        if (frozen) return;
        await inner.saveAvatar(userId, image);
      },
    },
    async reset() {
      frozen = true;
      await inner.clear();
      channel?.postMessage('reset');
    },
  };
}
