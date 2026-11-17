import { PROBLEM_TYPE_PREFIX, Problem, problemCode } from '@app/shared';
import { doubleCsrf } from 'csrf-csrf';
import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { APP_SLUG } from '../../../config/app.js';
import { errorHandler } from '../../http/problem.js';
import {
  BadRequestError,
  ConflictError,
  FileRequiredError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../app-error.js';

/** The problem the error handler sends for `error`, thrown by a route that was called with a query string. */
async function problemFor(error: unknown) {
  const app = express();
  app.get('/api/boom', () => {
    throw error;
  });
  app.use(errorHandler);
  const response = await request(app).get('/api/boom?q=secret');
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  return { status: response.status, problem: Problem.parse(response.body) };
}

const issue = { location: 'body', path: 'password', message: 'Use at least 12 characters.' } as const;

describe('ADR-0004: every code the API sends is a member of the shared ProblemCode contract', () => {
  it("uses the shared contract's type prefix, and that prefix names this app (APP_SLUG)", () => {
    expect(PROBLEM_TYPE_PREFIX).toBe(`tag:arnoldovna.github.io,2026:${APP_SLUG}:problem:`);
  });

  it.each([
    ['UnauthorizedError', new UnauthorizedError(), 401, 'unauthorized'],
    ['BadRequestError (default code)', new BadRequestError('Bad cursor.'), 400, 'invalid-request'],
    ['BadRequestError (explicit code)', new BadRequestError('Bad cursor.', 'invalid-cursor'), 400, 'invalid-cursor'],
    ['FileRequiredError', new FileRequiredError(), 400, 'file-required'],
    ['ForbiddenError', new ForbiddenError(), 403, 'forbidden'],
    ['NotFoundError', new NotFoundError('User'), 404, 'not-found'],
    ['ConflictError', new ConflictError('That email is taken.', 'email-taken'), 409, 'email-taken'],
    ['PayloadTooLargeError', new PayloadTooLargeError(2_097_152), 413, 'file-too-large'],
    ['UnsupportedMediaTypeError', new UnsupportedMediaTypeError(['image/png']), 415, 'unsupported-media-type'],
    ['ValidationError (params/query)', new ValidationError([issue], { status: 400 }), 400, 'invalid-request'],
    ['ValidationError (body)', new ValidationError([issue], { status: 422 }), 422, 'validation-failed'],
  ])('F-106: %s -> %i %s', async (_name, error, status, code) => {
    const result = await problemFor(error);

    expect(result.status).toBe(status);
    expect(result.problem.status).toBe(status);
    expect(problemCode(result.problem)).toBe(code);
  });

  it('F-29: a ValidationError lists every issue in errors[]', async () => {
    const { problem } = await problemFor(new ValidationError([issue], { status: 422 }));

    expect(problem.errors).toEqual([issue]);
  });

  it('maps multer LIMIT_FILE_SIZE to 413 file-too-large and every other MulterError to 400 invalid-request', async () => {
    const tooLarge = await problemFor(new multer.MulterError('LIMIT_FILE_SIZE', 'avatar'));
    const unexpected = await problemFor(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'other'));

    expect([tooLarge.status, problemCode(tooLarge.problem)]).toEqual([413, 'file-too-large']);
    expect([unexpected.status, problemCode(unexpected.problem)]).toEqual([400, 'invalid-request']);
  });

  it("maps csrf-csrf's invalid token error to 403 csrf-invalid (the SPA retries once on it)", async () => {
    const { invalidCsrfTokenError } = doubleCsrf({
      getSecret: () => 'test-csrf-secret-with-at-least-32-characters',
      getSessionIdentifier: () => 'session',
    });

    const result = await problemFor(invalidCsrfTokenError);

    expect([result.status, problemCode(result.problem)]).toEqual([403, 'csrf-invalid']);
  });

  it('maps body-parser errors to invalid-request and keeps their status (malformed JSON 400, too large 413)', async () => {
    const app = express();
    app.post('/api/echo', express.json({ limit: '1kb' }), (_req, res) => {
      res.sendStatus(204);
    });
    app.use(errorHandler);

    const malformed = await request(app).post('/api/echo').set('content-type', 'application/json').send('{"a":');
    const tooLarge = await request(app)
      .post('/api/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(2_000) }));

    expect([malformed.status, problemCode(Problem.parse(malformed.body))]).toEqual([400, 'invalid-request']);
    expect([tooLarge.status, problemCode(Problem.parse(tooLarge.body))]).toEqual([413, 'invalid-request']);
  });

  it('F-106: answers anything else with the generic 500 about:blank and never leaks the message', async () => {
    const { status, problem } = await problemFor(new Error('relation "users" does not exist'));

    expect(status).toBe(500);
    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/api/boom',
    });
    expect(problemCode(problem)).toBeNull();
  });

  it('F-113: instance is the path without the query string', async () => {
    const { problem } = await problemFor(new NotFoundError('User'));

    expect(problem.instance).toBe('/api/boom');
  });
});
