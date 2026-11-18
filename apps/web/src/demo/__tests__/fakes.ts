import type { ServerToClientEvents } from '@app/shared';
import { DEMO_EMAIL } from '@app/shared/demo-seed';

import { DemoBackend } from '../backend';
import type { MeasureImage, RealtimeEmitter, RealtimeTarget } from '../backend';
import { createMemoryPersistence } from '../persistence';
import type { DemoPersistence } from '../persistence';
import type { DemoSocket, DemoSocketServer } from '../realtime';
import type { SocketIoPacket } from '../socket-io-extension';
import { buildSeedState } from '../seed';
import type { DemoState } from '../state';

/** The fixed "now" of the demo tests, so seeded dates and ids are the same on every run. */
export const NOW = new Date('2026-11-18T12:00:00.000Z');

export interface RecordedEvent {
  target: RealtimeTarget;
  event: keyof ServerToClientEvents;
  args: unknown[];
}

/** An emitter that records what the backend sends, instead of sockets. */
export function recordingEmitter(): RealtimeEmitter & {
  events: RecordedEvent[];
  roomChanges: string[];
} {
  const events: RecordedEvent[] = [];
  const roomChanges: string[] = [];
  return {
    events,
    roomChanges,
    emit(target, event, ...args) {
      events.push({ target, event, args });
    },
    leaveWall(userId, ownerId) {
      roomChanges.push(`${String(userId)} leaves wall ${String(ownerId)}`);
    },
    endSession(userId) {
      roomChanges.push(`session of ${String(userId)} ended`);
    },
  };
}

let uuidCounter = 0;
/** Deterministic, valid-looking UUIDs (avatar versions match `^[0-9a-f-]{36}$`). */
export function fakeUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

export interface TestBackend {
  backend: DemoBackend;
  state: DemoState;
  persistence: DemoPersistence;
  realtime: ReturnType<typeof recordingEmitter>;
}

/** A backend over a fresh seed, an in-memory store and a recording emitter. */
export async function createTestBackend({
  measureImage = () => Promise.resolve({ width: 512, height: 512 }),
}: { measureImage?: MeasureImage } = {}): Promise<TestBackend> {
  const state = await buildSeedState(NOW, fakeUuid);
  const persistence = createMemoryPersistence();
  await persistence.save(state);
  const realtime = recordingEmitter();
  const backend = new DemoBackend({ state, persistence, realtime, measureImage, now: () => NOW, randomUUID: fakeUuid });
  return { backend, state, persistence, realtime };
}

/** Connects a socket with a session, failing the test when the handshake is refused. */
export function connectOrFail(server: DemoSocketServer, send: (packet: SocketIoPacket) => void): DemoSocket {
  const socket = server.connect(send);
  if (socket === null) throw new Error('the demo socket server refused the handshake');
  return socket;
}

/** The seeded demo login (Mira, user 1). */
export const MIRA_EMAIL = DEMO_EMAIL;
