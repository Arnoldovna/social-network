import { AVATAR_MAX_BYTES } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { APP_SLUG } from '../app.js';
import { cookiesAreSecure, loadEnv } from '../env.js';
import { DEFAULT_LIMITS, type Limits, resolveLimits } from '../limits.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://user:local-only@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 's'.repeat(32),
  CSRF_SECRET: 'c'.repeat(32),
  S3_BUCKET: 'avatars',
  S3_ACCESS_KEY_ID: 'minio-local',
  S3_SECRET_ACCESS_KEY: 'not-a-real-secret',
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('loadEnv', () => {
  it('Appendix C: the upload limit defaults to the shared avatar limit (2 MiB)', () => {
    expect(loadEnv(REQUIRED).UPLOAD_MAX_BYTES).toBe(AVATAR_MAX_BYTES);
    expect(loadEnv({ ...REQUIRED, UPLOAD_MAX_BYTES: '1048576' }).UPLOAD_MAX_BYTES).toBe(1_048_576);
  });

  it('Appendix C: rejects an upload limit above the client and nginx limits instead of silently ignoring it', () => {
    expect(() => loadEnv({ ...REQUIRED, UPLOAD_MAX_BYTES: String(AVATAR_MAX_BYTES + 1) })).toThrow(/UPLOAD_MAX_BYTES/);
    expect(() => loadEnv({ ...REQUIRED, UPLOAD_MAX_BYTES: '0' })).toThrow(/UPLOAD_MAX_BYTES/);
  });

  it('B-01, B-02, B-03, F-110: names failing keys but never their values', () => {
    const secret = 'too-short-secret-value';

    const load = () => loadEnv({ ...REQUIRED, SESSION_SECRET: secret, CSRF_SECRET: '' });

    expect(load).toThrow(/SESSION_SECRET: must be at least 32 characters\n {2}- CSRF_SECRET: is required/);
    expect(load).not.toThrow(secret);
  });

  it('B-04: refuses to start without DATABASE_URL, the only source of the database credentials', () => {
    const withoutDatabaseUrl = Object.fromEntries(Object.entries(REQUIRED).filter(([key]) => key !== 'DATABASE_URL'));

    expect(() => loadEnv(withoutDatabaseUrl)).toThrow(/- DATABASE_URL: /);
  });

  it('OVERVIEW §13: session TTL, presence grace and rate-limit multiplier have their documented defaults', () => {
    const env = loadEnv(REQUIRED);

    expect(env.SESSION_TTL_DAYS).toBe(7);
    expect(env.PRESENCE_GRACE_MS).toBe(5000);
    expect(env.RATE_LIMIT_MULTIPLIER).toBe(1);
  });

  it('accepts values at the documented bounds', () => {
    const lower = loadEnv({ ...REQUIRED, SESSION_TTL_DAYS: '1', PRESENCE_GRACE_MS: '0', RATE_LIMIT_MULTIPLIER: '1' });
    const upper = loadEnv({
      ...REQUIRED,
      SESSION_TTL_DAYS: '90',
      PRESENCE_GRACE_MS: '60000',
      RATE_LIMIT_MULTIPLIER: '10000',
    });

    expect([lower.SESSION_TTL_DAYS, lower.PRESENCE_GRACE_MS, lower.RATE_LIMIT_MULTIPLIER]).toEqual([1, 0, 1]);
    expect([upper.SESSION_TTL_DAYS, upper.PRESENCE_GRACE_MS, upper.RATE_LIMIT_MULTIPLIER]).toEqual([
      90, 60_000, 10_000,
    ]);
  });

  it('accepts a fractional rate-limit multiplier', () => {
    expect(loadEnv({ ...REQUIRED, RATE_LIMIT_MULTIPLIER: '2.5' }).RATE_LIMIT_MULTIPLIER).toBe(2.5);
  });

  it.each([
    ['SESSION_TTL_DAYS', '0'],
    ['SESSION_TTL_DAYS', '91'],
    ['SESSION_TTL_DAYS', '1.5'],
    ['SESSION_TTL_DAYS', 'seven'],
    ['PRESENCE_GRACE_MS', '-1'],
    ['PRESENCE_GRACE_MS', '60001'],
    ['PRESENCE_GRACE_MS', '2.5'],
    ['RATE_LIMIT_MULTIPLIER', '0'],
    ['RATE_LIMIT_MULTIPLIER', '0.5'],
    ['RATE_LIMIT_MULTIPLIER', '10001'],
    ['RATE_LIMIT_MULTIPLIER', 'Infinity'],
    ['RATE_LIMIT_MULTIPLIER', 'many'],
  ])('rejects %s=%s and names the key', (key, value) => {
    expect(() => loadEnv({ ...REQUIRED, [key]: value })).toThrow(new RegExp(`- ${key}: `));
  });

  it('B-07, ADR-0005: parses CORS_ORIGINS as a list of exact origins and ignores blanks', () => {
    const env = loadEnv({ ...REQUIRED, CORS_ORIGINS: ' http://127.0.0.1:8080 , ,https://example.com ' });

    expect(env.CORS_ORIGINS).toEqual(['http://127.0.0.1:8080', 'https://example.com']);
    expect(loadEnv(REQUIRED).CORS_ORIGINS).toEqual([]);
  });

  it.each(['http://localhost:5173/', 'http://localhost:5173/app', 'ftp://example.com', 'localhost:5173'])(
    'B-07: rejects %s as a CORS origin, because it would never equal an Origin header',
    (value) => {
      expect(() => loadEnv({ ...REQUIRED, CORS_ORIGINS: value })).toThrow(/CORS_ORIGINS/);
    },
  );
});

describe('cookiesAreSecure', () => {
  it('F-19: defaults to secure cookies in production only; COOKIE_SECURE decides when set', () => {
    expect(cookiesAreSecure(loadEnv({ ...REQUIRED, NODE_ENV: 'production' }))).toBe(true);
    expect(cookiesAreSecure(loadEnv({ ...REQUIRED, NODE_ENV: 'development' }))).toBe(false);
    expect(cookiesAreSecure(loadEnv({ ...REQUIRED, NODE_ENV: 'production', COOKIE_SECURE: 'false' }))).toBe(false);
    expect(cookiesAreSecure(loadEnv({ ...REQUIRED, NODE_ENV: 'development', COOKIE_SECURE: 'true' }))).toBe(true);
  });
});

describe('APP_SLUG', () => {
  it('conventions §8: is the lowercase repository slug used for cookies, Redis prefixes and problem types', () => {
    expect(APP_SLUG).toBe('social-network');
  });
});

describe('DEFAULT_LIMITS', () => {
  it('OVERVIEW §10, ADR-0006, F-16, F-84: holds the production values of every limiter', () => {
    const expected: Limits = {
      global: { limit: 300, windowMs: MINUTE },
      auth: { limit: 10, windowMs: 15 * MINUTE },
      loginStrict: { limit: 5, windowMs: 15 * MINUTE },
      loginCeiling: { limit: 50, windowMs: 60 * MINUTE },
      search: { limit: 60, windowMs: MINUTE },
      write: { limit: 60, windowMs: 10 * MINUTE },
      upload: { limit: 20, windowMs: 60 * MINUTE },
      socketHandshake: { limit: 30, windowMs: MINUTE },
      chatSend: { limit: 10, windowMs: 10 * SECOND },
      wallJoin: { limit: 30, windowMs: MINUTE },
    };

    expect(DEFAULT_LIMITS).toEqual(expected);
  });

  it('is deeply frozen, so no caller can change the production values for everyone else', () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect(Object.values(DEFAULT_LIMITS).every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});

describe('resolveLimits', () => {
  it('uses the production values with the default multiplier from the environment', () => {
    expect(resolveLimits(loadEnv(REQUIRED))).toEqual(DEFAULT_LIMITS);
  });

  it('ADR-0016: multiplies every limit and keeps every window (integration tests and E2E use 100)', () => {
    const limits = resolveLimits(loadEnv({ ...REQUIRED, RATE_LIMIT_MULTIPLIER: '100' }));

    for (const [name, { limit, windowMs }] of Object.entries(DEFAULT_LIMITS)) {
      expect(limits[name as keyof Limits]).toEqual({ limit: limit * 100, windowMs });
    }
    expect(limits.loginStrict).toEqual({ limit: 500, windowMs: 15 * MINUTE });
  });

  it('rounds a fractional product down to a whole number that is never below the production value', () => {
    const limits = resolveLimits({ RATE_LIMIT_MULTIPLIER: 1.5 });

    expect(limits.loginStrict.limit).toBe(7);
    expect(limits.global.limit).toBe(450);
    for (const [name, { limit }] of Object.entries(limits)) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThanOrEqual(DEFAULT_LIMITS[name as keyof Limits].limit);
    }
  });

  it.each([0, 0.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws for the out-of-range multiplier %s instead of producing unusable limits',
    (multiplier) => {
      expect(() => resolveLimits({ RATE_LIMIT_MULTIPLIER: multiplier })).toThrow(RangeError);
    },
  );

  it('returns a new frozen object and leaves DEFAULT_LIMITS unchanged', () => {
    const limits = resolveLimits({ RATE_LIMIT_MULTIPLIER: 100 });

    expect(limits).not.toBe(DEFAULT_LIMITS);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.values(limits).every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(DEFAULT_LIMITS.global.limit).toBe(300);
  });
});
