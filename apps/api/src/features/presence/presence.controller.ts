import type { PresenceResponse } from '@app/shared';

import { actorOf } from '../../shared/auth/guards.js';
import { validate } from '../../shared/http/validate.js';
import type { PresenceService } from './presence.service.js';

/**
 * HTTP <-> service translation only: no SQL, no rules. `GET /api/presence` takes no params, query or body (API.md);
 * it still goes through `validate()` like every handler, with no schema, so query parameters are ignored and never
 * echoed.
 */
export function createPresenceController(service: PresenceService) {
  return {
    list: validate({}, async (_input, req, res) => {
      const body: PresenceResponse = { items: await service.listOnline(actorOf(req)) };
      // Per viewer (self excluded) and stale within seconds: no shared or browser cache may keep it.
      res.set('Cache-Control', 'no-store').json(body);
    }),
  };
}

export type PresenceController = ReturnType<typeof createPresenceController>;
