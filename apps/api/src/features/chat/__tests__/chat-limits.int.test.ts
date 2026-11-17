import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolveLimits, type Limits } from '../../../config/limits.js';
import { recordEvents, waitFor } from '../../../../test/socket.js';
import { createTestApp, TEST_RATE_LIMIT_MULTIPLIER, type TestApp } from '../../../../test/test-app.js';
import { chatMessageCount, createSocketTracker, sendChat, sendChatOk, signedInChatter } from './fixtures.js';

/**
 * F-84: `chat:send` is limited per user in Redis (`limits.chatSend`, 10 per 10 s in production). This file builds its
 * own app with a low, exact budget (BUILD-ORDER Phase 2: limiter tests pass explicit limits); every other limit stays
 * at the multiplied test values.
 */

const BUDGET = 3;
const WINDOW_MS = 1_500;

function chatLimits(): Limits {
  return {
    ...resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER }),
    chatSend: { limit: BUDGET, windowMs: WINDOW_MS },
  };
}

let testApp: TestApp;
const sockets = createSocketTracker();

beforeAll(async () => {
  testApp = await createTestApp({ limits: chatLimits() });
});

afterEach(() => {
  sockets.closeAll();
});

afterAll(async () => {
  await testApp.close();
});

async function connectedChatter() {
  const chatter = await signedInChatter(testApp);
  return { ...chatter, socket: await sockets.connect(testApp, chatter.agent) };
}

describe('chat:send rate limit (F-84)', () => {
  it('F-84: over budget the ack is rate-limited with retryAfterMs; nothing is stored or broadcast', async () => {
    const ada = await connectedChatter();
    const grace = await connectedChatter();
    const atGrace = recordEvents(grace.socket, 'chat:message');

    for (let sent = 0; sent < BUDGET; sent++) await sendChatOk(ada.socket, `Message ${String(sent + 1)}`);
    const rejected = await sendChat(ada.socket, { body: 'One too many' });

    expect(rejected).toStrictEqual({
      ok: false,
      error: {
        code: 'rate-limited',
        message: expect.any(String) as string,
        retryAfterMs: expect.any(Number) as number,
      },
    });
    if (rejected.ok) throw new Error('expected a rejection');
    expect(rejected.error.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.error.retryAfterMs).toBeLessThanOrEqual(WINDOW_MS);
    expect(ada.socket.connected).toBe(true);
    expect(await chatMessageCount(testApp.db, ada.user.id)).toBe(BUDGET);

    const delivered = waitFor(grace.socket, 'chat:message', { filter: ({ body }) => body === 'Marker' });
    await sendChatOk(grace.socket, 'Marker');
    await delivered;
    expect(atGrace.filter(({ body }) => body === 'One too many')).toHaveLength(0);
  });

  it('F-84: the budget is per user: another user can still send while one is limited', async () => {
    const ada = await connectedChatter();
    const grace = await connectedChatter();
    for (let sent = 0; sent < BUDGET; sent++) await sendChatOk(ada.socket, 'Spam');
    await expect(sendChat(ada.socket, { body: 'Spam' })).resolves.toMatchObject({ ok: false });
    await expect(sendChatOk(grace.socket, 'Unaffected')).resolves.toMatchObject({ body: 'Unaffected' });
  });

  it('F-84: the budget is shared by all sockets of a user and survives a reconnect', async () => {
    const ada = await connectedChatter();
    const secondTab = await sockets.connect(testApp, ada.agent);
    await sendChatOk(ada.socket, 'Tab one');
    await sendChatOk(secondTab, 'Tab two');
    await sendChatOk(ada.socket, 'Tab one again');
    await expect(sendChat(secondTab, { body: 'Tab two again' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    });

    ada.socket.close();
    const reconnected = await sockets.connect(testApp, ada.agent);
    await expect(sendChat(reconnected, { body: 'After reconnect' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    });
  });

  it('F-84: invalid payloads are rejected before the limiter and do not use up the budget', async () => {
    const ada = await connectedChatter();
    for (let attempt = 0; attempt < BUDGET * 2; attempt++) {
      await expect(sendChat(ada.socket, { body: '' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation-failed' },
      });
    }
    for (let sent = 0; sent < BUDGET; sent++) await sendChatOk(ada.socket, 'Still within budget');
  });

  it('F-84: sending works again once the window has passed', async () => {
    const ada = await connectedChatter();
    for (let sent = 0; sent < BUDGET; sent++) await sendChatOk(ada.socket, 'Fill the window');
    await expect(sendChat(ada.socket, { body: 'Too soon' })).resolves.toMatchObject({ ok: false });

    // Polls the real Redis window (fixed window: rejected attempts never extend it) instead of sleeping blindly.
    await vi.waitFor(
      async () => {
        await expect(sendChat(ada.socket, { body: 'Next window' })).resolves.toMatchObject({ ok: true });
      },
      { timeout: WINDOW_MS * 4, interval: 250 },
    );
  });
});
