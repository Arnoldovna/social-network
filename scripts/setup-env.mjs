// `pnpm setup:env`: create or complete .env from .env.example (conventions §5, ADR-0017, ADR-0019 §7).
//
// - .env missing: copy .env.example and fill every empty secret.
// - .env present: keep every line and value; append keys that exist only in .env.example (with their comment block)
//   and fill secrets that are still empty. A value is never overwritten: a new SESSION_SECRET would sign everybody
//   out, a new S3_SECRET_ACCESS_KEY (also the MinIO root password) would lock out the existing MinIO volume.
// - The secrets are exactly SESSION_SECRET, CSRF_SECRET, S3_SECRET_ACCESS_KEY and SEED_DEMO_PASSWORD, each filled
//   with crypto.randomBytes(32).toString('base64url'). POSTGRES_PASSWORD is the fixed local value `local-only` and is
//   never generated, because DATABASE_URL carries it literally (ADR-0019 §7).
// - Values are read with Node's own dotenv parser (node:util parseEnv, the one behind `--env-file`), so setup:env sees
//   exactly what the API, db:migrate and db:seed see. docker compose reads .env too and disagrees on one point: an
//   unquoted value with a `#` that is not preceded by whitespace (`KEY=#todo`, `KEY=a#b`). Node ends the value at
//   that `#`, compose keeps it. setup:env refuses such a line (key names only) instead of letting the two drift.
// - Prints key names only, plus the demo login (the one secret conventions §5 allows to print). Writes .env with mode
//   600 and only when something changed, so a second run leaves the file byte-identical (CI dev-setup-smoke).
//   Node built-ins only.
//
// Usage: node scripts/setup-env.mjs
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv as parseDotenv } from 'node:util';

/** The seeded demo account (DATA-MODEL.md, seed). */
export const DEMO_EMAIL = 'mira.novak@example.com';

/** Exactly the keys `setup:env` generates when they are empty (OVERVIEW §13). */
export const SECRET_KEYS = Object.freeze([
  'SESSION_SECRET',
  'CSRF_SECRET',
  'S3_SECRET_ACCESS_KEY',
  'SEED_DEMO_PASSWORD',
]);

const SECRET_KEY_SET = new Set(SECRET_KEYS);
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** @param {string} key */
export function isSecretKey(key) {
  return SECRET_KEY_SET.has(key);
}

/** 32 random bytes as base64url: 43 characters, safe in .env, URLs and compose interpolation. */
export function generateSecret() {
  return randomBytes(32).toString('base64url');
}

/**
 * Parses dotenv text into a map, line by line, with Node's parser: comments and blank lines are skipped, quotes are
 * removed, and an unquoted value ends at its first `#`. Multi-line values are not supported (the project has none).
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnv(text) {
  const values = new Map();
  for (const line of splitLines(text)) {
    const entry = parseLine(line);
    if (entry) values.set(entry.key, entry.value);
  }
  return values;
}

/**
 * Pure core of `setup:env`.
 *
 * @param {object} input
 * @param {string | null} input.current   the existing .env text, or null when there is none
 * @param {string} input.example          the .env.example text
 * @param {() => string} [input.generate] secret generator (injected by tests)
 * @returns {{ text: string, created: boolean, added: string[], generated: string[], ambiguous: string[] }}
 *   `ambiguous`: keys whose value Node and docker compose would read differently (see the file comment)
 */
export function mergeEnv({ current, example, generate = generateSecret }) {
  const created = current === null;
  const lines = splitLines(current ?? example);
  const present = new Set(lines.flatMap((line) => parseLine(line)?.key ?? []));

  /** @type {string[]} */
  const added = [];
  if (!created) {
    const exampleLines = splitLines(example);
    exampleLines.forEach((line, index) => {
      const entry = parseLine(line);
      if (!entry || present.has(entry.key)) return;
      const comment = commentBlockAbove(exampleLines, index);
      // A documented key starts a new paragraph; keys that share one comment in the example stay together.
      if (comment.length > 0 && lines.length > 0 && lines.at(-1) !== '') lines.push('');
      lines.push(...comment, line);
      present.add(entry.key);
      added.push(entry.key);
    });
  }

  /** @type {string[]} */
  const generated = [];
  const filled = lines.map((line) => {
    const entry = parseLine(line);
    if (!entry || entry.value !== '' || !isSecretKey(entry.key)) return line;
    generated.push(entry.key);
    return `${entry.key}=${generate()}`;
  });

  const ambiguous = filled.flatMap((line) => {
    const entry = parseLine(line);
    return entry && hasAmbiguousHash(entry.raw) ? [entry.key] : [];
  });

  return { text: joinLines(filled), created, added, generated, ambiguous };
}

/**
 * Creates or completes `<cwd>/.env` and reports what changed (key names only) and the demo login.
 *
 * @param {{ cwd?: string, log?: (message: string) => void }} [options]
 */
export function setupEnv({ cwd = process.cwd(), log = (message) => process.stdout.write(`${message}\n`) } = {}) {
  const examplePath = resolve(cwd, '.env.example');
  const envPath = resolve(cwd, '.env');
  if (!existsSync(examplePath)) throw new Error(`.env.example not found in ${cwd}`);

  const example = readFileSync(examplePath, 'utf8');
  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null;
  const result = mergeEnv({ current, example });
  if (result.ambiguous.length > 0) {
    throw new Error(
      `.env: the unquoted value of ${result.ambiguous.join(', ')} contains a '#' that Node reads as a comment and ` +
        "docker compose does not. Quote the value ('...') or put the comment on its own line. Nothing was changed.",
    );
  }

  if (result.text !== current) writeAtomically(envPath, result.text);
  else chmodSync(envPath, 0o600); // keep the secrets private even when nothing changed

  if (result.created) log('setup:env: created .env from .env.example');
  if (result.added.length > 0) log(`setup:env: added ${result.added.join(', ')}`);
  if (result.generated.length > 0) log(`setup:env: generated ${result.generated.join(', ')}`);
  if (!result.created && result.added.length === 0 && result.generated.length === 0) {
    log('setup:env: .env is complete, nothing changed');
  }

  const password = parseEnv(result.text).get('SEED_DEMO_PASSWORD');
  if (password) log(`setup:env: demo login ${DEMO_EMAIL} / ${password}`);
  return result;
}

/**
 * @param {string} line
 * @returns {{ key: string, value: string, raw: string } | null} `raw` is everything after the `=`
 */
function parseLine(line) {
  if (/^\s*#/.test(line)) return null;
  const match = ENV_LINE.exec(line);
  if (!match) return null;
  const [, key = '', raw = ''] = match;
  return { key, value: parseDotenv(line)[key] ?? '', raw };
}

/**
 * True when an unquoted value contains a `#` without whitespace before it: Node's parser (`--env-file`) ends the value
 * there, docker compose keeps the `#` and everything after it (`KEY= #todo` gives '' and '#todo').
 *
 * @param {string} raw everything after the `=`
 */
function hasAmbiguousHash(raw) {
  const value = raw.trim();
  if (/^["'`]/.test(value)) return false;
  const hash = value.indexOf('#');
  return hash === 0 || (hash > 0 && !/\s/.test(value.charAt(hash - 1)));
}

/**
 * The contiguous comment lines directly above `index` (the key's documentation in .env.example).
 *
 * @param {string[]} lines
 * @param {number} index
 */
function commentBlockAbove(lines, index) {
  let start = index;
  while (start > 0 && /^\s*#/.test(lines[start - 1] ?? '')) start -= 1;
  return lines.slice(start, index);
}

/** @param {string} text */
function splitLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** @param {string[]} lines */
function joinLines(lines) {
  return `${lines.join('\n')}\n`;
}

/**
 * Writes through a temporary file and a rename, so an interrupted run never leaves a half-written .env.
 *
 * @param {string} path
 * @param {string} text
 */
function writeAtomically(path, text) {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600); // the umask may have narrowed the mode
  renameSync(temporary, path);
}

if (import.meta.main) {
  try {
    setupEnv({ cwd: resolve(import.meta.dirname, '..') });
  } catch (error) {
    process.stderr.write(`setup:env: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
