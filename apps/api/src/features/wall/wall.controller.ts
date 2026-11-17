import { actorOf } from '../../shared/auth/guards.js';
import { validate } from '../../shared/http/validate.js';
import { CreatePostBody, type CreatePostResponse, IdParams, PageQuery, type WallPage } from './wall.schema.js';
import type { WallService } from './wall.service.js';

/**
 * HTTP <-> service translation only (API.md §2 "Wall"): Zod validation of params, query and body (400 for params and
 * query, 422 for the body, ADR-0004), status codes, DTO envelopes. No SQL, no rules; every rule is in the service.
 */
export function createWallController(service: WallService) {
  return {
    list: validate({ params: IdParams, query: PageQuery }, async ({ params, query }, req, res) => {
      const page: WallPage = await service.listPosts(actorOf(req), params.id, query);
      res.json(page);
    }),

    create: validate({ params: IdParams, body: CreatePostBody }, async ({ params, body }, req, res) => {
      const response: CreatePostResponse = { post: await service.createPost(actorOf(req), params.id, body) };
      res.status(201).json(response);
    }),

    remove: validate({ params: IdParams }, async ({ params }, req, res) => {
      await service.deletePost(actorOf(req), params.id);
      res.status(204).end();
    }),
  };
}

export type WallController = ReturnType<typeof createWallController>;
