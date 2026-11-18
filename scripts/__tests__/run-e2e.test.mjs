import { describe, expect, it } from 'vitest';

import { DEFAULT_E2E_PORT, E2E_PROJECT, composeArgs, parseArgs, resolveE2ePort } from '../run-e2e.mjs';

describe('run-e2e', () => {
  it('B-139: uses its own compose project, both compose files and the app profile', () => {
    expect(E2E_PROJECT).toBe('social-network-e2e');
    expect(composeArgs('up', '-d', '--build', '--wait')).toEqual([
      'compose',
      '-p',
      'social-network-e2e',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.e2e.yml',
      '--profile',
      'app',
      'up',
      '-d',
      '--build',
      '--wait',
    ]);
  });

  it('B-07: resolves E2E_PORT once: environment, then .env, then 8183', () => {
    expect(DEFAULT_E2E_PORT).toBe(8183);
    expect(resolveE2ePort({ E2E_PORT: '9100' }, new Map([['E2E_PORT', '9200']]))).toBe(9100);
    expect(resolveE2ePort({ E2E_PORT: ' ' }, new Map([['E2E_PORT', '9200']]))).toBe(9200);
    expect(resolveE2ePort({}, new Map([['E2E_PORT', '']]))).toBe(8183);
    expect(resolveE2ePort({}, new Map())).toBe(8183);
  });

  it('B-07: rejects an invalid E2E_PORT and names its source', () => {
    expect(() => resolveE2ePort({ E2E_PORT: '80a' }, new Map())).toThrow(/E2E_PORT from the environment/);
    expect(() => resolveE2ePort({}, new Map([['E2E_PORT', '70000']]))).toThrow(/E2E_PORT from \.env/);
    expect(() => resolveE2ePort({ E2E_PORT: '0' }, new Map())).toThrow(/between 1 and 65535/);
    expect(() => resolveE2ePort({ E2E_PORT: '-1' }, new Map())).toThrow(/between 1 and 65535/);
  });

  it('B-139: passes everything except its own flags to Playwright', () => {
    expect(parseArgs(['e2e/routing.spec.ts', '--keep', '--project=desktop'])).toEqual({
      mode: 'test',
      keep: true,
      playwrightArgs: ['e2e/routing.spec.ts', '--project=desktop'],
    });
    expect(parseArgs([])).toEqual({ mode: 'test', keep: false, playwrightArgs: [] });
    expect(parseArgs(['--up']).mode).toBe('up');
    expect(parseArgs(['--down']).mode).toBe('down');
    expect(() => parseArgs(['--up', '--down'])).toThrow('either --up or --down');
  });
});
