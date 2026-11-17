import { buffer } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { createFakeStorage } from '../../../../test/fakes.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../../shared/errors/app-error.js';
import { createAvatarUrl, newAvatarKey, parseAvatarKey } from '../../../shared/media/media-url.js';
import { AVATAR_CONTENT_TYPE } from '../../../shared/uploads/process-image.js';
import type { SniffedImage } from '../../../shared/uploads/upload.js';
import { createAvatarsService } from '../avatars.service.js';
import {
  createFakeAvatarsRepository,
  createFakeImageProcessor,
  createFakeLogger,
  type FakeLogger,
  fakeProcessedBytes,
} from './fakes.js';
import { avatarKeyPattern, avatarUrlPattern } from './fixtures.js';

const ME = 7;
const OTHER = 8;

function setup() {
  const repository = createFakeAvatarsRepository();
  const storage = createFakeStorage();
  const processor = createFakeImageProcessor();
  const logger = createFakeLogger();
  const service = createAvatarsService({
    repository,
    storage,
    avatarUrl: createAvatarUrl(),
    processImage: processor.process,
    logger,
  });
  repository.addUser({ id: ME, firstName: 'Mira', lastName: 'Novak', bio: 'Hello' });
  repository.addUser({ id: OTHER, firstName: 'Olek', lastName: 'Brandt' });
  return { repository, storage, processor, logger, service };
}

const upload = (bytes = 'original upload'): SniffedImage => ({ buffer: Buffer.from(bytes), mime: 'image/png' });

/** Gives `userId` a stored avatar object (key in the repository, bytes in storage) and returns its key. */
async function givenAvatar(
  { repository, storage }: Pick<ReturnType<typeof setup>, 'repository' | 'storage'>,
  userId: number,
  bytes = 'previous avatar',
) {
  const key = newAvatarKey(userId);
  const user = repository.users.get(userId);
  if (!user) throw new Error(`givenAvatar: no user ${String(userId)}`);
  repository.users.set(userId, { ...user, avatarKey: key });
  await storage.put(key, Buffer.from(bytes), AVATAR_CONTENT_TYPE);
  return key;
}

/** Exactly one warning with `message`, naming the object `key` and carrying the storage error as `err`. */
function expectOneWarning(logger: FakeLogger, message: string, key: string | undefined): void {
  expect(logger.warnings.map((warning) => warning.message)).toEqual([message]);
  const details = logger.warnings[0]?.details ?? {};
  expect(details['key']).toBe(key);
  expect(details['err']).toBeInstanceOf(Error);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

describe('avatars service: replaceAvatar', () => {
  it('F-36: stores the re-encoded WebP under a fresh server-made key and returns Me with the new avatarUrl', async () => {
    const { service, storage, repository, processor } = setup();

    const me = await service.replaceAvatar({ userId: ME }, upload());

    expect(processor.inputs).toEqual([Buffer.from('original upload')]);
    const key = repository.users.get(ME)?.avatarKey ?? '';
    expect(key).toMatch(avatarKeyPattern(ME));
    expect(storage.objects.get(key)).toEqual({
      body: Uint8Array.from(fakeProcessedBytes(Buffer.from('original upload'))),
      contentType: AVATAR_CONTENT_TYPE,
    });
    expect(me).toEqual({
      id: ME,
      firstName: 'Mira',
      lastName: 'Novak',
      bio: 'Hello',
      avatarUrl: `/api/users/${String(ME)}/avatar?v=${parseAvatarKey(key)?.version ?? ''}`,
    });
  });

  it('B-30: never stores the original bytes, only the processed image', async () => {
    const { service, storage } = setup();
    await service.replaceAvatar({ userId: ME }, upload('<html>payload</html>'));
    const bodies = [...storage.objects.values()].map((object) => Buffer.from(object.body).toString());
    expect(bodies).toEqual(['webp:<html>payload</html>']);
  });

  it('F-39, B-36: deletes the replaced object after the key swap', async () => {
    const ctx = setup();
    const oldKey = await givenAvatar(ctx, ME);

    await ctx.service.replaceAvatar({ userId: ME }, upload());

    const newKey = ctx.repository.users.get(ME)?.avatarKey;
    expect(newKey).not.toBe(oldKey);
    expect([...ctx.storage.objects.keys()]).toEqual([newKey]);
    expect(ctx.logger.warnings).toEqual([]);
  });

  it('deletes nothing when the user had no avatar before', async () => {
    const { service, storage } = setup();
    await service.replaceAvatar({ userId: ME }, upload());
    expect(storage.objects.size).toBe(1);
  });

  it('F-39: a failed delete of the replaced object is a warning, never a failed upload', async () => {
    const ctx = setup();
    const oldKey = await givenAvatar(ctx, ME);
    ctx.storage.fail('delete');

    const me = await ctx.service.replaceAvatar({ userId: ME }, upload());

    expect(me.avatarUrl).toMatch(avatarUrlPattern(ME));
    expectOneWarning(ctx.logger, 'could not delete replaced avatar object', oldKey);
  });

  it('B-34: a failed put rejects with the storage error and leaves the database unchanged', async () => {
    const ctx = setup();
    const oldKey = await givenAvatar(ctx, ME);
    const storageError = new Error('S3 unreachable');
    ctx.storage.fail('put', storageError);

    await expect(ctx.service.replaceAvatar({ userId: ME }, upload())).rejects.toBe(storageError);

    expect(ctx.repository.users.get(ME)?.avatarKey).toBe(oldKey);
    expect([...ctx.storage.objects.keys()]).toEqual([oldKey]);
  });

  it('B-34: a failed key swap deletes the new object again, so no orphan is left, and rethrows', async () => {
    const ctx = setup();
    const oldKey = await givenAvatar(ctx, ME);
    const dbError = new Error('connection terminated');
    ctx.repository.failSwaps(dbError);

    await expect(ctx.service.replaceAvatar({ userId: ME }, upload())).rejects.toBe(dbError);

    expect(ctx.repository.users.get(ME)?.avatarKey).toBe(oldKey);
    expect([...ctx.storage.objects.keys()]).toEqual([oldKey]);
  });

  it('B-34: when the compensating delete fails too, the original error still wins and the leftover is logged', async () => {
    const ctx = setup();
    const dbError = new Error('connection terminated');
    ctx.repository.failSwaps(dbError);
    ctx.storage.fail('delete');

    await expect(ctx.service.replaceAvatar({ userId: ME }, upload())).rejects.toBe(dbError);

    const [leftover] = [...ctx.storage.objects.keys()];
    expect(leftover).toMatch(avatarKeyPattern(ME));
    expectOneWarning(ctx.logger, 'could not delete unreferenced new avatar object', leftover);
  });

  it('B-35: a processing error (e.g. 422 for an oversized image) stores nothing', async () => {
    const { service, storage, processor, repository } = setup();
    const tooLarge = new ValidationError([{ location: 'file', path: 'avatar', message: 'too large' }], {
      status: 422,
    });
    processor.fail(tooLarge);

    await expect(service.replaceAvatar({ userId: ME }, upload())).rejects.toBe(tooLarge);

    expect(storage.objects.size).toBe(0);
    expect(repository.users.get(ME)?.avatarKey).toBeNull();
  });

  it('a session whose account no longer exists is 401 and leaves no object behind', async () => {
    const { service, storage } = setup();
    const error = await rejection(service.replaceAvatar({ userId: 999 }, upload()));
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(storage.objects.size).toBe(0);
  });

  it('only ever changes the actor’s own avatar', async () => {
    const ctx = setup();
    const othersKey = await givenAvatar(ctx, OTHER);

    await ctx.service.replaceAvatar({ userId: ME }, upload());

    expect(ctx.repository.users.get(OTHER)?.avatarKey).toBe(othersKey);
    expect(ctx.storage.objects.has(othersKey)).toBe(true);
    expect(ctx.repository.users.get(ME)?.avatarKey).toMatch(avatarKeyPattern(ME));
  });
});

describe('avatars service: findCurrent and open', () => {
  it('resolves the current key and its uuid as version', async () => {
    const ctx = setup();
    const key = await givenAvatar(ctx, OTHER);
    await expect(ctx.service.findCurrent(OTHER)).resolves.toEqual({
      key,
      version: parseAvatarKey(key)?.version,
    });
  });

  it('is a 404 for a user without an avatar and for an unknown user', async () => {
    const { service } = setup();
    expect(await rejection(service.findCurrent(ME))).toBeInstanceOf(NotFoundError);
    expect(await rejection(service.findCurrent(999))).toBeInstanceOf(NotFoundError);
  });

  it('refuses to serve a stored key that is not a server-made key of that user', async () => {
    const { service, repository } = setup();
    repository.addUser({ id: ME, avatarKey: newAvatarKey(OTHER) });
    await expect(service.findCurrent(ME)).rejects.toThrow('malformed');
  });

  it('opens the stored object with its content type', async () => {
    const ctx = setup();
    await givenAvatar(ctx, OTHER, 'stored webp');
    const current = await ctx.service.findCurrent(OTHER);

    const image = await ctx.service.open(OTHER, current);

    expect(image).toMatchObject({ ...current, contentType: AVATAR_CONTENT_TYPE });
    expect((await buffer(image.body)).toString()).toBe('stored webp');
  });

  it('a key whose object is missing is a 404, never a 500', async () => {
    const ctx = setup();
    const key = await givenAvatar(ctx, OTHER);
    ctx.storage.objects.delete(key);
    const current = await ctx.service.findCurrent(OTHER);
    expect(await rejection(ctx.service.open(OTHER, current))).toBeInstanceOf(NotFoundError);
  });

  it('F-37: serves the newer avatar when a concurrent upload replaced and deleted the resolved one', async () => {
    const ctx = setup();
    await givenAvatar(ctx, ME, 'first');
    const resolved = await ctx.service.findCurrent(ME);
    await ctx.service.replaceAvatar({ userId: ME }, upload('second')); // deletes the resolved object

    const image = await ctx.service.open(ME, resolved);

    expect(image.version).not.toBe(resolved.version);
    expect(image.key).toBe(ctx.repository.users.get(ME)?.avatarKey);
    expect((await buffer(image.body)).toString()).toBe('webp:second');
  });

  it('other storage errors are not hidden as a 404', async () => {
    const ctx = setup();
    await givenAvatar(ctx, OTHER);
    const current = await ctx.service.findCurrent(OTHER);
    const storageError = new Error('S3 unreachable');
    ctx.storage.fail('get', storageError);
    await expect(ctx.service.open(OTHER, current)).rejects.toBe(storageError);
  });
});
