import { pipeline } from 'node:stream/promises';

import { IdParams, type MeResponse } from '@app/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { actorOf } from '../../shared/auth/guards.js';
import { validate } from '../../shared/http/validate.js';
import { sniffImage } from '../../shared/uploads/upload.js';
import type { AvatarsService } from './avatars.service.js';

/**
 * `GET /api/users/:id/avatar?v=<uuid>` (API.md): `v` is the cache buster `avatarUrl` carries. It never selects an
 * object, it only decides the caching headers. Server-internal: the web client never builds this URL itself, it uses
 * the `avatarUrl` of a DTO as is.
 */
export const AvatarQuery = z.object({
  v: z
    .string()
    .regex(/^[0-9a-f-]{36}$/)
    .optional(),
});

/** One year: the response for the current version can never change, because a new upload gets a new uuid. */
export const IMMUTABLE_CACHE_CONTROL = 'private, max-age=31536000, immutable';
/** An outdated or missing `v`: the client must revalidate (a cheap 304 while the avatar is unchanged). */
export const REVALIDATE_CACHE_CONTROL = 'private, no-cache';

function setCacheHeaders(res: Response, version: string, requestedVersion: string | undefined): void {
  res.setHeader('ETag', `"${version}"`); // a strong validator: one uuid is one immutable object
  res.setHeader('Cache-Control', requestedVersion === version ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL);
}

/** HTTP <-> service translation only: no SQL, no business rules. */
export function createAvatarsController(service: AvatarsService) {
  return {
    /** `PUT /api/me/avatar`: the file is checked by its magic bytes before the service sees it (B-29, B-33). */
    upload: async (req: Request, res: Response): Promise<void> => {
      const image = await sniffImage(req.file);
      const body: MeResponse = { user: await service.replaceAvatar(actorOf(req), image) };
      res.json(body);
    },

    /**
     * `GET /api/users/:id/avatar`: the user's current object, whatever `v` says (ADR-0010 §8). The conditional
     * request is answered before storage is touched, so a revalidation costs one PK lookup.
     */
    show: validate({ params: IdParams, query: AvatarQuery }, async ({ params, query }, req, res) => {
      const current = await service.findCurrent(params.id);
      setCacheHeaders(res, current.version, query.v);
      if (req.fresh) {
        res.status(304).end();
        return;
      }

      // If this throws, the error handler drops the caching headers set above (shared/http/problem.ts).
      const image = await service.open(params.id, current);
      if (image.version !== current.version) setCacheHeaders(res, image.version, query.v);
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Content-Disposition', 'inline');
      // `X-Content-Type-Options: nosniff` comes from helmet on every response.
      if (req.method === 'HEAD') {
        // `router.get` answers HEAD too. The object is still opened, so HEAD gets the same status and headers as GET
        // (a missing object is the same 404), but its body is released instead of being read from storage only to be
        // thrown away.
        image.body.destroy();
        res.end();
        return;
      }
      await pipeline(image.body, res);
    }),
  };
}

export type AvatarsController = ReturnType<typeof createAvatarsController>;
