import type { ChatMessage, FriendshipChange } from '@app/shared';
import { PEOPLE } from '@app/shared/demo-seed';

import type { DemoBackend } from './backend';
import type { DemoSocketServer } from './realtime';

/** Short, plain answers simulated people give in the chat (maw copy rules: no emoji, no exclamation marks). */
export const CHAT_REPLIES: readonly string[] = [
  'Sounds good to me.',
  'I can be there after six.',
  'Good point. I had not thought of that.',
  'Count me in.',
  'Thanks for the heads-up.',
  'Same here, the tram was late again.',
  'Let me check my calendar and come back to you.',
  'I will bring coffee.',
  'Nice. Tell us how it went.',
  'That reminds me, the workshop is open on Saturday.',
];

/** Seeded people who are online when the demo starts. */
const INITIALLY_ONLINE: readonly string[] = ['tomas', 'aiko', 'priya', 'daniel'];

export interface SimulationTiming {
  /** Delay before someone answers a chat message of the visitor. */
  replyMs: readonly [min: number, max: number];
  /** Delay before a simulated person accepts the visitor's friend request. */
  acceptMs: readonly [min: number, max: number];
  /** Time between two presence changes (someone comes online or goes offline). */
  presenceMs: readonly [min: number, max: number];
  /** Never fewer people online than this, never more than `maxOnline`. */
  minOnline: number;
  maxOnline: number;
}

export const DEFAULT_TIMING: SimulationTiming = {
  replyMs: [2_500, 6_000],
  acceptMs: [4_000, 9_000],
  presenceMs: [15_000, 35_000],
  minOnline: 2,
  maxOnline: 7,
};

export interface SimulationDeps {
  backend: DemoBackend;
  server: DemoSocketServer;
  random?: () => number;
  timing?: SimulationTiming;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * The simulated people of the demo (ADR-0020), so chat and presence feel alive without a second visitor:
 * - a few people are online from the start; every 15 to 35 s one of them goes offline or someone else comes online
 *   (`presence:joined` / `presence:left`, F-87);
 * - a chat message of the visitor gets an answer from someone who is online, 2.5 to 6 s later (one pending answer at
 *   a time, so a burst of messages is not answered by a crowd);
 * - a friend request of the visitor is accepted 4 to 9 s later (`friendship:changed`, F-52).
 * Everything goes through the backend, so the answers are stored and validated like the visitor's own actions.
 * Returns `stop`, which cancels every timer.
 */
export function startSimulation({
  backend,
  server,
  random = Math.random,
  timing = DEFAULT_TIMING,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => {
    clearTimeout(timer);
  },
}: SimulationDeps): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let replyPending = false;

  const between = ([min, max]: readonly [number, number]) => min + random() * (max - min);
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
  const later = (ms: number, action: () => Promise<unknown> | undefined) => {
    const timer = setTimer(() => {
      timers.delete(timer);
      void Promise.resolve(action()).catch((error: unknown) => {
        // A failed simulated action is skipped, but reported: the demo has no server log, only the browser console.
        // eslint-disable-next-line no-console -- see above
        console.error('demo simulation failed', error);
      });
    }, ms);
    timers.add(timer);
  };

  const others = () => backend.otherUserIds();
  const onlineOthers = () => others().filter((id) => backend.isOnline(id));

  for (const person of PEOPLE) {
    const id = backend.userIdByEmail(person.email);
    if (INITIALLY_ONLINE.includes(person.handle) && id !== undefined && id !== backend.sessionUserId()) {
      backend.setOnline(id, true);
    }
  }

  const schedulePresence = () => {
    later(between(timing.presenceMs), () => {
      const online = onlineOthers();
      const offline = others().filter((id) => !backend.isOnline(id));
      const goOffline = online.length >= timing.maxOnline || (online.length > timing.minOnline && random() < 0.5);
      const person = pick(goOffline ? online : offline);
      if (person !== undefined) backend.setOnline(person, !goOffline);
      schedulePresence();
      return undefined;
    });
  };
  schedulePresence();

  const unsubscribe = server.onEmit((target, event, args) => {
    const visitor = backend.sessionUserId();
    if (visitor === null) return;
    if (event === 'chat:message' && !replyPending) {
      const message = args[0] as ChatMessage;
      if (message.author.id !== visitor) return;
      const replier = pick(onlineOthers());
      if (replier === undefined) return;
      replyPending = true;
      later(between(timing.replyMs), () => {
        replyPending = false;
        const text = pick(CHAT_REPLIES);
        return text === undefined ? undefined : backend.postChatAs(replier, text);
      });
    }
    if (event === 'friendship:changed' && target.kind === 'user' && target.userId === visitor) {
      const change = args[0] as FriendshipChange;
      if (change.state !== 'pending_outgoing') return;
      later(between(timing.acceptMs), () =>
        backend.hasPendingRequest(visitor, change.userId) ? backend.acceptRequestAs(change.userId, visitor) : undefined,
      );
    }
  });

  return () => {
    unsubscribe();
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  };
}
