import { Problem, problemCode } from '@app/shared';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { NotFoundError } from '../../errors/app-error.js';
import { errorHandler } from '../problem.js';
import { validate, type ValidatedHandler } from '../validate.js';

const schemas = {
  params: z.object({ id: z.coerce.number().int().positive() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
  body: z.object({
    bio: z.string().trim().max(10, 'Use at most 10 characters.'),
    tags: z.array(z.object({ name: z.string().min(1, 'Name the tag.') })).default([]),
  }),
};

type Handler = ValidatedHandler<typeof schemas>;

/** One route under `/api/users/:id` with JSON parsing and the real error handler, as `app.ts` wires it. */
function appWith(route: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.patch('/api/users/:id', route);
  app.use(errorHandler);
  return app;
}

/** A spy handler that answers 200 with the parsed input it received. */
function echoHandler() {
  return vi.fn<Handler>((input, _req, res) => {
    res.json(input);
  });
}

async function patch(app: express.Express, path: string, body?: unknown) {
  const pending = request(app).patch(path);
  const response = await (body === undefined ? pending : pending.send(body as object));
  return response;
}

describe('validate() (ADR-0004)', () => {
  it('hands the parsed, typed values of every part to the handler', async () => {
    const handler = echoHandler();

    const response = await patch(appWith(validate(schemas, handler)), '/api/users/7?limit=5', { bio: '  hi  ' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ params: { id: 7 }, query: { limit: 5 }, body: { bio: 'hi', tags: [] } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('passes undefined for parts without a schema', async () => {
    const handler = vi.fn<ValidatedHandler<{ params: typeof schemas.params }>>((_input, _req, res) => {
      res.sendStatus(204);
    });

    const response = await patch(appWith(validate({ params: schemas.params }, handler)), '/api/users/7?limit=x', {
      anything: true,
    });

    expect(response.status).toBe(204);
    const [input] = handler.mock.calls[0] ?? [];
    expect(input?.params).toEqual({ id: 7 });
    expect(input?.query).toBeUndefined();
    expect(input?.body).toBeUndefined();
  });

  it('leaves req untouched: the raw query stays on req, the parsed one comes in input (Express 5 getter)', async () => {
    const handler = vi.fn<Handler>((input, req, res) => {
      res.json({ parsed: input.query.limit, raw: req.query['limit'] });
    });

    const response = await patch(appWith(validate(schemas, handler)), '/api/users/7?limit=5', { bio: 'hi' });

    expect(response.body).toEqual({ parsed: 5, raw: '5' });
  });

  it('answers invalid params with 400 invalid-request and never calls the handler', async () => {
    const handler = echoHandler();

    const response = await patch(appWith(validate(schemas, handler)), '/api/users/abc', { bio: 'hi' });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = Problem.parse(response.body);
    expect(problemCode(problem)).toBe('invalid-request');
    expect(problem.errors).toEqual([{ location: 'params', path: 'id', message: expect.any(String) as string }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers invalid query with 400 invalid-request', async () => {
    const handler = echoHandler();

    const response = await patch(appWith(validate(schemas, handler)), '/api/users/7?limit=500', { bio: 'hi' });

    expect(response.status).toBe(400);
    const problem = Problem.parse(response.body);
    expect(problemCode(problem)).toBe('invalid-request');
    expect(problem.errors).toEqual([{ location: 'query', path: 'limit', message: expect.any(String) as string }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('F-29: answers body-only issues with 422 validation-failed and lists every issue with its nested path', async () => {
    const handler = echoHandler();

    const response = await patch(appWith(validate(schemas, handler)), '/api/users/7', {
      bio: 'x'.repeat(11),
      tags: [{ name: 'ok' }, { name: '' }],
    });

    expect(response.status).toBe(422);
    const problem = Problem.parse(response.body);
    expect(problemCode(problem)).toBe('validation-failed');
    expect(problem.detail).toBe('The request body is invalid.');
    expect(problem.errors).toEqual([
      { location: 'body', path: 'bio', message: 'Use at most 10 characters.' },
      { location: 'body', path: 'tags.1.name', message: 'Name the tag.' },
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers a missing body with 422 (well-formed request, invalid content) and an empty root path', async () => {
    const response = await patch(appWith(validate(schemas, echoHandler())), '/api/users/7');

    expect(response.status).toBe(422);
    expect(Problem.parse(response.body).errors).toEqual([
      { location: 'body', path: '', message: expect.any(String) as string },
    ]);
  });

  it('answers 400 when params and body both fail, and still reports every issue of every part', async () => {
    const response = await patch(appWith(validate(schemas, echoHandler())), '/api/users/0?limit=0', {
      bio: 'x'.repeat(11),
    });

    expect(response.status).toBe(400);
    const problem = Problem.parse(response.body);
    expect(problemCode(problem)).toBe('invalid-request');
    expect(problem.errors?.map(({ location, path }) => `${location}:${path}`)).toEqual([
      'params:id',
      'query:limit',
      'body:bio',
    ]);
  });

  it('keeps the problem instance free of the query string (F-113)', async () => {
    const response = await patch(appWith(validate(schemas, echoHandler())), '/api/users/abc?limit=Mira', {});

    expect(Problem.parse(response.body).instance).toBe('/api/users/abc');
  });

  it("forwards the handler's own rejection to the error handler (Express 5, no try/catch)", async () => {
    const handler = vi.fn<Handler>(() => Promise.reject(new NotFoundError('User')));

    const response = await patch(appWith(validate(schemas, handler)), '/api/users/7', { bio: 'hi' });

    expect(response.status).toBe(404);
    expect(problemCode(Problem.parse(response.body))).toBe('not-found');
  });
});
