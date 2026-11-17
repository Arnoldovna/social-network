import { AVATAR_FIELD, AVATAR_MIME_TYPES, Problem, problemCode } from '@app/shared';
import express from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FileRequiredError } from '../../errors/app-error.js';
import { errorHandler } from '../../http/problem.js';
import { avatarUpload, sniffImage } from '../upload.js';

const MAX_BYTES = 4096;

/** `PUT /api/me/avatar` reduced to the upload steps, with the real error handler as `app.ts` wires it. */
function uploadApp() {
  const app = express();
  app.put('/api/me/avatar', avatarUpload(AVATAR_FIELD, MAX_BYTES), async (req, res) => {
    const image = await sniffImage(req.file);
    res.json({ mime: image.mime, bytes: image.buffer.length });
  });
  app.use(errorHandler);
  return app;
}

const put = () => request(uploadApp()).put('/api/me/avatar');

function image(format: 'jpeg' | 'png' | 'webp' | 'gif') {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
    .toFormat(format)
    .toBuffer();
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemCode(Problem.parse(response.body))).toBe(code);
}

describe('avatarUpload + sniffImage (ADR-0010 §1–2, FEATURES Appendix C)', () => {
  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
  ] as const)('accepts a %s and reports the sniffed type %s', async (format, mime) => {
    const bytes = await image(format);

    const response = await put().attach(AVATAR_FIELD, bytes, { filename: 'a.bin', contentType: 'text/plain' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mime, bytes: bytes.length });
    expect(AVATAR_MIME_TYPES).toContain(mime);
  });

  it('decides by magic bytes, not by filename or Content-Type (B-29, B-30)', async () => {
    const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');

    const response = await put().attach(AVATAR_FIELD, html, { filename: 'me.png', contentType: 'image/png' });

    expectProblem(response, 415, 'unsupported-media-type');
    expect(response.body).toMatchObject({ allowed: [...AVATAR_MIME_TYPES] });
  });

  it('refuses an image type outside the allow-list (TIFF) with 415', async () => {
    const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .tiff()
      .toBuffer();

    expectProblem(await put().attach(AVATAR_FIELD, tiff, 'a.tiff'), 415, 'unsupported-media-type');
  });

  it('answers a request without any file with 400 file-required (B-33)', async () => {
    expectProblem(await put(), 400, 'file-required');
  });

  it('answers an empty file with 400 file-required', async () => {
    expectProblem(await put().attach(AVATAR_FIELD, Buffer.alloc(0), 'empty.png'), 400, 'file-required');
  });

  it('accepts a file of exactly maxBytes', async () => {
    const png = await image('png');
    const exact = Buffer.concat([png, Buffer.alloc(MAX_BYTES - png.length)]);

    const response = await put().attach(AVATAR_FIELD, exact, 'a.png');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mime: 'image/png', bytes: MAX_BYTES });
  });

  it('answers a file over maxBytes with 413 file-too-large (B-32)', async () => {
    const png = await image('png');
    const tooBig = Buffer.concat([png, Buffer.alloc(MAX_BYTES + 1 - png.length)]);

    expectProblem(await put().attach(AVATAR_FIELD, tooBig, 'a.png'), 413, 'file-too-large');
  });

  it('rejects any other form field with 400 invalid-request (fields: 0)', async () => {
    const response = await put()
      .field('file', 'undefined')
      .attach(AVATAR_FIELD, await image('png'), 'a.png');

    expectProblem(response, 400, 'invalid-request');
  });

  it('rejects a second file with 400 invalid-request (files: 1, parts: 1)', async () => {
    const png = await image('png');

    const response = await put().attach(AVATAR_FIELD, png, 'a.png').attach(AVATAR_FIELD, png, 'b.png');

    expectProblem(response, 400, 'invalid-request');
  });

  it('rejects a file under another field name with 400 invalid-request', async () => {
    expectProblem(await put().attach('picture', await image('png'), 'a.png'), 400, 'invalid-request');
  });
});

describe('sniffImage', () => {
  it('throws FileRequiredError when no file arrived', async () => {
    await expect(sniffImage(undefined)).rejects.toBeInstanceOf(FileRequiredError);
  });
});
