/**
 * Lowercase repository slug. Used for cookie names (`__Host-social-network.sid`), Redis key prefixes
 * (`social-network:`) and problem `type` URIs (conventions §8, ADR-0004).
 */
export const APP_SLUG = 'social-network';

/**
 * App-scoped cookie name (conventions §8): cookies ignore ports, so the three projects (all on 127.0.0.1) must not
 * share one. `__Host-social-network.<name>` with `Secure` (production), `social-network.<name>` on local http.
 */
export function appCookieName(name: string, secure: boolean): string {
  return secure ? `__Host-${APP_SLUG}.${name}` : `${APP_SLUG}.${name}`;
}
