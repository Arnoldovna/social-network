// Text-level guards for the compose files (no YAML dependency: root scripts use Node built-ins only).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const BASE = readFileSync(resolve(import.meta.dirname, '../../docker-compose.yml'), 'utf8');
const E2E = readFileSync(resolve(import.meta.dirname, '../../docker-compose.e2e.yml'), 'utf8');

/**
 * The body of each service below `services:` (two-space indented keys), keyed by service name.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
function services(text) {
  const result = new Map();
  const body = text.slice(text.indexOf('\nservices:\n'));
  const pattern = /^ {2}([a-z0-9-]+):\n((?:(?: {4}.*)?\n)*)/gm;
  for (const match of body.matchAll(pattern)) result.set(match[1], match[2]);
  return result;
}

describe('docker-compose.yml', () => {
  const byName = services(BASE);

  it('B-133: pins every pulled image by digest; the only other image is the locally built API image', () => {
    const images = [...BASE.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    const local = images.filter((image) => image === '${COMPOSE_PROJECT_NAME}-api');
    const pulled = images.filter((image) => image !== '${COMPOSE_PROJECT_NAME}-api');
    expect(local).toHaveLength(1);
    expect(pulled).toHaveLength(4);
    for (const image of pulled) expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('builds the API image once and runs migrate, seed and api from it', () => {
    expect(BASE.match(/dockerfile: apps\/api\/Dockerfile/g)).toHaveLength(1);
    for (const name of ['migrate', 'seed', 'api']) expect(byName.get(name), name).toContain('<<: *api-image');
  });

  it('B-07: allow-lists the published web port and binds every port to 127.0.0.1', () => {
    expect(BASE).toContain('CORS_ORIGINS: http://127.0.0.1:${WEB_PORT:-8080},http://localhost:${WEB_PORT:-8080}');
    const ports = [...BASE.matchAll(/^\s*ports: \[(.*)\]$/gm)].flatMap((match) =>
      (match[1] ?? '').split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')),
    );
    expect(ports).toHaveLength(5); // postgres, redis, minio API + console, web
    for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('B-63: seeds through a one-shot seed service guarded by SEED_ALLOW, before the api starts', () => {
    const seed = byName.get('seed') ?? '';
    expect(seed).toContain('profiles: [app]');
    expect(seed).toContain("command: ['dist/db/seed/cli.js']");
    expect(seed).toContain("SEED_ALLOW: 'true'");
    expect(seed).toContain('SEED_DEMO_PASSWORD: ${SEED_DEMO_PASSWORD:?run pnpm setup:env}');
    expect(seed).not.toContain('NODE_ENV');
    expect(byName.get('api')).toContain('seed: { condition: service_completed_successfully }');
  });

  it('B-01: passes SEED_DEMO_PASSWORD to the seed service only', () => {
    expect(BASE.match(/^\s+SEED_DEMO_PASSWORD:/gm)).toHaveLength(1);
    expect(byName.get('api')).not.toContain('SEED_');
  });

  it('B-139: caps the api memory and bounds Redis memory with TTL eviction', () => {
    expect(byName.get('api')).toContain('mem_limit: 768m');
    const redis = byName.get('redis') ?? '';
    expect(redis).toMatch(/--maxmemory\n\s+- 128mb/);
    expect(redis).toMatch(/--maxmemory-policy\n\s+- volatile-ttl/);
  });
});

describe('docker-compose.e2e.yml', () => {
  const byName = services(E2E);

  it('B-139: publishes no infra ports and keeps the data on tmpfs', () => {
    for (const name of ['postgres', 'redis', 'minio']) expect(byName.get(name), name).toContain('ports: !reset []');
    expect(byName.get('postgres')).toContain("tmpfs: ['/var/lib/postgresql']");
    expect(byName.get('minio')).toContain("tmpfs: ['/data']");
    for (const name of ['postgres', 'minio']) expect(byName.get(name), name).toContain('volumes: !reset []');
  });

  it('B-07: replaces the web port with E2E_PORT and allow-lists the same origin', () => {
    expect(byName.get('web')).toContain("ports: !override ['127.0.0.1:${E2E_PORT:-8183}:8080']");
    expect(byName.get('api')).toContain(
      'CORS_ORIGINS: http://127.0.0.1:${E2E_PORT:-8183},http://localhost:${E2E_PORT:-8183}',
    );
    expect(byName.get('api')).toContain("RATE_LIMIT_MULTIPLIER: '100'");
  });
});
