import { AVATAR_MAX_BYTES } from '@app/shared';
import { z } from 'zod';

import { RATE_LIMIT_MULTIPLIER_RANGE } from './limits.js';

const integer = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/**
 * An exact origin (`scheme://host[:port]`, no path, no trailing slash). CORS and the socket handshake compare the
 * `Origin` header with these strings verbatim, so `http://localhost:5173/` would never match anything (ADR-0005).
 */
const origin = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, 'must be an origin like http://127.0.0.1:8080 (no path, no trailing slash)');

/** Shared with the tooling entry points (db/seed/cli.ts), so every process accepts the same values. */
export const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info');
export const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' });

/** Object storage keys, shared with db/seed/cli.ts so the API and the seed accept exactly the same values. */
export const S3EnvSchema = z.object({
  S3_ENDPOINT: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(), // MinIO; unset for AWS
  S3_REGION: z.string().min(1).default('eu-central-1'),
  S3_BUCKET: z.string().min(3, 'must be at least 3 characters'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

/** Comma-separated list; blanks around entries are ignored. */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(origin));

/** OVERVIEW.md §13. Secrets have no defaults; SEED_* keys belong to the seed entry point (db/seed/cli.ts). */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integer(1, 65_535, 3000),
  LOG_LEVEL: LogLevel,
  // Number of reverse proxies in front of the API (0 = none): decides the client IP for rate limits and whether
  // X-Forwarded-Proto counts for secure cookies. Compose sets 1 (nginx).
  TRUST_PROXY: integer(0, 5, 0),

  DATABASE_URL: DatabaseUrl,
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' }),

  // Secure, __Host- cookies need https end to end (or a proxy that sets X-Forwarded-Proto plus TRUST_PROXY).
  // Defaults to true in production; the local Docker stack over plain http sets false.
  COOKIE_SECURE: z.stringbool().optional(),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SESSION_TTL_DAYS: integer(1, 90, 7),
  CSRF_SECRET: z.string().min(32, 'must be at least 32 characters'),
  CORS_ORIGINS: originList.default([]),

  ...S3EnvSchema.shape,
  // Can only lower the avatar limit: the web client checks the shared AVATAR_MAX_BYTES before uploading and nginx
  // rejects bodies above 3 MB, so a larger value would never take effect (FEATURES Appendix C, ADR-0010).
  UPLOAD_MAX_BYTES: integer(1, AVATAR_MAX_BYTES, AVATAR_MAX_BYTES),

  PRESENCE_GRACE_MS: integer(0, 60_000, 5_000),
  // Multiplies every limit in config/limits.ts; may be fractional (OVERVIEW §10). The default 1 means "production
  // values" by itself, independent of the range's lower bound.
  RATE_LIMIT_MULTIPLIER: z.coerce
    .number()
    .min(RATE_LIMIT_MULTIPLIER_RANGE.min)
    .max(RATE_LIMIT_MULTIPLIER_RANGE.max)
    .default(1),
});

export type Env = z.infer<typeof EnvSchema>;

/** Secure cookies with `__Host-` names. NODE_ENV only supplies the default; COOKIE_SECURE decides. */
export function cookiesAreSecure(env: Pick<Env, 'COOKIE_SECURE' | 'NODE_ENV'>): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Validates `source` against `schema`. Empty values count as unset, so `SESSION_SECRET=` in a fresh .env is reported
 * as missing and `S3_ENDPOINT=` means "use AWS". The error lists failing keys and rules only, never a value, so
 * secrets cannot reach a log (F-110, B-01, B-03). Shared with the tooling entry points (db/seed/cli.ts).
 */
export function parseEnvironment<Schema extends z.ZodType>(schema: Schema, source: EnvSource): z.output<Schema> {
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.map(String).join('.') || '(root)';
      const [first] = issue.path;
      const missing = typeof first === 'string' && present[first] === undefined;
      return `  - ${key}: ${missing ? 'is required' : issue.message}`;
    });
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return result.data;
}

/**
 * Parses the configuration once at startup. This is the only reader of `process.env` in the app; everything else
 * receives the returned object, or the slice it needs, through the composition root.
 */
export function loadEnv(source: EnvSource = process.env): Env {
  return parseEnvironment(EnvSchema, source);
}
