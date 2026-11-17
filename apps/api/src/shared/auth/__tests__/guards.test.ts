import { PROBLEM_TYPE_PREFIX, Problem } from '@app/shared';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ForbiddenError, UnauthorizedError } from '../../errors/app-error.js';
import { errorHandler } from '../../http/problem.js';
import { actorOf, assertOwner, requireAuth } from '../guards.js';

/**
 * The guards on a real Express app with express-session (in-memory store): `POST /sign-in/:id` stores a user id like
 * `establishSession` does, `GET /me` sits behind `requireAuth` and answers with `actorOf(req)`.
 */
function guardedApp() {
  const app = express();
  app.use(session({ secret: 'unit-test-session-secret-with-32-chars', resave: false, saveUninitialized: false }));
  app.post('/sign-in/:id', (req, res) => {
    req.session.userId = Number(req.params.id);
    res.status(204).end();
  });
  app.get('/me', requireAuth, (req, res) => {
    res.json(actorOf(req));
  });
  app.get('/unguarded-actor', (req, res) => {
    res.json(actorOf(req));
  });
  app.use(errorHandler);
  return app;
}

describe('requireAuth', () => {
  it('B-20, F-21: a request without a signed-in session gets the 401 unauthorized problem', async () => {
    const response = await request(guardedApp()).get('/me');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(Problem.parse(response.body)).toMatchObject({
      type: `${PROBLEM_TYPE_PREFIX}unauthorized`,
      status: 401,
      instance: '/me',
    });
  });

  it('B-20: a signed-in session passes and the handler reads the actor from it', async () => {
    const agent = request.agent(guardedApp());
    await agent.post('/sign-in/42').expect(204);

    const response = await agent.get('/me');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: 42 });
  });

  it('a session that holds no user id (an anonymous CSRF session) is still unauthenticated', async () => {
    const app = express();
    app.use(session({ secret: 'unit-test-session-secret-with-32-chars', resave: false, saveUninitialized: false }));
    app.get('/bind', (req, res) => {
      req.session.csrfBound = true;
      res.status(204).end();
    });
    app.get('/me', requireAuth, (_req, res) => {
      res.status(204).end();
    });
    app.use(errorHandler);
    const agent = request.agent(app);
    await agent.get('/bind').expect(204);

    await agent.get('/me').expect(401);
  });
});

describe('actorOf', () => {
  it('throws UnauthorizedError when a route forgot requireAuth, instead of returning an undefined user', async () => {
    const response = await request(guardedApp()).get('/unguarded-actor');

    expect(response.status).toBe(401);
  });
});

describe('assertOwner', () => {
  it('B-21: passes for the owner of a resource', () => {
    expect(() => {
      assertOwner({ userId: 7 }, { ownerId: 7 });
    }).not.toThrow();
  });

  it('B-21: rejects everyone else with ForbiddenError (403 forbidden)', () => {
    expect(() => {
      assertOwner({ userId: 8 }, { ownerId: 7 });
    }).toThrow(ForbiddenError);
  });

  it('is not an UnauthorizedError: the caller is known, only not allowed', () => {
    let caught: unknown;
    try {
      assertOwner({ userId: 8 }, { ownerId: 7 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(caught).not.toBeInstanceOf(UnauthorizedError);
  });
});
