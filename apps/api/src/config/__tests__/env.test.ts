import { AVATAR_MAX_BYTES } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../env.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://user:local-only@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET: 's'.repeat(32),
  CSRF_SECRET: 'c'.repeat(32),
  S3_BUCKET: 'avatars',
  S3_ACCESS_KEY_ID: 'minio-local',
  S3_SECRET_ACCESS_KEY: 'not-a-real-secret',
};

describe('loadEnv', () => {
  it('Appendix C: the upload limit defaults to the shared avatar limit (2 MiB)', () => {
    expect(loadEnv(REQUIRED).UPLOAD_MAX_BYTES).toBe(AVATAR_MAX_BYTES);
    expect(loadEnv({ ...REQUIRED, UPLOAD_MAX_BYTES: '1048576' }).UPLOAD_MAX_BYTES).toBe(1_048_576);
  });

  it('Appendix C: rejects an upload limit above the client and nginx limits instead of silently ignoring it', () => {
    expect(() => loadEnv({ ...REQUIRED, UPLOAD_MAX_BYTES: String(AVATAR_MAX_BYTES + 1) })).toThrow(/UPLOAD_MAX_BYTES/);
  });

  it('B-01, F-110: names failing keys but never their values', () => {
    const secret = 'too-short-secret-value';

    const load = () => loadEnv({ ...REQUIRED, SESSION_SECRET: secret, CSRF_SECRET: '' });

    expect(load).toThrow(/SESSION_SECRET: must be at least 32 characters\n {2}- CSRF_SECRET: is required/);
    expect(load).not.toThrow(secret);
  });
});
