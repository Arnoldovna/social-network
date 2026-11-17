import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buffer } from 'node:stream/consumers';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createS3Storage, type ObjectStorage, type S3Timeouts } from '../object-storage.js';

/**
 * The S3 adapter against a local HTTP stub that speaks just enough of the S3 REST API (path-style, like MinIO). It
 * records every request, so the tests see exactly what the SDK sends: method, path, headers and body.
 */
interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

const BUCKET = 'avatars-test';
const objects = new Map<string, { body: Buffer; contentType: string | undefined }>();
const recorded: RecordedRequest[] = [];
/** Status the stub answers `HeadBucket` with. */
let headBucketStatus = 200;
/** When true, the stub reads the request and never answers it (a stuck storage server behind a live socket). */
let hang = false;
/** How many stub requests were closed by the client before they were answered. */
let abandoned = 0;

const server: Server = createServer((req, res) => {
  void buffer(req).then((body) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = decodeURIComponent(url.pathname);
    recorded.push({ method: req.method ?? '', path, headers: req.headers, body });
    const key = path.slice(`/${BUCKET}/`.length);

    if (hang) {
      res.once('close', () => {
        if (!res.writableEnded) abandoned += 1;
      });
      return;
    }

    if (req.method === 'HEAD' && path === `/${BUCKET}/`) {
      res.writeHead(headBucketStatus).end();
    } else if (req.method === 'PUT') {
      const contentType = req.headers['content-type'];
      objects.set(key, { body, contentType });
      res.writeHead(200, { etag: '"stub-etag"' }).end();
    } else if (req.method === 'GET') {
      const object = objects.get(key);
      if (object === undefined) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
        return;
      }
      res.writeHead(200, {
        'content-type': object.contentType ?? 'application/octet-stream',
        'content-length': String(object.body.length),
      });
      res.end(object.body);
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(405).end();
    }
  });
});

let storage: ObjectStorage;

let stubUrl: string;

function storageAt(endpoint: string, timeouts?: S3Timeouts): ObjectStorage {
  return createS3Storage(
    {
      S3_ENDPOINT: endpoint,
      S3_REGION: 'eu-central-1',
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: 'stub-access-key',
      S3_SECRET_ACCESS_KEY: 'stub-secret-key',
      S3_FORCE_PATH_STYLE: true,
    },
    timeouts,
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  stubUrl = `http://127.0.0.1:${String(port)}`;
  storage = storageAt(stubUrl);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

beforeEach(() => {
  objects.clear();
  recorded.length = 0;
  headBucketStatus = 200;
  hang = false;
  abandoned = 0;
});

describe('createS3Storage (S3/MinIO adapter)', () => {
  it('B-37: put sends the bytes and content type to the server-generated key, path-style, without an ACL', async () => {
    const bytes = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 1, 2, 3);

    await storage.put('avatars/7/0b8e2a4c.webp', bytes, 'image/webp');

    const [put] = recorded;
    expect(put?.method).toBe('PUT');
    expect(put?.path).toBe(`/${BUCKET}/avatars/7/0b8e2a4c.webp`);
    expect(put?.headers['content-type']).toBe('image/webp');
    expect(put?.headers['x-amz-acl']).toBeUndefined(); // the bucket stays private
    expect(put?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=stub-access-key\//);
    expect(new Uint8Array(put?.body ?? [])).toEqual(bytes);
  });

  it('get streams the stored bytes back with their content type', async () => {
    const bytes = Uint8Array.of(9, 8, 7, 6);
    await storage.put('avatars/7/a.webp', bytes, 'image/webp');

    const object = await storage.get('avatars/7/a.webp');

    expect(object.contentType).toBe('image/webp');
    expect(new Uint8Array(await buffer(object.body))).toEqual(bytes);
  });

  it('get rejects for a missing key (the avatar route maps that to 404)', async () => {
    await expect(storage.get('avatars/7/missing.webp')).rejects.toMatchObject({ name: 'NoSuchKey' });
  });

  it('delete removes the object', async () => {
    await storage.put('avatars/7/old.webp', Uint8Array.of(1), 'image/webp');

    await storage.delete('avatars/7/old.webp');

    expect(recorded.at(-1)).toMatchObject({ method: 'DELETE', path: `/${BUCKET}/avatars/7/old.webp` });
    expect(objects.has('avatars/7/old.webp')).toBe(false);
  });

  it('F-114: isReady is true when the bucket answers HeadBucket', async () => {
    await expect(storage.isReady()).resolves.toBe(true);
    expect(recorded.at(-1)).toMatchObject({ method: 'HEAD', path: `/${BUCKET}/` });
  });

  it('F-114: isReady is false, never a rejection, when the bucket is missing or access is denied', async () => {
    headBucketStatus = 404;
    await expect(storage.isReady()).resolves.toBe(false);

    headBucketStatus = 403;
    await expect(storage.isReady()).resolves.toBe(false);
  });

  it('F-114: isReady is false when the storage server is unreachable', async () => {
    // Port 1 (tcpmux) is closed on any test machine: every attempt is refused at once.
    await expect(storageAt('http://127.0.0.1:1').isReady()).resolves.toBe(false);
  });

  it('F-114: isReady cancels its HeadBucket when the readiness probe aborts, instead of leaving it hanging', async () => {
    hang = true;
    const probe = new AbortController();

    const ready = storage.isReady(probe.signal);
    await vi.waitFor(() => {
      expect(recorded).toHaveLength(1);
    });
    probe.abort();

    await expect(ready).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(abandoned).toBe(1);
    });
  });

  it('fails a request whose socket stays idle instead of waiting forever (no SDK default timeout)', async () => {
    hang = true;
    const impatient = storageAt(stubUrl, { connectionTimeoutMs: 1_000, socketTimeoutMs: 100 });

    await expect(impatient.get('avatars/7/a.webp')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
