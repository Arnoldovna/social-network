import fs from 'node:fs';
import type { Readable } from 'node:stream';

import { AVATAR_FIELD, MeResponse, PROBLEM_TYPE_PREFIX, Problem, type ProblemCode } from '@app/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { insertUser } from '../../../../test/db.js';
import { csrf, signIn, type TestAgent } from '../../../../test/http.js';
import { createTestApp, TEST_RATE_LIMIT_MULTIPLIER, type TestApp } from '../../../../test/test-app.js';
import { resolveLimits } from '../../../config/limits.js';
import { users } from '../../../db/schema/index.js';
import { newAvatarKey, parseAvatarKey } from '../../../shared/media/media-url.js';
import { AVATAR_CONTENT_TYPE, AVATAR_SIZE_PX } from '../../../shared/uploads/process-image.js';
import { IMMUTABLE_CACHE_CONTROL, REVALIDATE_CACHE_CONTROL } from '../avatars.controller.js';
import {
  avatarKeyPattern,
  avatarUrlPattern,
  EXIF_MARKER,
  gifImage,
  headerOnlyPng,
  htmlDisguisedAsPng,
  jpegImage,
  jpegWithExif,
  oversizedFile,
  pngImage,
  webpImage,
} from './fixtures.js';

const UPLOAD_PATH = '/api/me/avatar';
const avatarPath = (userId: number | string) => `/api/users/${String(userId)}/avatar`;

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});
afterAll(async () => {
  await testApp.close();
});

// --- helpers --------------------------------------------------------------------------------------------------------

async function signedInUser(fields: Parameters<typeof insertUser>[1] = {}) {
  const user = await insertUser(testApp.db, fields);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { user, agent };
}

function put(agent: TestAgent, file: Buffer, filename = 'avatar.png', contentType = 'image/png') {
  return agent.put(UPLOAD_PATH).attach(AVATAR_FIELD, file, { filename, contentType });
}

async function storedKeyOf(userId: number): Promise<string | null> {
  const [row] = await testApp.db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, userId));
  if (!row) throw new Error(`no user ${String(userId)}`);
  return row.avatarKey;
}

/** The keys this user's uploads left in the (file-wide) fake storage. */
const objectKeysOf = (userId: number): string[] =>
  [...testApp.storage.objects.keys()].filter((key) => key.startsWith(`avatars/${String(userId)}/`));

function storedObject(key: string) {
  const object = testApp.storage.objects.get(key);
  if (!object) throw new Error(`no stored object ${key}`);
  return object;
}

/** Puts an object for the user's current (test-made) key, as a finished earlier upload would have. */
function storeObjectFor(key: string | null, bytes: Buffer = Buffer.from('earlier avatar')): string {
  if (!key) throw new Error('the user has no avatar key');
  testApp.storage.objects.set(key, { body: Uint8Array.from(bytes), contentType: AVATAR_CONTENT_TYPE });
  return key;
}

function expectProblem(response: Response, status: number, code: ProblemCode): Problem {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = Problem.parse(response.body);
  expect(problem.type).toBe(`${PROBLEM_TYPE_PREFIX}${code}`);
  expect(problem.status).toBe(status);
  return problem;
}

const binary = (agent: TestAgent, path: string) => agent.get(path).responseType('blob');

// --- PUT /api/me/avatar -------------------------------------------------------------------------------------------

describe('PUT /api/me/avatar', () => {
  it('F-36, B-62: stores a re-encoded 512 px WebP under a server key and answers MeResponse with avatarUrl', async () => {
    const { user, agent } = await signedInUser({ bio: 'Painter' });

    const response = await put(agent, await jpegImage(), 'photo.jpg', 'image/jpeg').expect(200);

    const { user: me } = MeResponse.parse(response.body); // strict at every level: no email, no key (B-19)
    expect(me).toMatchObject({ id: user.id, firstName: user.firstName, lastName: user.lastName, bio: 'Painter' });
    expect(me.avatarUrl).toMatch(avatarUrlPattern(user.id));

    // B-05: the database stores the key, never a URL; the URL is built from it at read time.
    const key = await storedKeyOf(user.id);
    expect(key).toMatch(avatarKeyPattern(user.id));
    expect(me.avatarUrl).toBe(`${avatarPath(user.id)}?v=${parseAvatarKey(key ?? '')?.version ?? ''}`);

    const object = storedObject(key ?? '');
    expect(object.contentType).toBe(AVATAR_CONTENT_TYPE);
    const metadata = await sharp(Buffer.from(object.body)).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: AVATAR_SIZE_PX, height: AVATAR_SIZE_PX });
  });

  it.each([
    ['PNG', pngImage, 'image/png'],
    ['WebP', webpImage, 'image/webp'],
    ['GIF', gifImage, 'image/gif'],
  ] as const)('F-36: accepts a %s image', async (_format, image, contentType) => {
    const { user, agent } = await signedInUser();
    const response = await put(agent, await image(), 'upload', contentType).expect(200);
    expect(MeResponse.parse(response.body).user.avatarUrl).toMatch(avatarUrlPattern(user.id));
    expect(objectKeysOf(user.id)).toHaveLength(1);
  });

  it('B-30: ignores the client filename and type and strips EXIF metadata', async () => {
    const { user, agent } = await signedInUser();

    await put(agent, await jpegWithExif(), '../../evil.html', 'text/html').expect(200);

    const [key] = objectKeysOf(user.id);
    expect(key).toMatch(avatarKeyPattern(user.id));
    const object = storedObject(key ?? '');
    expect(object.contentType).toBe(AVATAR_CONTENT_TYPE);
    const metadata = await sharp(Buffer.from(object.body)).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(Buffer.from(object.body).includes(EXIF_MARKER)).toBe(false);
  });

  it('B-31: the upload is parsed in memory and never needs an upload directory or a temp file', async () => {
    const { user, agent } = await signedInUser();
    // Every way multer's disk storage (or a hand-made temp file) would touch the file system.
    const fileSystemWrites = [
      vi.spyOn(fs, 'createWriteStream'),
      vi.spyOn(fs, 'mkdir'),
      vi.spyOn(fs, 'mkdirSync'),
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs.promises, 'mkdir'),
      vi.spyOn(fs.promises, 'writeFile'),
    ];
    try {
      await put(agent, await pngImage()).expect(200);
      for (const write of fileSystemWrites) expect(write).not.toHaveBeenCalled();
    } finally {
      for (const write of fileSystemWrites) write.mockRestore();
    }
    expect(objectKeysOf(user.id)).toHaveLength(1);
  });

  it('B-29: HTML disguised as a PNG is 415 unsupported-media-type and stores nothing', async () => {
    const { user, agent } = await signedInUser();

    const response = await put(agent, htmlDisguisedAsPng(), 'x.png', 'image/png');

    expectProblem(response, 415, 'unsupported-media-type');
    expect(objectKeysOf(user.id)).toEqual([]);
    expect(await storedKeyOf(user.id)).toBeNull();
  });

  it('B-32: a 3 MB file is 413 file-too-large problem+json, not an HTML 500', async () => {
    const { user, agent } = await signedInUser();

    const response = await put(agent, oversizedFile());

    expectProblem(response, 413, 'file-too-large');
    expect(objectKeysOf(user.id)).toEqual([]);
  });

  it('B-33: a request without a file is 400 file-required', async () => {
    const { agent } = await signedInUser();
    expectProblem(await agent.put(UPLOAD_PATH), 400, 'file-required');
    expectProblem(await agent.put(UPLOAD_PATH).field('note', 'no file here'), 400, 'invalid-request');
  });

  it('F-36: an empty file is 400 file-required', async () => {
    const { agent } = await signedInUser();
    expectProblem(await put(agent, Buffer.alloc(0)), 400, 'file-required');
  });

  it('F-36: a second file, another field or a file under another name is 400 invalid-request', async () => {
    const { user, agent } = await signedInUser();
    const png = await pngImage();

    const twoFiles = await agent
      .put(UPLOAD_PATH)
      .attach(AVATAR_FIELD, png, { filename: 'a.png', contentType: 'image/png' })
      .attach(AVATAR_FIELD, png, { filename: 'b.png', contentType: 'image/png' });
    expectProblem(twoFiles, 400, 'invalid-request');

    const extraField = await agent
      .put(UPLOAD_PATH)
      .field('userId', '1')
      .attach(AVATAR_FIELD, png, { filename: 'a.png', contentType: 'image/png' });
    expectProblem(extraField, 400, 'invalid-request');

    const otherName = await agent.put(UPLOAD_PATH).attach('file', png, { filename: 'a.png', contentType: 'image/png' });
    expectProblem(otherName, 400, 'invalid-request');

    expect(objectKeysOf(user.id)).toEqual([]);
  });

  it('F-36: a PNG header declaring 16000 × 16000 px is 422 validation-failed on the file, without decoding', async () => {
    const { user, agent } = await signedInUser();

    const problem = expectProblem(await put(agent, headerOnlyPng()), 422, 'validation-failed');

    expect(problem.errors).toEqual([
      { location: 'file', path: AVATAR_FIELD, message: 'The image must be at most 8192 × 8192 pixels.' },
    ]);
    expect(objectKeysOf(user.id)).toEqual([]);
  });

  it('B-35: a visitor is 401 before anything is parsed or stored', async () => {
    const agent = request.agent(testApp.app);
    await csrf(agent); // a valid token for the anonymous session, so only the missing login can fail
    const objectsBefore = testApp.storage.objects.size;

    expectProblem(await put(agent, await pngImage()), 401, 'unauthorized');

    expect(testApp.storage.objects.size).toBe(objectsBefore);
  });

  it('F-23: a signed-in upload without the CSRF header is 403 csrf-invalid', async () => {
    const { user, agent } = await signedInUser();

    const response = await put(agent, await pngImage()).unset('x-csrf-token');

    expectProblem(response, 403, 'csrf-invalid');
    expect(objectKeysOf(user.id)).toEqual([]);
  });

  it('only changes the signed-in user’s own avatar; there is no way to address another user', async () => {
    const other = await insertUser(testApp.db, { avatar: true });
    const othersKey = storeObjectFor(other.avatarKey);
    const { agent } = await signedInUser();

    await put(agent, await pngImage()).expect(200);
    // The upload route takes no user id; ids in the query or a body field change nothing.
    await agent
      .put(`${UPLOAD_PATH}?userId=${String(other.id)}`)
      .attach(AVATAR_FIELD, await pngImage(), { filename: 'a.png', contentType: 'image/png' })
      .expect(200);

    expect(await storedKeyOf(other.id)).toBe(othersKey);
    expect(objectKeysOf(other.id)).toEqual([othersKey]);
    expectProblem(await agent.put(avatarPath(other.id)), 404, 'not-found');
  });

  it('F-39, B-36, F-37: deletes the replaced object, and the old avatarUrl still returns the current image', async () => {
    const { user, agent } = await signedInUser();
    const first = MeResponse.parse((await put(agent, await pngImage()).expect(200)).body).user;
    const firstKey = await storedKeyOf(user.id);

    const second = MeResponse.parse((await put(agent, await jpegImage(), 'b.jpg', 'image/jpeg').expect(200)).body).user;
    const secondKey = await storedKeyOf(user.id);

    expect(secondKey).not.toBe(firstKey);
    expect(second.avatarUrl).not.toBe(first.avatarUrl);
    expect(objectKeysOf(user.id)).toEqual([secondKey]); // the first object is gone (F-39)

    // Every cache that still holds the first URL gets the current image, never a 404 (F-37, ADR-0010 §8).
    const viaOldUrl = await binary(agent, first.avatarUrl ?? '').expect(200);
    expect(viaOldUrl.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
    expect(Buffer.from(viaOldUrl.body as Buffer)).toEqual(Buffer.from(storedObject(secondKey ?? '').body));
  });

  it('F-39: concurrent uploads of one user leave exactly the winning object (atomic RETURNING OLD swap)', async () => {
    const { user, agent } = await signedInUser({ avatar: true });
    storeObjectFor(user.avatarKey);
    const [a, b, c] = await Promise.all([pngImage(), jpegImage(), webpImage()]);

    const responses = await Promise.all([put(agent, a), put(agent, b), put(agent, c)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const finalKey = await storedKeyOf(user.id);
    expect(objectKeysOf(user.id)).toEqual([finalKey]); // no orphan, nothing deleted twice
  });

  it('B-34: a storage failure is a 500 problem, leaves the database unchanged and the API keeps serving', async () => {
    const { user, agent } = await signedInUser({ avatar: true });
    const oldKey = storeObjectFor(user.avatarKey);
    testApp.storage.fail('put');
    try {
      const response = await put(agent, await pngImage());
      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(Problem.parse(response.body)).toMatchObject({
        type: 'about:blank',
        detail: 'An unexpected error occurred.',
      });
    } finally {
      testApp.storage.recover('put');
    }

    expect(await storedKeyOf(user.id)).toBe(oldKey);
    expect(objectKeysOf(user.id)).toEqual([oldKey]);
    await put(agent, await pngImage()).expect(200); // the process is alive and the next upload works
  });

  it('F-39: a failed delete of the replaced object still answers 200 with the new avatar', async () => {
    const { user, agent } = await signedInUser({ avatar: true });
    const oldKey = storeObjectFor(user.avatarKey);
    testApp.storage.fail('delete');
    try {
      const response = await put(agent, await pngImage()).expect(200);
      expect(MeResponse.parse(response.body).user.avatarUrl).toMatch(avatarUrlPattern(user.id));
    } finally {
      testApp.storage.recover('delete');
    }
    expect(await storedKeyOf(user.id)).not.toBe(oldKey);
  });
});

// --- GET /api/users/:id/avatar --------------------------------------------------------------------------------------

describe('GET /api/users/:id/avatar', () => {
  async function userWithStoredAvatar() {
    const owner = await insertUser(testApp.db, { avatar: true });
    const key = storeObjectFor(owner.avatarKey, Buffer.from('the current webp bytes'));
    const version = parseAvatarKey(key)?.version ?? '';
    return { owner, key, version };
  }

  it('F-37, B-30: streams the current object with inline disposition, nosniff, ETag and immutable caching', async () => {
    const { owner, version } = await userWithStoredAvatar();
    const { agent } = await signedInUser();

    const response = await binary(agent, `${avatarPath(owner.id)}?v=${version}`).expect(200);

    expect(response.headers['content-type']).toBe(AVATAR_CONTENT_TYPE);
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['etag']).toBe(`"${version}"`);
    expect(response.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(Buffer.from(response.body as Buffer).toString()).toBe('the current webp bytes');
  });

  it('serves the current image with no-cache for an outdated or missing v', async () => {
    const { owner } = await userWithStoredAvatar();
    const { agent } = await signedInUser();
    const outdated = parseAvatarKey(newAvatarKey(owner.id))?.version ?? '';

    for (const path of [`${avatarPath(owner.id)}?v=${outdated}`, avatarPath(owner.id)]) {
      const response = await binary(agent, path).expect(200);
      expect(response.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
      expect(Buffer.from(response.body as Buffer).toString()).toBe('the current webp bytes');
    }
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const { owner, version } = await userWithStoredAvatar();
    const { agent } = await signedInUser();

    const response = await agent.get(avatarPath(owner.id)).set('If-None-Match', `"${version}"`).expect(304);

    expect(response.headers['etag']).toBe(`"${version}"`);
    expect(response.text).toBeFalsy();
  });

  it('answers HEAD with the headers and no body', async () => {
    const { owner } = await userWithStoredAvatar();
    const { agent } = await signedInUser();
    const response = await agent.head(avatarPath(owner.id)).expect(200);
    expect(response.headers['content-type']).toBe(AVATAR_CONTENT_TYPE);
  });

  it('answers HEAD without reading the object body from storage', async () => {
    const { owner, version } = await userWithStoredAvatar();
    const { agent } = await signedInUser();
    const opened: Readable[] = [];
    const realGet = testApp.storage.get.bind(testApp.storage);
    const get = vi.spyOn(testApp.storage, 'get').mockImplementation(async (key) => {
      const object = await realGet(key);
      opened.push(object.body);
      return object;
    });

    try {
      const response = await agent.head(`${avatarPath(owner.id)}?v=${version}`).expect(200);
      expect(response.headers['etag']).toBe(`"${version}"`);
      expect(response.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    } finally {
      get.mockRestore();
    }

    expect(opened).toHaveLength(1);
    expect(opened[0]?.destroyed).toBe(true);
    expect(opened[0]?.readableEnded).toBe(false);
  });

  it('any signed-in user may see another user’s avatar; the owner sees their own', async () => {
    const { user, agent } = await signedInUser({ avatar: true });
    storeObjectFor(user.avatarKey);
    await binary(agent, avatarPath(user.id)).expect(200);
  });

  it('is 404 for a user without an avatar, an unknown user and a key whose object is missing (never 500)', async () => {
    const { agent } = await signedInUser();
    const withoutAvatar = await insertUser(testApp.db);
    const withMissingObject = await insertUser(testApp.db, { avatar: true }); // key in the DB, no object stored

    expectProblem(await agent.get(avatarPath(withoutAvatar.id)), 404, 'not-found');
    expectProblem(await agent.get(avatarPath(2_147_483_647)), 404, 'not-found');
    expectProblem(await agent.get(avatarPath(withMissingObject.id)), 404, 'not-found');
  });

  it('never gives a 404 or 500 the immutable caching or the ETag of the image it could not serve', async () => {
    const { agent } = await signedInUser();
    const withMissingObject = await insertUser(testApp.db, { avatar: true }); // key in the DB, no object stored
    const missingVersion = parseAvatarKey(withMissingObject.avatarKey ?? '')?.version ?? '';

    const missing = await agent.get(`${avatarPath(withMissingObject.id)}?v=${missingVersion}`);
    expectProblem(missing, 404, 'not-found');
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(missing.headers['etag']).not.toBe(`"${missingVersion}"`);

    const { owner, version } = await userWithStoredAvatar();
    testApp.storage.fail('get');
    try {
      const failed = await agent.get(`${avatarPath(owner.id)}?v=${version}`);
      expect(failed.status).toBe(500);
      expect(failed.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(failed.headers['cache-control']).toBe('no-store');
      expect(failed.headers['etag']).not.toBe(`"${version}"`);
    } finally {
      testApp.storage.recover('get');
    }
  });

  it('is 400 for a malformed id or v', async () => {
    const { owner } = await userWithStoredAvatar();
    const { agent } = await signedInUser();

    for (const id of ['abc', '0', '1e3', '2147483648']) {
      const problem = expectProblem(await agent.get(avatarPath(id)), 400, 'invalid-request');
      expect(problem.errors?.[0]?.location).toBe('params');
    }
    const problem = expectProblem(await agent.get(`${avatarPath(owner.id)}?v=../x`), 400, 'invalid-request');
    expect(problem.errors?.[0]).toMatchObject({ location: 'query', path: 'v' });
  });

  it('is 401 for a visitor', async () => {
    const { owner, version } = await userWithStoredAvatar();
    expectProblem(await request(testApp.app).get(`${avatarPath(owner.id)}?v=${version}`), 401, 'unauthorized');
  });

  it('F-36: an uploaded avatar is served through its avatarUrl', async () => {
    const { user, agent } = await signedInUser();
    const me = MeResponse.parse((await put(agent, await gifImage()).expect(200)).body).user;

    const response = await binary(agent, me.avatarUrl ?? '').expect(200);

    expect(response.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    const metadata = await sharp(Buffer.from(response.body as Buffer)).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: AVATAR_SIZE_PX, height: AVATAR_SIZE_PX });
    expect(objectKeysOf(user.id)).toHaveLength(1);
  });
});

// --- upload limiter -------------------------------------------------------------------------------------------------

describe('upload rate limit (own app with a low limit)', () => {
  const UPLOAD_LIMIT = 2;
  let limitedApp: TestApp;

  beforeAll(async () => {
    limitedApp = await createTestApp({
      limits: {
        ...resolveLimits({ RATE_LIMIT_MULTIPLIER: TEST_RATE_LIMIT_MULTIPLIER }),
        upload: { limit: UPLOAD_LIMIT, windowMs: 60 * 60 * 1000 },
      },
    });
  });
  afterAll(async () => {
    await limitedApp.close();
  });

  it('allows the limit of uploads per user and answers the next one with 429 rate-limited', async () => {
    const user = await insertUser(limitedApp.db);
    const agent = request.agent(limitedApp.app);
    await signIn(agent, user.id);
    const png = await pngImage();

    for (let attempt = 0; attempt < UPLOAD_LIMIT; attempt++) await put(agent, png).expect(200);
    const response = await put(agent, png);

    expectProblem(response, 429, 'rate-limited');
    expect(response.headers['retry-after']).toBeDefined();

    // Per user, not per IP: another user from the same address still has a budget.
    const other = await insertUser(limitedApp.db);
    const otherAgent = request.agent(limitedApp.app);
    await signIn(otherAgent, other.id);
    await put(otherAgent, png).expect(200);
  });
});
