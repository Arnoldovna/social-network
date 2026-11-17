import { z } from 'zod';

import { UserSummary } from './user.js';

/** `GET /api/presence`: every other online user, public fields only (F-86, F-90). */
export const PresenceResponse = z.strictObject({ items: z.array(UserSummary) });
export type PresenceResponse = z.infer<typeof PresenceResponse>;
