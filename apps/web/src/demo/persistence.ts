import { isDemoState } from './state';
import type { DemoState } from './state';

/**
 * Where the demo keeps its data between visits (ADR-0020): the state document and the uploaded avatar blobs. The
 * browser build uses IndexedDB; unit tests use the in-memory store with the same contract.
 */
export interface DemoPersistence {
  /** The stored state, or `undefined` when there is none (first visit, after a reset, or an older shape). */
  load(): Promise<DemoState | undefined>;
  save(state: DemoState): Promise<void>;
  loadAvatar(userId: number): Promise<Blob | undefined>;
  saveAvatar(userId: number, image: Blob): Promise<void>;
  /** Deletes everything, so the next start seeds afresh (the banner's "reset demo data"). */
  clear(): Promise<void>;
}

export function createMemoryPersistence(): DemoPersistence {
  let state: DemoState | undefined;
  const avatars = new Map<number, Blob>();
  return {
    load: () => Promise.resolve(state === undefined ? undefined : structuredClone(state)),
    save: (next) => {
      state = structuredClone(next);
      return Promise.resolve();
    },
    loadAvatar: (userId) => Promise.resolve(avatars.get(userId)),
    saveAvatar: (userId, image) => {
      avatars.set(userId, image);
      return Promise.resolve();
    },
    clear: () => {
      state = undefined;
      avatars.clear();
      return Promise.resolve();
    },
  };
}

const DATABASE_NAME = 'social-network-demo';
const DATABASE_VERSION = 1;
const STATE_STORE = 'state';
const AVATAR_STORE = 'avatars';
const STATE_KEY = 'current';

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      resolve(request.result);
    });
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    });
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STATE_STORE)) database.createObjectStore(STATE_STORE);
    if (!database.objectStoreNames.contains(AVATAR_STORE)) database.createObjectStore(AVATAR_STORE);
  });
  return settle(request);
}

/** Resolves when a write transaction has committed (a request's success alone does not mean it is on disk). */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => {
      resolve();
    });
    transaction.addEventListener('abort', () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  });
}

/** The demo's IndexedDB database `social-network-demo`: one store for the state document, one for avatar blobs. */
export async function createIndexedDbPersistence(): Promise<DemoPersistence> {
  const database = await openDatabase();

  const write = async (store: string, change: (objects: IDBObjectStore) => void): Promise<void> => {
    const transaction = database.transaction(store, 'readwrite');
    change(transaction.objectStore(store));
    await committed(transaction);
  };
  const read = (store: string, key: IDBValidKey): Promise<unknown> =>
    settle(database.transaction(store, 'readonly').objectStore(store).get(key));

  return {
    async load() {
      const stored = await read(STATE_STORE, STATE_KEY);
      return isDemoState(stored) ? stored : undefined;
    },
    save: (state) =>
      write(STATE_STORE, (objects) => {
        objects.put(state, STATE_KEY);
      }),
    async loadAvatar(userId) {
      const stored = await read(AVATAR_STORE, userId);
      return stored instanceof Blob ? stored : undefined;
    },
    saveAvatar: (userId, image) =>
      write(AVATAR_STORE, (objects) => {
        objects.put(image, userId);
      }),
    async clear() {
      const transaction = database.transaction([STATE_STORE, AVATAR_STORE], 'readwrite');
      transaction.objectStore(STATE_STORE).clear();
      transaction.objectStore(AVATAR_STORE).clear();
      await committed(transaction);
    },
  };
}
