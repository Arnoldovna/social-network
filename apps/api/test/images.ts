import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `name:tag@sha256:<64 hex>`: every image is pinned by digest (conventions §9). */
const PINNED_IMAGE = /^[\w./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/;

export interface ComposeImages {
  postgres: string;
  redis: string;
}

/**
 * The image of one top-level compose service: the first `image:` line inside the `<service>:` block (a two-space
 * indented key under `services:`). A small line scanner instead of a YAML dependency; docker-compose.yml keeps this
 * shape (one `image:` per service, four-space indentation).
 */
export function serviceImage(compose: string, service: string): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) throw new Error(`docker-compose.yml has no service "${service}"`);
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}[^\s#]/.test(line)) break; // next service or next top-level key (comments do not end a block)
    const image = /^ {4}image:\s*(\S+)\s*$/.exec(line)?.[1];
    if (image !== undefined) {
      if (!PINNED_IMAGE.test(image)) {
        throw new Error(`docker-compose.yml: the ${service} image is not pinned by digest (name:tag@sha256:…)`);
      }
      return image;
    }
  }
  throw new Error(`docker-compose.yml: service "${service}" has no image`);
}

/**
 * The postgres and redis image references Testcontainers starts, read from docker-compose.yml (ADR-0019 §4). One
 * source: a Dependabot docker-compose bump reaches the integration tests too. Fails fast when the file, a service or
 * a digest pin is missing.
 */
export function composeImages(
  composeFile = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)),
): ComposeImages {
  const compose = readFileSync(composeFile, 'utf8');
  return { postgres: serviceImage(compose, 'postgres'), redis: serviceImage(compose, 'redis') };
}
