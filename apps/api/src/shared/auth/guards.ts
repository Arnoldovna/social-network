import type { Request, RequestHandler } from 'express';

import { ForbiddenError, UnauthorizedError } from '../errors/app-error.js';

export interface Actor {
  userId: number;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (req.session.userId === undefined) {
    next(new UnauthorizedError());
    return;
  }
  next();
};

/** Read the authenticated actor inside handlers that sit behind `requireAuth`. */
export function actorOf(req: Request): Actor {
  const { userId } = req.session;
  if (userId === undefined) throw new UnauthorizedError();
  return { userId };
}

/**
 * Ownership check for services. Respond 404 instead of 403 when the mere existence of the
 * resource must stay private; otherwise 403 is fine.
 */
export function assertOwner(actor: Actor, resource: { ownerId: number }): void {
  if (resource.ownerId !== actor.userId) throw new ForbiddenError();
}
