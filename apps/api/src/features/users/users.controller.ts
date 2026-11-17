import { actorOf } from '../../shared/auth/guards.js';
import { validate } from '../../shared/http/validate.js';
import { IdParams, SearchQuery, UpdateMeBody } from './users.schema.js';
import type { UsersService } from './users.service.js';

/** HTTP <-> service translation only: validation, the actor, status codes. No SQL, no rules. */
export function createUsersController(service: UsersService) {
  return {
    getMe: validate({}, async (_input, req, res) => {
      res.json(await service.getMe(actorOf(req)));
    }),

    updateMe: validate({ body: UpdateMeBody }, async ({ body }, req, res) => {
      res.json(await service.updateMe(actorOf(req), body));
    }),

    search: validate({ query: SearchQuery }, async ({ query }, req, res) => {
      res.json(await service.search(actorOf(req), query));
    }),

    getProfile: validate({ params: IdParams }, async ({ params }, req, res) => {
      res.json(await service.getProfile(actorOf(req), params.id));
    }),
  };
}

export type UsersController = ReturnType<typeof createUsersController>;
