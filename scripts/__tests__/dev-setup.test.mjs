import { describe, expect, it } from 'vitest';

import { checkDatabaseUrl, checkTools, composeValue, isAtLeast, parseVersion } from '../dev-setup.mjs';

/** @type {Record<string, string | undefined>} */
const OK_PROBES = {
  pnpm: '10.34.9\n',
  git: 'git version 2.52.0\n',
  docker: '29.5.2\n',
  compose: 'v5.5.0\n',
};

/**
 * @param {Record<string, string | undefined>} [overrides]
 * @param {'dev' | 'demo'} [mode]
 * @param {string} [nodeVersion]
 */
function tools(overrides = {}, mode = 'dev', nodeVersion = 'v26.13.1') {
  const probes = { ...OK_PROBES, ...overrides };
  return checkTools({
    mode,
    nodeVersion,
    requiredNode: '26',
    requiredPnpm: '10.34.9',
    probe: (tool) => probes[tool] ?? null,
  });
}

const ENV = {
  DATABASE_URL: 'postgres://social_network:local-only@127.0.0.1:5432/social_network',
  POSTGRES_USER: 'social_network',
  POSTGRES_PASSWORD: 'local-only',
  POSTGRES_DB: 'social_network',
};

/** @param {Record<string, string>} env */
const lookup = (env) => (/** @type {string} */ name) => env[name] ?? '';

describe('dev-setup: tool check', () => {
  it('B-133: parses and compares tool versions', () => {
    expect(parseVersion('git version 2.50.1 (Apple Git-155)')).toEqual([2, 50, 1]);
    expect(parseVersion('v5.5')).toEqual([5, 5, 0]);
    expect(parseVersion('unknown')).toBeNull();
    expect(isAtLeast('2.24.4', '2.24.4')).toBe(true);
    expect(isAtLeast('v2.24.3', '2.24.4')).toBe(false);
    expect(isAtLeast('2.30.9', '2.31.0')).toBe(false);
    expect(isAtLeast('10.0.0', '2.31.0')).toBe(true);
    expect(isAtLeast('garbage', '2.31.0')).toBe(false);
  });

  it('B-133: accepts the Phase-0 toolchain', () => {
    expect(tools()).toEqual([]);
  });

  it('B-133: reports every missing or outdated tool at once', () => {
    const problems = tools({ pnpm: '9.15.0', git: 'git version 2.23.0', compose: '2.20.0' }, 'dev', 'v22.20.0');

    expect(problems).toHaveLength(4);
    const text = problems.join('\n');
    expect(text).toMatch(/Node 26 .*v22\.20\.0/);
    expect(text).toMatch(/pnpm 10\.34\.9 .*9\.15\.0/);
    expect(text).toMatch(/git 2\.31\.0 or later/);
    expect(text).toMatch(/Compose 2\.24\.4 or later .*2\.20\.0/);
  });

  it('B-133: reports a stopped Docker daemon and skips the Compose probe', () => {
    expect(tools({ docker: undefined, compose: undefined })).toEqual([
      'Docker is required and its daemon must be running (`docker info` failed). Start Docker, then retry.',
    ]);
  });

  it('B-133: the demo path does not need git (reviewers only run pnpm install and pnpm demo)', () => {
    expect(tools({ git: undefined }, 'demo')).toEqual([]);
    expect(tools({ git: undefined }, 'dev')).toEqual(['git 2.31.0 or later is required (lefthook), found none.']);
  });
});

describe('dev-setup: DATABASE_URL against POSTGRES_*', () => {
  it('B-04: accepts a DATABASE_URL that names the same user, password and database', () => {
    expect(checkDatabaseUrl(lookup(ENV))).toEqual([]);
    expect(
      checkDatabaseUrl(
        lookup({ ...ENV, DATABASE_URL: 'postgresql://social_network:local-only@localhost/social_network' }),
      ),
    ).toEqual([]);
  });

  it('B-04: compares percent-decoded URL parts', () => {
    const env = {
      ...ENV,
      POSTGRES_PASSWORD: 'p@ss',
      DATABASE_URL: 'postgres://social_network:p%40ss@h/social_network',
    };
    expect(checkDatabaseUrl(lookup(env))).toEqual([]);
  });

  it('B-01, B-04: names every mismatching key, never a value', () => {
    const env = { ...ENV, DATABASE_URL: 'postgres://someone:hunter2-secret@127.0.0.1:5432/other' };

    const [problem, ...rest] = checkDatabaseUrl(lookup(env));

    expect(rest).toEqual([]);
    expect(problem).toMatch(/^DATABASE_URL disagrees with POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB \(\.env\)\./);
    expect(problem).not.toContain('hunter2');
    expect(problem).not.toContain('someone');
  });

  it('B-04: rejects a missing, unparsable or non-Postgres DATABASE_URL', () => {
    expect(checkDatabaseUrl(lookup({ ...ENV, DATABASE_URL: '' }))).toEqual([
      'DATABASE_URL is missing or not a URL (.env).',
    ]);
    expect(checkDatabaseUrl(lookup({ ...ENV, DATABASE_URL: 'not a url' }))).toEqual([
      'DATABASE_URL is missing or not a URL (.env).',
    ]);
    expect(checkDatabaseUrl(lookup({ ...ENV, DATABASE_URL: 'redis://127.0.0.1:6379' }))).toEqual([
      'DATABASE_URL must start with postgres:// or postgresql:// (.env).',
    ]);
  });
});

describe('dev-setup: compose interpolation', () => {
  it('B-07: resolves like compose (non-empty process variable, then .env, then the fallback)', () => {
    const dotenv = new Map([['WEB_PORT', '8090']]);
    expect(composeValue('WEB_PORT', { WEB_PORT: '8099' }, dotenv, '8080')).toBe('8099');
    expect(composeValue('WEB_PORT', { WEB_PORT: '' }, dotenv, '8080')).toBe('8090');
    expect(composeValue('WEB_PORT', {}, new Map(), '8080')).toBe('8080');
    expect(composeValue('SEED_DEMO_PASSWORD', {}, new Map())).toBe('');
  });
});
