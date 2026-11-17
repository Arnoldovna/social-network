import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

import type { Env } from '../../config/env.js';

/** Port used by services. Tests pass an in-memory fake; production passes the S3 adapter. */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Readable; contentType: string | undefined }>;
  delete(key: string): Promise<void>;
  /**
   * Readiness (`HeadBucket`): true when the bucket answers, false otherwise, never a rejection. `signal` cancels the
   * request when the readiness probe gives up, so a hanging storage server cannot pile up probe requests.
   */
  isReady(signal?: AbortSignal): Promise<boolean>;
}

type S3Env = Pick<
  Env,
  'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'
>;

/**
 * The SDK's Node handler has no timeouts by default: a storage server that accepts connections but never answers (a
 * network partition, a stuck MinIO) would hang every avatar request and readiness probe for good and exhaust the
 * handler's socket pool. A connection must be established within `connectionTimeout`; an established request fails
 * once its socket was idle for `socketTimeout` (an idle timeout, so streaming a large object is not cut off).
 */
export const S3_CONNECTION_TIMEOUT_MS = 3_000;
export const S3_SOCKET_TIMEOUT_MS = 10_000;

/** Overridable for the adapter's own tests; the composition root uses the defaults above. */
export interface S3Timeouts {
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export function createS3Storage(
  env: S3Env,
  { connectionTimeoutMs = S3_CONNECTION_TIMEOUT_MS, socketTimeoutMs = S3_SOCKET_TIMEOUT_MS }: S3Timeouts = {},
): ObjectStorage & { client: S3Client } {
  const client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE, // MinIO needs path-style URLs
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    // Only send/require checksums when the operation demands it; keeps S3-compatible servers working.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: connectionTimeoutMs, socketTimeout: socketTimeoutMs },
  });
  const Bucket = env.S3_BUCKET;

  return {
    client,
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return { body: out.Body as Readable, contentType: out.ContentType };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async isReady(signal) {
      try {
        await client.send(new HeadBucketCommand({ Bucket }), signal ? { abortSignal: signal } : {});
        return true;
      } catch {
        return false;
      }
    },
  };
}
