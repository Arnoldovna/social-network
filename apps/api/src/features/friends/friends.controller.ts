import type { Request, Response } from 'express';

import { actorOf } from '../../shared/auth/guards.js';
import { validate } from '../../shared/http/validate.js';
import type { FriendshipChange, FriendshipsResponse } from './friends.schema.js';
import { SendFriendRequestBody, UserIdParams } from './friends.schema.js';
import type { FriendsService } from './friends.service.js';

/**
 * HTTP <-> service translation only: validation, the actor, status codes. No SQL, no rules. Every handler sits behind
 * `requireAuth` (friends.routes.ts), so `actorOf` always finds the session's user.
 */
export function createFriendsController(service: FriendsService) {
  return {
    list: async (req: Request, res: Response) => {
      const body: FriendshipsResponse = await service.list(actorOf(req));
      res.json(body);
    },

    /** 201: a new friendship row (the pending request) was created. */
    send: validate({ body: SendFriendRequestBody }, async ({ body }, req, res) => {
      const change: FriendshipChange = await service.sendRequest(actorOf(req), body.userId);
      res.status(201).json(change);
    }),

    accept: validate({ params: UserIdParams }, async ({ params }, req, res) => {
      const change: FriendshipChange = await service.accept(actorOf(req), params.userId);
      res.json(change);
    }),

    /** 200 with the new state (`none`) rather than 204, so cancel, decline and unfriend answer like every mutation. */
    remove: validate({ params: UserIdParams }, async ({ params }, req, res) => {
      const change: FriendshipChange = await service.remove(actorOf(req), params.userId);
      res.json(change);
    }),
  };
}

export type FriendsController = ReturnType<typeof createFriendsController>;
