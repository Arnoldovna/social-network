import { z } from 'zod';

import { Email, FirstName, LastName, Me, Password, PASSWORD_MAX } from './user.js';

/** `POST /api/auth/register` (F-07–F-09, B-09). */
export const RegisterBody = z.object({ firstName: FirstName, lastName: LastName, email: Email, password: Password });
export type RegisterBody = z.infer<typeof RegisterBody>;

/**
 * `POST /api/auth/login`. The password only has to be present: the length policy applies to new passwords, and a
 * login must not reveal which rule a stored password would fail (F-15).
 */
export const LoginBody = z.object({ email: Email, password: z.string().min(1).max(PASSWORD_MAX) });
export type LoginBody = z.infer<typeof LoginBody>;

/** Register and login answer the user and the CSRF token bound to the regenerated session. */
export const AuthResponse = z.strictObject({ user: Me, csrfToken: z.string() });
export type AuthResponse = z.infer<typeof AuthResponse>;

/** `GET /api/csrf-token`. */
export const CsrfTokenResponse = z.strictObject({ token: z.string() });
export type CsrfTokenResponse = z.infer<typeof CsrfTokenResponse>;
