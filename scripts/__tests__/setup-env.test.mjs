import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnv as nodeParseEnv } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_EMAIL, SECRET_KEYS, generateSecret, isSecretKey, mergeEnv, parseEnv, setupEnv } from '../setup-env.mjs';

const EXAMPLE = [
  '# Header comment',
  '',
  '# development | production',
  'NODE_ENV=development',
  '# fixed local value, never generated',
  'POSTGRES_PASSWORD=local-only',
  '# signs the session cookie',
  'SESSION_SECRET=',
  '# signs the CSRF token',
  'CSRF_SECRET=',
  '# MinIO root user and password',
  'S3_ACCESS_KEY_ID=minio-local',
  'S3_SECRET_ACCESS_KEY=',
  '# demo login password',
  'SEED_DEMO_PASSWORD=',
  '# host port',
  'WEB_PORT=8080',
  '',
].join('\n');

function counter() {
  let n = 0;
  return () => `generated-${String(++n)}`;
}

describe('setup-env: secret keys', () => {
  it('B-01: generates exactly SESSION_SECRET, CSRF_SECRET, S3_SECRET_ACCESS_KEY and SEED_DEMO_PASSWORD', () => {
    expect(SECRET_KEYS).toEqual(['SESSION_SECRET', 'CSRF_SECRET', 'S3_SECRET_ACCESS_KEY', 'SEED_DEMO_PASSWORD']);
    expect(SECRET_KEYS.every(isSecretKey)).toBe(true);
  });

  it('B-01: never treats POSTGRES_PASSWORD as a generated secret (DATABASE_URL carries it literally)', () => {
    expect(['POSTGRES_PASSWORD', 'S3_ACCESS_KEY_ID', 'NODE_ENV', 'SECRET'].some(isSecretKey)).toBe(false);
  });

  it('B-01: generates 32 random bytes as base64url', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(secret);
  });
});

describe('setup-env: parseEnv', () => {
  it('B-03: reads keys, unquotes values and ignores comments', () => {
    const env = parseEnv('# c\nA=1\nexport B="two words"\nC=\'x # y\'\nD=plain # trailing\n\nE=\n');
    expect([...env]).toEqual([
      ['A', '1'],
      ['B', 'two words'],
      ['C', 'x # y'],
      ['D', 'plain'],
      ['E', ''],
    ]);
  });

  it("B-03: reads every value exactly like Node's --env-file, which the API, migrate and seed use", () => {
    const text = 'A= # fill me\nB=#todo\nC=abc#def\nD="abc#d" # comment\nE=  spaced  \nF=a=b\n';

    expect(Object.fromEntries(parseEnv(text))).toEqual(nodeParseEnv(text));
    expect(Object.fromEntries(parseEnv(text))).toEqual({ A: '', B: '', C: 'abc', D: 'abc#d', E: 'spaced', F: 'a=b' });
  });
});

describe('setup-env: mergeEnv', () => {
  it('B-01: creates .env from the example and fills every empty secret, nothing else', () => {
    const result = mergeEnv({ current: null, example: EXAMPLE, generate: counter() });

    expect(result.created).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.generated).toEqual(['SESSION_SECRET', 'CSRF_SECRET', 'S3_SECRET_ACCESS_KEY', 'SEED_DEMO_PASSWORD']);
    const env = parseEnv(result.text);
    expect(env.get('SESSION_SECRET')).toBe('generated-1');
    expect(env.get('SEED_DEMO_PASSWORD')).toBe('generated-4');
    expect(env.get('POSTGRES_PASSWORD')).toBe('local-only');
    expect(result.text).toContain('# signs the session cookie\nSESSION_SECRET=generated-1\n');
  });

  it('B-63: never overwrites existing values and is byte-identical on the second run', () => {
    const first = mergeEnv({ current: null, example: EXAMPLE, generate: counter() }).text;
    const edited = first.replace('WEB_PORT=8080', 'WEB_PORT=9090');
    const second = mergeEnv({ current: edited, example: EXAMPLE, generate: counter() });

    expect(second.text).toBe(edited);
    expect(second.created).toBe(false);
    expect(second.added).toEqual([]);
    expect(second.generated).toEqual([]);
  });

  it('B-01: fills a secret that is still empty and appends missing keys with their comments', () => {
    const current = 'NODE_ENV=production\nSESSION_SECRET=keep-me\nCSRF_SECRET=\nPOSTGRES_PASSWORD=local-only\n';
    const result = mergeEnv({ current, example: EXAMPLE, generate: counter() });

    expect(result.added).toEqual(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'SEED_DEMO_PASSWORD', 'WEB_PORT']);
    expect(result.generated).toEqual(['CSRF_SECRET', 'S3_SECRET_ACCESS_KEY', 'SEED_DEMO_PASSWORD']);
    expect(result.text).toBe(
      [
        'NODE_ENV=production',
        'SESSION_SECRET=keep-me',
        'CSRF_SECRET=generated-1',
        'POSTGRES_PASSWORD=local-only',
        '',
        '# MinIO root user and password',
        'S3_ACCESS_KEY_ID=minio-local',
        'S3_SECRET_ACCESS_KEY=generated-2',
        '',
        '# demo login password',
        'SEED_DEMO_PASSWORD=generated-3',
        '',
        '# host port',
        'WEB_PORT=8080',
        '',
      ].join('\n'),
    );
    expect(mergeEnv({ current: result.text, example: EXAMPLE, generate: counter() }).text).toBe(result.text);
  });

  it('B-01: keeps quoted secrets and an emptied POSTGRES_PASSWORD as they are', () => {
    const current =
      'SESSION_SECRET="quoted"\nCSRF_SECRET=x\nS3_SECRET_ACCESS_KEY=y\nSEED_DEMO_PASSWORD=z\n' +
      'POSTGRES_PASSWORD=\nNODE_ENV=test\nS3_ACCESS_KEY_ID=a\nWEB_PORT=1\n';

    const result = mergeEnv({ current, example: EXAMPLE, generate: counter() });
    expect(result.text).toBe(current);
    expect(result.generated).toEqual([]);
  });

  it('B-01: fills a secret that Node reads as empty because only a comment follows the =', () => {
    const current = EXAMPLE.replace('SESSION_SECRET=', 'SESSION_SECRET= # fill me');
    const result = mergeEnv({ current, example: EXAMPLE, generate: counter() });

    expect(result.generated).toEqual(['SESSION_SECRET', 'CSRF_SECRET', 'S3_SECRET_ACCESS_KEY', 'SEED_DEMO_PASSWORD']);
    expect(result.text).toContain('\nSESSION_SECRET=generated-1\n');
    expect(result.ambiguous).toEqual([]);
  });

  it('B-03: reports unquoted values that Node and docker compose read differently, and nothing else', () => {
    const current = [
      'NODE_ENV=development # a comment after whitespace is read alike',
      'POSTGRES_PASSWORD=abc#def',
      'WEB_PORT=#8080',
      "S3_ACCESS_KEY_ID='quoted#value'",
      'SESSION_SECRET=x',
      'CSRF_SECRET=y',
      'S3_SECRET_ACCESS_KEY=z',
      'SEED_DEMO_PASSWORD=w',
      '',
    ].join('\n');

    expect(mergeEnv({ current, example: EXAMPLE, generate: counter() }).ambiguous).toEqual([
      'POSTGRES_PASSWORD',
      'WEB_PORT',
    ]);
  });

  it('B-03: normalises CRLF line endings and a missing final newline', () => {
    const result = mergeEnv({ current: null, example: 'A=1\r\nSESSION_SECRET=', generate: counter() });
    expect(result.text).toBe('A=1\nSESSION_SECRET=generated-1\n');
  });
});

describe('setup-env: setupEnv on disk', () => {
  /** @type {string} */
  let dir;
  /** @type {string[]} */
  let logs;
  const log = (/** @type {string} */ message) => {
    logs.push(message);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'setup-env-'));
    logs = [];
    writeFileSync(join(dir, '.env.example'), EXAMPLE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('B-01: writes .env with mode 600, prints key names and the demo login only', () => {
    setupEnv({ cwd: dir, log });

    const text = readFileSync(join(dir, '.env'), 'utf8');
    const env = parseEnv(text);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(logs).toEqual([
      'setup:env: created .env from .env.example',
      'setup:env: generated SESSION_SECRET, CSRF_SECRET, S3_SECRET_ACCESS_KEY, SEED_DEMO_PASSWORD',
      `setup:env: demo login ${DEMO_EMAIL} / ${env.get('SEED_DEMO_PASSWORD') ?? ''}`,
    ]);
    const printed = logs.join('\n');
    for (const key of ['SESSION_SECRET', 'CSRF_SECRET', 'S3_SECRET_ACCESS_KEY']) {
      expect(printed).not.toContain(env.get(key));
    }
  });

  it('B-63: a second run leaves .env byte-identical', () => {
    setupEnv({ cwd: dir, log });
    const first = readFileSync(join(dir, '.env'), 'utf8');
    logs = [];

    setupEnv({ cwd: dir, log });

    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(first);
    expect(logs[0]).toBe('setup:env: .env is complete, nothing changed');
  });

  it('B-03: refuses an ambiguous .env without changing it and names the key, never the value', () => {
    const current = 'POSTGRES_PASSWORD=pw7k#rest\nSESSION_SECRET=\n';
    writeFileSync(join(dir, '.env'), current);

    expect(() => setupEnv({ cwd: dir, log })).toThrow(/^\.env: the unquoted value of POSTGRES_PASSWORD contains a '#'/);
    expect(() => setupEnv({ cwd: dir, log })).not.toThrow(/pw7k|rest/);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(current);
  });

  it('B-03: fails with a clear message when .env.example is missing', () => {
    rmSync(join(dir, '.env.example'));
    expect(() => setupEnv({ cwd: dir, log })).toThrow(/\.env\.example not found/);
  });
});
