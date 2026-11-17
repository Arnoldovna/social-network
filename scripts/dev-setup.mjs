// `pnpm dev:setup` and `pnpm demo` (conventions §5, ADR-0017, ADR-0019 §7 and §8).
//
//   pnpm dev:setup  tool check (Node 26, pnpm, git, Docker running, Compose >= 2.24.4) -> setup:env ->
//                   stop when DATABASE_URL and POSTGRES_* disagree (key names only) -> pnpm infra:up ->
//                   pnpm db:migrate -> pnpm db:seed. Idempotent: a second run changes nothing (CI dev-setup-smoke).
//   pnpm demo       tool check (no git: reviewers only run `pnpm install` and `pnpm demo`) -> setup:env ->
//                   pnpm stack:up (production images; the `seed` service of profile `app` seeds) -> prints
//                   http://127.0.0.1:<WEB_PORT> and the demo login (the one secret conventions §5 allows to print).
//
// Node built-ins only. Every child runs from the repository root, so the script works from any directory.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEMO_EMAIL, parseEnv, setupEnv } from './setup-env.mjs';

const ROOT = resolve(import.meta.dirname, '..');
/** `!reset` and `!override` in docker-compose.e2e.yml need Compose 2.24.4 (ADR-0019 §6). */
export const MIN_COMPOSE = '2.24.4';
/** lefthook 2 calls `git rev-parse --path-format` (conventions §1). */
export const MIN_GIT = '2.31.0';
const DEFAULT_WEB_PORT = '8080';

/**
 * Parses the first `x.y[.z]` in a tool's version output.
 *
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * True when the version in `actual` is at least `minimum` (`x.y.z`).
 *
 * @param {string} actual
 * @param {string} minimum
 */
export function isAtLeast(actual, minimum) {
  const have = parseVersion(actual);
  const need = parseVersion(minimum);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = have[index] ?? 0;
    const b = need[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Checks the installed tools against the project's requirements. Pure: the probes are injected.
 *
 * @param {object} input
 * @param {'dev' | 'demo'} input.mode
 * @param {string} input.nodeVersion   e.g. process.version
 * @param {string} input.requiredNode  major from .nvmrc, e.g. '26'
 * @param {string} input.requiredPnpm  from package.json#packageManager, e.g. '10.34.9'
 * @param {(tool: 'pnpm' | 'git' | 'docker' | 'compose') => string | null} input.probe  version output, null if absent
 * @returns {string[]} one problem per missing or outdated tool, all at once
 */
export function checkTools({ mode, nodeVersion, requiredNode, requiredPnpm, probe }) {
  const problems = [];
  if (String(parseVersion(nodeVersion)?.[0]) !== requiredNode) {
    problems.push(`Node ${requiredNode} is required (.nvmrc), found ${nodeVersion}.`);
  }

  const pnpm = probe('pnpm');
  if (pnpm === null || parseVersion(pnpm)?.join('.') !== requiredPnpm) {
    problems.push(`pnpm ${requiredPnpm} is required (package.json#packageManager), found ${pnpm?.trim() || 'none'}.`);
  }

  if (mode === 'dev') {
    const git = probe('git');
    if (git === null || !isAtLeast(git, MIN_GIT)) {
      problems.push(`git ${MIN_GIT} or later is required (lefthook), found ${git?.trim() || 'none'}.`);
    }
  }

  if (probe('docker') === null) {
    problems.push(
      'Docker is required and its daemon must be running (`docker info` failed). Start Docker, then retry.',
    );
  } else {
    const compose = probe('compose');
    if (compose === null || !isAtLeast(compose, MIN_COMPOSE)) {
      problems.push(`Docker Compose ${MIN_COMPOSE} or later is required, found ${compose?.trim() || 'none'}.`);
    }
  }
  return problems;
}

/**
 * The value docker compose interpolates for `name`: a non-empty process variable wins over .env, then the fallback.
 * `tsx --env-file-if-exists` (db:migrate, db:seed, dev) never overrides a process variable either.
 *
 * @param {string} name
 * @param {Readonly<Record<string, string | undefined>>} processEnv
 * @param {Map<string, string>} dotenv
 * @param {string} [fallback]
 */
export function composeValue(name, processEnv, dotenv, fallback = '') {
  return processEnv[name] || dotenv.get(name) || fallback;
}

/**
 * Compose creates the database from POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB, while `pnpm dev`, `db:migrate` and
 * `db:seed` on the host connect with DATABASE_URL. Both must name the same user, password and database
 * (ADR-0019 §7). Messages name keys only, never values.
 *
 * @param {(name: string) => string} value  resolved value of a key (process environment, then .env)
 * @returns {string[]}
 */
export function checkDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value('DATABASE_URL'));
  } catch {
    return ['DATABASE_URL is missing or not a URL (.env).'];
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return ['DATABASE_URL must start with postgres:// or postgresql:// (.env).'];
  }
  const fromUrl = {
    POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    POSTGRES_DB: decodeURIComponent(url.pathname.slice(1)),
  };
  const mismatches = Object.entries(fromUrl)
    .filter(([key, expected]) => value(key) !== expected)
    .map(([key]) => key);
  return mismatches.length === 0
    ? []
    : [
        `DATABASE_URL disagrees with ${mismatches.join(', ')} (.env). Compose creates the database from POSTGRES_*, ` +
          'while pnpm dev and db:migrate connect with DATABASE_URL: make them name the same user, password and ' +
          'database.',
      ];
}

/** @param {'pnpm' | 'git' | 'docker' | 'compose'} tool */
function probeTool(tool) {
  /** @type {Record<typeof tool, [string, string[]]>} */
  const commands = {
    pnpm: ['pnpm', ['--version']],
    git: ['git', ['--version']],
    docker: ['docker', ['info', '--format', '{{.ServerVersion}}']],
    compose: ['docker', ['compose', 'version', '--short']],
  };
  const [command, args] = commands[tool];
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout : null;
}

/** @param {string} script a root package.json script */
function runScript(script) {
  process.stdout.write(`\n> pnpm ${script}\n`);
  const result = spawnSync('pnpm', [script], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw new Error(`could not start pnpm: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${script} failed${result.status === null ? '' : ` with exit code ${String(result.status)}`}.`,
    );
  }
}

function readProjectRequirements() {
  const requiredNode = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();
  /** @type {{ packageManager?: string }} */
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const requiredPnpm = /^pnpm@(\d+\.\d+\.\d+)/.exec(packageJson.packageManager ?? '')?.[1];
  if (!requiredPnpm) throw new Error('package.json#packageManager must be pnpm@<x.y.z>.');
  return { requiredNode, requiredPnpm };
}

/**
 * @param {'dev' | 'demo'} mode
 * @param {string} label the script name in messages
 */
function main(mode, label) {
  const problems = checkTools({ mode, nodeVersion: process.version, ...readProjectRequirements(), probe: probeTool });
  if (problems.length > 0) throw new Error(`missing prerequisites:\n  - ${problems.join('\n  - ')}`);

  setupEnv({ cwd: ROOT });
  const dotenv = parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8'));
  /** @param {string} name */
  const value = (name) => composeValue(name, process.env, dotenv);

  if (mode === 'demo') {
    runScript('stack:up');
    const port = composeValue('WEB_PORT', process.env, dotenv, DEFAULT_WEB_PORT);
    process.stdout.write(`\n${label}: social-network runs at http://127.0.0.1:${port}\n`);
    process.stdout.write(`${label}: demo login ${DEMO_EMAIL} / ${value('SEED_DEMO_PASSWORD')}\n`);
    process.stdout.write(`${label}: stop it with \`pnpm stack:down\` (keeps the data).\n`);
    return;
  }

  const databaseProblems = checkDatabaseUrl(value);
  if (databaseProblems.length > 0) throw new Error(databaseProblems.join('\n'));
  runScript('infra:up');
  runScript('db:migrate');
  runScript('db:seed');
  process.stdout.write(`\n${label}: done. Start the apps with \`pnpm dev\`.\n`);
}

if (import.meta.main) {
  const mode = process.argv.slice(2).includes('--demo') ? 'demo' : 'dev';
  const label = mode === 'demo' ? 'demo' : 'dev:setup';
  try {
    main(mode, label);
  } catch (error) {
    process.stderr.write(`\n${label}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
