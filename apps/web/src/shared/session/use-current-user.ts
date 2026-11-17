import type { Me } from '@app/shared';

import { useGetMeQuery } from '../api/me.api';

/**
 * The signed-in user for components in the app area (header, own-wall and own-message checks), read from the `getMe`
 * cache that the app loader filled before any page rendered (ADR-0013). It subscribes to that cache entry, so it
 * re-renders when `updateMe` or the avatar upload write a new `Me` (F-37), and it never fetches when the entry exists.
 *
 * Returns `null` for a visitor and for the moment between a logout or session expiry resetting the API state and the
 * navigation to `/welcome`; callers render nothing user-specific then instead of throwing.
 */
export function useCurrentUser(): Me | null {
  const { data } = useGetMeQuery(undefined);
  return data?.user ?? null;
}
