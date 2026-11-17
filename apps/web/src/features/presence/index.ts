import { createElement, Fragment } from 'react';

/*
 * Public API of the presence feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). A stub so the router can
 * import it from the start; the Phase 3 presence unit replaces this body with a re-export of its page and keeps the
 * name.
 */

/** `/online`: everyone else who is online right now (F-86). */
export function OnlinePage() {
  return createElement(
    Fragment,
    null,
    createElement('title', null, "Online · Let's chat!"),
    createElement('h1', null, 'Online'),
  );
}
