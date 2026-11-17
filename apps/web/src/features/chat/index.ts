import { createElement, Fragment } from 'react';

/*
 * Public API of the chat feature, fixed in Phase 1c (BUILD-ORDER "Web feature exports"). A stub so the router can
 * import it from the start; the Phase 3 chat unit replaces this body with a re-export of its page and keeps the name.
 */

/** `/chat`: the global chat room (F-76). */
export function ChatPage() {
  return createElement(
    Fragment,
    null,
    createElement('title', null, "Chat · Let's chat!"),
    createElement('h1', null, 'Chat'),
  );
}
