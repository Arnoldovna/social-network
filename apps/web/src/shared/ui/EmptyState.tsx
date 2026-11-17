import type { ReactNode } from 'react';

import './EmptyState.css';

export interface EmptyStateProps {
  /** What is (not) there, as one sentence, e.g. "No posts yet." (F-56, F-74, F-89). */
  title: string;
  /** What to do next, as one sentence (maw-design-system §10). */
  text?: ReactNode;
  /** At most one text button or link. */
  action?: ReactNode;
}

/**
 * The maw empty state: a large left-aligned sentence, one line of muted text, one action; no illustration, no
 * centred card (maw-design-system §6). The title is a paragraph, not a heading, so it never breaks the heading
 * order of the page or section it sits in (F-103).
 */
export function EmptyState({ title, text, action }: EmptyStateProps) {
  const hasText = text !== undefined && text !== null && text !== '';

  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      {hasText ? <p className="empty-state__text">{text}</p> : null}
      {action ?? null}
    </div>
  );
}
