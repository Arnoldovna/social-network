/** The about page for visitors, in the welcome area (F-97). */
export const WELCOME_ABOUT_PATH = '/welcome/about';

/** The same about page for members, inside the app area (the footer's "about"; the welcome area redirects members). */
export const ABOUT_PATH = '/about';

/** `/users/:id`, the profile page of another user (F-40); every link to a person points here (B-93). */
export function profilePath(userId: number): string {
  return `/users/${String(userId)}`;
}
