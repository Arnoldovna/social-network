/** `/users/:id`, the profile page of another user (F-40); every link to a person points here (B-93). */
export function profilePath(userId: number): string {
  return `/users/${String(userId)}`;
}
