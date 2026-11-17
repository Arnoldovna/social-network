/**
 * `true` when no element holds the focus any more: it sits on the document, or on an element that was just removed
 * (a row or button an action made disappear). Callers then move it somewhere useful instead of leaving keyboard users
 * at the top of the page.
 */
export function hasLostFocus(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}
