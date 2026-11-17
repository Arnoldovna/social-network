import { Id } from '@app/shared';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';

import type { Database } from '../src/db/client.js';
import { users } from '../src/db/schema/index.js';
import { NotFoundError } from '../src/shared/errors/app-error.js';
import { validate } from '../src/shared/http/validate.js';
import type { IssueCsrfToken } from '../src/shared/security/csrf.js';
import { establishSession } from '../src/shared/security/session.js';

/** The test-only sign-in route (ADR-0019 §3). */
export const TEST_SIGN_IN_PATH = '/__test/sign-in';

export const TestSignInBody = z.strictObject({ userId: Id });

/** What `POST /__test/sign-in` answers: the CSRF token bound to the regenerated session id. */
export const TestSignInResponse = z.strictObject({ csrfToken: z.string().min(1) });
export type TestSignInResponse = z.infer<typeof TestSignInResponse>;

export interface TestRoutesDeps {
  db: Database;
  /** Must overwrite the request's existing token (`{ overwrite: true }`): the session id changes on sign-in. */
  issueCsrfToken: IssueCsrfToken;
}

/**
 * `POST /__test/sign-in` with JSON `{ userId }` (ADR-0019 §3): signs the agent in as an existing user without the
 * auth routes, which the auth unit writes in parallel. 404 `not-found` problem for an unknown id, 422 for a body that
 * is not exactly `{ userId: <Id> }`; otherwise the same `establishSession` the auth unit uses (session id
 * regenerated, F-18) and 200 `{ csrfToken }` issued for the new session id (B-58).
 *
 * Threat: this is an authentication bypass by design. It lives under `apps/api/test/` (outside the build, never in
 * `dist/` or the image), ESLint forbids importing `test/**` from `src`, `container.ts` cannot pass `testRoutes`, and
 * `test/app.int.test.ts` proves an app built without it answers 404. `app.ts` mounts it after `GET /api/csrf-token`
 * and before CSRF protection, because a sign-in carries no token yet.
 */
export function createTestRoutes({ db, issueCsrfToken }: TestRoutesDeps): Router {
  const router = Router();

  router.post(
    TEST_SIGN_IN_PATH,
    validate({ body: TestSignInBody }, async ({ body }, req, res) => {
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, body.userId)).limit(1);
      if (!user) throw new NotFoundError('User');

      await establishSession(req, user.id);
      const response: TestSignInResponse = { csrfToken: issueCsrfToken(req, res) };
      res.status(200).json(response);
    }),
  );

  return router;
}
