import { http, HttpResponse } from 'msw';
import type { HttpResponseResolver } from 'msw';

import { CSRF_HEADER } from '../shared/api/baseQuery';
import type { DemoBackend } from './backend';
import { DemoProblem } from './problem';

type Resolver = HttpResponseResolver<Record<string, string | readonly string[]>>;

function problemResponse(problem: DemoProblem, request: Request): Response {
  return HttpResponse.json(problem.toProblem(new URL(request.url).pathname), {
    status: problem.status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/** Malformed JSON is a 400 `invalid-request` with a fixed detail, like the API's body parser mapping (B-50). */
async function jsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new DemoProblem(400, 'invalid-request', 'The request body is not valid JSON.');
  }
}

/** A body that is not multipart form data is a 400 `invalid-request`, as multer answers it. */
async function formBody(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new DemoProblem(400, 'invalid-request', 'Send the image as multipart/form-data.');
  }
}

function queryOf(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Wraps a resolver like the API's middleware: every unsafe method needs the session's CSRF token first (F-23, checked
 * by method for every route, as csrf-csrf does), and a `DemoProblem` becomes problem+json, like the error handler.
 * Anything else is a bug in the demo: it is rethrown, and msw answers it with a 500 and logs it to the console.
 */
function route(backend: DemoBackend, resolver: Resolver): Resolver {
  return async (info) => {
    try {
      if (!SAFE_METHODS.has(info.request.method)) backend.assertCsrf(info.request.headers.get(CSRF_HEADER));
      return await resolver(info);
    } catch (error) {
      if (error instanceof DemoProblem) return problemResponse(error, info.request);
      throw error;
    }
  };
}

/**
 * Every HTTP endpoint of API.md §2, answered in the browser by the demo backend (ADR-0020). Paths are relative, so
 * they match the app's same-origin `/api/...` requests wherever the demo is hosted. Unknown `/api/*` paths answer the
 * 404 `not-found` problem (F-04), never the HTML shell.
 */
export function createHttpHandlers(backend: DemoBackend) {
  const json = (data: unknown, status = 200) => HttpResponse.json(data as Record<string, unknown>, { status });

  return [
    http.get(
      '/api/csrf-token',
      route(backend, () => json(backend.csrfToken())),
    ),
    http.post(
      '/api/auth/register',
      route(backend, async ({ request }) => json(await backend.register(await jsonBody(request)), 201)),
    ),
    http.post(
      '/api/auth/login',
      route(backend, async ({ request }) => json(await backend.login(await jsonBody(request)))),
    ),
    http.post(
      '/api/auth/logout',
      route(backend, async () => {
        await backend.logout();
        return new HttpResponse(null, { status: 204 });
      }),
    ),
    http.get(
      '/api/me',
      route(backend, () => json(backend.me())),
    ),
    http.patch(
      '/api/me',
      route(backend, async ({ request }) => json(await backend.updateMe(await jsonBody(request)))),
    ),
    http.put(
      '/api/me/avatar',
      route(backend, async ({ request }) => json(await backend.uploadAvatar(await formBody(request)))),
    ),
    http.get(
      '/api/users/search',
      route(backend, ({ request }) => json(backend.search(queryOf(request)))),
    ),
    http.get(
      '/api/users/:id/avatar',
      route(backend, async ({ params }) => {
        const image = await backend.avatar(params['id']);
        return new HttpResponse(image.body, {
          headers: { 'content-type': image.contentType, 'cache-control': 'private, no-cache' },
        });
      }),
    ),
    http.get(
      '/api/users/:id/posts',
      route(backend, ({ params, request }) => json(backend.wall(params['id'], queryOf(request)))),
    ),
    http.post(
      '/api/users/:id/posts',
      route(backend, async ({ params, request }) =>
        json(await backend.createPost(params['id'], await jsonBody(request)), 201),
      ),
    ),
    http.get(
      '/api/users/:id',
      route(backend, ({ params }) => json(backend.profile(params['id']))),
    ),
    http.delete(
      '/api/posts/:id',
      route(backend, async ({ params }) => {
        await backend.deletePost(params['id']);
        return new HttpResponse(null, { status: 204 });
      }),
    ),
    http.get(
      '/api/friendships',
      route(backend, () => json(backend.friendships())),
    ),
    http.post(
      '/api/friendships',
      route(backend, async ({ request }) => json(await backend.sendFriendRequest(await jsonBody(request)), 201)),
    ),
    http.post(
      '/api/friendships/:userId/accept',
      route(backend, async ({ params }) => json(await backend.acceptFriendRequest(params['userId']))),
    ),
    http.delete(
      '/api/friendships/:userId',
      route(backend, async ({ params }) => json(await backend.removeFriendship(params['userId']))),
    ),
    http.get(
      '/api/chat/messages',
      route(backend, ({ request }) => json(backend.chat(queryOf(request)))),
    ),
    http.get(
      '/api/presence',
      route(backend, () => json(backend.presence())),
    ),
    http.all(
      '/api/*',
      route(backend, () => {
        throw new DemoProblem(404, 'not-found', 'Route was not found.');
      }),
    ),
  ];
}
