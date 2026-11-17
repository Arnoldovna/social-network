// Request and response contract of the auth routes. The schemas live in `packages/shared` (ADR-0003), so the web
// forms and the API validate with the same rules (F-07–F-09, B-09); this file only re-exports what the feature uses.
export { AuthResponse, LoginBody, RegisterBody, type Me } from '@app/shared';
