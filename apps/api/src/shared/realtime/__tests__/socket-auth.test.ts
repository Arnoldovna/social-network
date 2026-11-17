import type { IncomingHttpHeaders } from 'node:http';

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { clientAddress, originCheck, type UpgradeRequestAddress } from '../socket-auth.js';

const Addresses = z.object({ express: z.string(), handshake: z.string() });

function upgradeRequest(headers: IncomingHttpHeaders, remoteAddress?: string): UpgradeRequestAddress {
  return { headers, socket: { remoteAddress } };
}

describe('originCheck() (F-111, B-07)', () => {
  const allowed = ['http://127.0.0.1:8080', 'http://localhost:8080'];

  function check(origin: string | undefined) {
    const callback = vi.fn();
    const headers: IncomingHttpHeaders = origin === undefined ? {} : { origin };
    originCheck(allowed)(upgradeRequest(headers), callback);
    return callback;
  }

  it('accepts an allow-listed origin', () => {
    expect(check('http://localhost:8080')).toHaveBeenCalledExactlyOnceWith(null, true);
  });

  it('rejects a missing Origin (only possible outside a browser, since polling is off)', () => {
    expect(check(undefined)).toHaveBeenCalledExactlyOnceWith('origin not allowed', false);
  });

  it.each([
    'https://evil.example',
    'http://127.0.0.1:8081',
    'https://127.0.0.1:8080',
    'http://127.0.0.1:8080/',
    'HTTP://LOCALHOST:8080',
    'null',
    '',
  ])('rejects %j: the comparison is exact', (origin) => {
    expect(check(origin)).toHaveBeenCalledExactlyOnceWith('origin not allowed', false);
  });

  it('rejects everything with an empty allow-list', () => {
    const callback = vi.fn();
    originCheck([])(upgradeRequest({ origin: 'http://localhost:8080' }), callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith('origin not allowed', false);
  });
});

describe('clientAddress() (Express numeric trust proxy semantics)', () => {
  it('uses the peer address and ignores X-Forwarded-For without trusted proxies (no spoofing)', () => {
    const req = upgradeRequest({ 'x-forwarded-for': '203.0.113.9' }, '198.51.100.1');
    expect(clientAddress(req, 0)).toBe('198.51.100.1');
  });

  it('behind one proxy uses the entry that proxy appended, not a client-supplied one', () => {
    const req = upgradeRequest({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '172.18.0.5');
    expect(clientAddress(req, 1)).toBe('203.0.113.9');
  });

  it('walks one entry further per trusted hop', () => {
    const req = upgradeRequest({ 'x-forwarded-for': '203.0.113.9, 10.0.0.2' }, '10.0.0.1');
    expect(clientAddress(req, 2)).toBe('203.0.113.9');
  });

  it('stops at the left-most entry when more hops are trusted than present', () => {
    const req = upgradeRequest({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.1');
    expect(clientAddress(req, 5)).toBe('203.0.113.9');
  });

  it('falls back to the peer when the header is missing or blank', () => {
    expect(clientAddress(upgradeRequest({}, '10.0.0.1'), 1)).toBe('10.0.0.1');
    expect(clientAddress(upgradeRequest({ 'x-forwarded-for': ' , ' }, '10.0.0.1'), 1)).toBe('10.0.0.1');
  });

  it('returns an empty string for a closed socket without an address', () => {
    expect(clientAddress(upgradeRequest({}), 0)).toBe('');
  });

  it.each([0, 1, 2, 5])(
    'equals req.ip of an Express app with trust proxy %i, so HTTP and handshake limiters key a client alike',
    async (hops) => {
      const app = express();
      app.set('trust proxy', hops);
      app.get('/ip', (req, res) => {
        res.json({ express: req.ip, handshake: clientAddress(req, hops) });
      });

      for (const forwarded of ['203.0.113.9', '6.6.6.6, 203.0.113.9', 'a, , b', ' , ', ',203.0.113.9,,10.0.0.2,']) {
        const response = await request(app).get('/ip').set('X-Forwarded-For', forwarded);
        const { express: expected, handshake } = Addresses.parse(response.body);
        expect(handshake, `X-Forwarded-For: ${forwarded}`).toBe(expected);
      }
    },
  );
});
