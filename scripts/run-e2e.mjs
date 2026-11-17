// `pnpm test:e2e`, `pnpm e2e:up`, `pnpm e2e:down` (conventions §6, ADR-0016, ADR-0017, ADR-0019 §6).
//
// Playwright against the production images in the isolated compose project `social-network-e2e`. It never touches
// the dev project `social-network`, its volumes or its ports, so it can run next to `pnpm dev` and `pnpm demo`.
//
//   pnpm test:e2e [--keep] [playwright args]
//     1. stop with "run `pnpm setup:env`" when .env is missing (the stack needs its secrets)
//     2. resolve E2E_PORT once (process environment, else .env, else 8183) and pass the same value to compose
//        (published port and CORS_ORIGINS in docker-compose.e2e.yml) and to E2E_BASE_URL, so they can never split
//     3. `down -v --remove-orphans` (leftovers of a killed run), then `up -d --build --wait`
//     4. `playwright test` with the passed arguments and E2E_BASE_URL=http://127.0.0.1:<port>
//     5. on any failure test-results/compose.log; always `down -v --remove-orphans` unless --keep
//   pnpm e2e:up      steps 1 to 3, then prints E2E_BASE_URL=... (phase-5 orchestrator)
//   pnpm e2e:down    `down -v --remove-orphans` only
//
// Node built-ins only.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnv } from './setup-env.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const E2E_PROJECT = 'social-network-e2e';
/** Fixed per project so the three e2e stacks can coexist: imageboard 8181, petition 8182, social-network 8183. */
export const DEFAULT_E2E_PORT = 8183;
const COMPOSE_LOG = 'test-results/compose.log';

/**
 * Splits the script's own flags from the arguments passed through to Playwright.
 *
 * @param {string[]} argv
 * @returns {{ mode: 'test' | 'up' | 'down', keep: boolean, playwrightArgs: string[] }}
 */
export function parseArgs(argv) {
  const own = new Set(['--up', '--down', '--keep']);
  const up = argv.includes('--up');
  const down = argv.includes('--down');
  if (up && down) throw new Error('use either --up or --down, not both');
  return {
    mode: up ? 'up' : down ? 'down' : 'test',
    keep: argv.includes('--keep'),
    playwrightArgs: argv.filter((arg) => !own.has(arg)),
  };
}

/**
 * Resolves the e2e host port once: process environment, else .env, else 8183 (OVERVIEW §13).
 *
 * @param {Readonly<Record<string, string | undefined>>} processEnv
 * @param {Map<string, string>} dotenv
 * @returns {number}
 */
export function resolveE2ePort(processEnv, dotenv) {
  const fromEnv = processEnv['E2E_PORT']?.trim();
  const fromDotenv = dotenv.get('E2E_PORT')?.trim();
  const raw = fromEnv || fromDotenv || String(DEFAULT_E2E_PORT);
  const source = fromEnv ? 'the environment' : fromDotenv ? '.env' : 'the default';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65_535) {
    throw new Error(`E2E_PORT from ${source} must be an integer between 1 and 65535, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * The docker compose arguments every step shares: own project, both files, profile `app`.
 *
 * @param {...string} rest
 */
export function composeArgs(...rest) {
  return [
    'compose',
    '-p',
    E2E_PROJECT,
    '-f',
    'docker-compose.yml',
    '-f',
    'docker-compose.e2e.yml',
    '--profile',
    'app',
    ...rest,
  ];
}

let interrupted = false;

/**
 * Runs a command from the repository root; resolves with its exit code (a signal counts as failure).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ stdout?: NodeJS.WritableStream }} [options] pipe stdout there instead of inheriting it
 * @returns {Promise<number>}
 */
function run(command, args, env, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: options.stdout ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (options.stdout) {
      child.stdout?.pipe(options.stdout, { end: false });
      child.stderr?.pipe(options.stdout, { end: false });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise(code ?? 1);
    });
  });
}

/**
 * One `docker compose` step of the e2e project; throws when it fails.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {...string} rest
 */
async function compose(env, ...rest) {
  const step = `docker compose -p ${E2E_PROJECT} ${rest.join(' ')}`;
  process.stdout.write(`\n> ${step}\n`);
  const code = await run('docker', composeArgs(...rest), env);
  if (code !== 0) throw new Error(`${step} failed with exit code ${String(code)}`);
}

/** @param {NodeJS.ProcessEnv} env */
function tearDown(env) {
  return compose(env, 'down', '-v', '--remove-orphans');
}

/** @param {NodeJS.ProcessEnv} env */
async function writeComposeLog(env) {
  mkdirSync(resolve(ROOT, 'test-results'), { recursive: true });
  const file = createWriteStream(resolve(ROOT, COMPOSE_LOG));
  await run('docker', composeArgs('logs', '--no-color', '--timestamps'), env, { stdout: file });
  await new Promise((resolvePromise) => {
    file.end(resolvePromise);
  });
  process.stderr.write(`run-e2e: compose logs written to ${COMPOSE_LOG}\n`);
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
async function main(argv) {
  const { mode, keep, playwrightArgs } = parseArgs(argv);
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error('.env is missing: run `pnpm setup:env` first (the stack needs its secrets).');
  }
  const port = resolveE2ePort(process.env, parseEnv(readFileSync(envPath, 'utf8')));
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const env = { ...process.env, E2E_PORT: String(port), E2E_BASE_URL: baseUrl };

  if (mode === 'down') {
    await tearDown(env);
    return 0;
  }

  let failed = true;
  try {
    await tearDown(env);
    await compose(env, 'up', '-d', '--build', '--wait');
    if (mode === 'up') {
      failed = false;
      process.stdout.write(`\nE2E_BASE_URL=${baseUrl}\n`);
      return 0;
    }

    process.stdout.write(`\n> playwright test (E2E_BASE_URL=${baseUrl})\n`);
    const code = await run('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs], env);
    if (interrupted) return 130;
    failed = code !== 0;
    return code;
  } finally {
    if (failed || interrupted) await writeComposeLog(env).catch(() => undefined);
    if (keep && mode === 'test') {
      process.stdout.write(
        `\nrun-e2e: --keep, ${E2E_PROJECT} stays up at ${baseUrl}. Remove it with \`pnpm e2e:down\`.\n`,
      );
    } else if (mode === 'test' || failed) {
      await tearDown(env);
    }
  }
}

if (import.meta.main) {
  // Ctrl+C reaches the children through the process group; finish the teardown instead of dying half-way.
  // A second Ctrl+C aborts at once (the stack may then need `pnpm e2e:down`).
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
  });
  process.on('SIGTERM', () => {
    interrupted = true;
  });
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`\nrun-e2e: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
