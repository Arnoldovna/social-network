/*
 * Public API of the auth feature (BUILD-ORDER "Web feature exports fixed in Phase 1c"): the three welcome pages for
 * the router, the brand panel for `WelcomeLayout` and the logout button for the header. Everything else (the API
 * endpoints, the form shell) stays internal; other features and the app shell import only from here.
 */

/** `/welcome`: the registration form (F-06). */
export { RegisterPage } from './pages/RegisterPage';

/** `/welcome/login`: the login form; `?reason=expired` shows the session-expired message (F-14, F-22). */
export { LoginPage } from './pages/LoginPage';

/** `/welcome/about`: about the project (F-97). */
export { AboutPage } from './pages/AboutPage';

/** The rose brand panel beside the welcome forms (F-95). */
export { BrandPanel } from './components/BrandPanel';

/** "log out" in the header (F-20). */
export { LogoutButton } from './components/LogoutButton';
