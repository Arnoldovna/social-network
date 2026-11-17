import type { MouseEvent } from 'react';

export interface SkipLinkProps {
  /** Id of the `<main>` landmark the layouts render; "main" unless a layout says otherwise. */
  targetId?: string;
  label?: string;
}

/**
 * First focusable element of every page (F-103). Styled by `.skip-link` in styles/utilities.css (its only owner,
 * ADR-0015). Moving focus by script, not only by the fragment, keeps the next Tab inside the main content in every
 * browser and never hands the hash change to the router.
 */
export function SkipLink({ targetId = 'main', label = 'skip to content' }: SkipLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(targetId);
    if (target === null) {
      return;
    }
    event.preventDefault();
    if (!target.hasAttribute('tabindex')) {
      // A landmark is not focusable by default; -1 makes it a focus target without adding a Tab stop.
      target.setAttribute('tabindex', '-1');
    }
    target.focus();
  };

  return (
    <a className="skip-link" href={`#${targetId}`} onClick={handleClick}>
      {label}
    </a>
  );
}
