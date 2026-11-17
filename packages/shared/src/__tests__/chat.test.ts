import { describe, expect, expectTypeOf, it } from 'vitest';

import { type Ack, CHAT_MAX, ChatPage, type ChatMessage, SendChatMessage, SocketError } from '../index.js';

const message = {
  id: 1,
  author: { id: 3, firstName: 'Mira', lastName: 'Novak', avatarUrl: null },
  body: 'Hi',
  createdAt: '2026-11-15T14:05:00.000Z',
};

describe('SendChatMessage (F-78)', () => {
  it('trims the body and keeps inner line breaks (Shift+Enter)', () => {
    expect(SendChatMessage.parse({ body: '  first line\nsecond line \n' })).toEqual({
      body: 'first line\nsecond line',
    });
  });

  it.each(['', '  ', '\n\n'])('rejects the empty message %j', (body) => {
    expect(SendChatMessage.safeParse({ body }).success).toBe(false);
  });

  it('accepts 1,000 characters counted after trimming and rejects 1,001', () => {
    expect(CHAT_MAX).toBe(1000);
    expect(SendChatMessage.safeParse({ body: ` ${'a'.repeat(CHAT_MAX)} ` }).success).toBe(true);
    expect(SendChatMessage.safeParse({ body: 'a'.repeat(CHAT_MAX + 1) }).success).toBe(false);
  });
});

// F-112, B-48: socket payloads arrive as `unknown`; anything malformed is a parse failure, never a throw.
describe('SendChatMessage with untrusted socket payloads (F-112)', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'hi'],
    ['a number', 42],
    ['an array', [{ body: 'hi' }]],
    ['a numeric body', { body: 42 }],
    ['an array body', { body: ['hi'] }],
    ['an object body', { body: { toString: 'hi' } }],
  ])('rejects %s without throwing', (_label, payload) => {
    expect(() => SendChatMessage.safeParse(payload)).not.toThrow();
    expect(SendChatMessage.safeParse(payload).success).toBe(false);
  });
});

describe('ChatPage', () => {
  it('parses a newest-first page', () => {
    expect(ChatPage.parse({ items: [message], nextCursor: null })).toEqual({ items: [message], nextCursor: null });
  });
});

describe('socket acknowledgements', () => {
  it('SocketError accepts the documented codes and an optional retry hint', () => {
    expect(SocketError.parse({ code: 'rate-limited', message: 'Slow down.', retryAfterMs: 4000 })).toEqual({
      code: 'rate-limited',
      message: 'Slow down.',
      retryAfterMs: 4000,
    });
    expect(SocketError.safeParse({ code: 'teapot', message: 'x' }).success).toBe(false);
    expect(SocketError.safeParse({ code: 'internal', message: 'x', retryAfterMs: 1.5 }).success).toBe(false);
  });

  it('Ack is either ok with the payload or an error', () => {
    expectTypeOf<Ack<{ message: ChatMessage }>>().toEqualTypeOf<
      ({ ok: true } & { message: ChatMessage }) | { ok: false; error: SocketError }
    >();
    const ack: Ack<{ message: ChatMessage }> = { ok: true, message };
    expect(ack.ok).toBe(true);
  });
});
