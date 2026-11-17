import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkDatabaseUrl } from '../dev-setup.mjs';
import { SECRET_KEYS, parseEnv } from '../setup-env.mjs';

const TEXT = readFileSync(resolve(import.meta.dirname, '../../.env.example'), 'utf8');
const ENV = parseEnv(TEXT);

/** OVERVIEW §13 without SEED_ALLOW and E2E_BASE_URL, which are set per invocation (ADR-0019 §7). */
const DOCUMENTED_KEYS = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'TRUST_PROXY',
  'DATABASE_URL',
  'REDIS_URL',
  'COOKIE_SECURE',
  'SESSION_SECRET',
  'SESSION_TTL_DAYS',
  'CSRF_SECRET',
  'CORS_ORIGINS',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'UPLOAD_MAX_BYTES',
  'PRESENCE_GRACE_MS',
  'RATE_LIMIT_MULTIPLIER',
  'SEED_DEMO_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'WEB_PORT',
  'E2E_PORT',
];

describe('.env.example', () => {
  it('B-03: documents every configuration key and nothing else', () => {
    expect([...ENV.keys()].sort()).toEqual([...DOCUMENTED_KEYS].sort());
    expect(ENV.has('SEED_ALLOW')).toBe(false);
    expect(ENV.has('E2E_BASE_URL')).toBe(false);
  });

  it('B-03: every key has a comment directly above it', () => {
    const lines = TEXT.split('\n');
    lines.forEach((line, index) => {
      if (!/^[A-Z0-9_]+=/.test(line)) return;
      expect(lines[index - 1], `comment above ${line.split('=')[0] ?? ''}`).toMatch(/^# \S/);
    });
  });

  it('B-01: leaves every generated secret empty; only the fixed local Postgres password is set', () => {
    for (const key of SECRET_KEYS) expect(ENV.get(key), key).toBe('');
    expect(ENV.get('POSTGRES_PASSWORD')).toBe('local-only');
  });

  it('B-04: DATABASE_URL names the same user, password and database as POSTGRES_*', () => {
    expect(checkDatabaseUrl((name) => ENV.get(name) ?? '')).toEqual([]);
  });

  it('B-07: allows the Vite dev origins and uses the fixed project ports', () => {
    expect(ENV.get('CORS_ORIGINS')).toBe('http://localhost:5173,http://127.0.0.1:5173');
    expect(ENV.get('WEB_PORT')).toBe('8080');
    expect(ENV.get('E2E_PORT')).toBe('8183');
  });

  it('B-05: avatars bucket and the 2 MiB upload limit', () => {
    expect(ENV.get('S3_BUCKET')).toBe('avatars');
    expect(ENV.get('UPLOAD_MAX_BYTES')).toBe('2097152');
  });
});
