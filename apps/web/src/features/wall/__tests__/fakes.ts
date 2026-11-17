/*
 * Test doubles of the wall unit (BUILD-ORDER rule 5): a stand-in for the tab's socket.io client (`getSocket()`).
 * Use it with `vi.mock('../../../shared/realtime/socket', async () => (await import('./fakes')).socketModule)`.
 */

type Listener = (...args: unknown[]) => void;

/** Records emits, lets a test play server events and flip the connection. The wall uses `connected`, `on`, `off`, `emit`. */
export class FakeSocket {
  connected = false;
  emitted: { event: string; payload: unknown }[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? new Set()).add(listener));
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, payload: unknown, ack?: (response: unknown) => void): this {
    this.emitted.push({ event, payload });
    ack?.({ ok: true });
    return this;
  }

  /** The server sends `event` to this socket. */
  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  reset(): void {
    this.listeners.clear();
    this.emitted = [];
    this.connected = false;
  }
}

export const socket = new FakeSocket();

/** Replacement for `shared/realtime/socket`. */
export const socketModule = {
  getSocket: () => socket,
};
