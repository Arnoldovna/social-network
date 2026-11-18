import type { ReactNode } from 'react';
import { tokenList } from '../lib/token-list';

import './EmptyState.css';

export interface EmptyStateProps {
  /** What is (not) there, as one sentence, e.g. "No posts yet." (F-56, F-74, F-89). */
  title: string;
  /** What to do next, as one sentence (maw-design-system §10). */
  text?: ReactNode;
  /** At most one text button or link. */
  action?: ReactNode;
  /**
   * `page` (default) stands in for a whole page list and grows to `text-title-l`; `section` sits under a section
   * label (e.g. one of the three `/friends` lists) and stays at `text-title-s`, below the page title.
   */
  size?: 'page' | 'section';
}

/**
 * The maw empty state: a large left-aligned sentence, one line of muted text, one action; no illustration, no
 * centred card (maw-design-system §6). The title is a paragraph, not a heading, so it never breaks the heading
 * order of the page or section it sits in (F-103).
 */
export function EmptyState({ title, text, action, size = 'page' }: EmptyStateProps) {
  const hasText = text !== undefined && text !== null && text !== '';

  return (
    <div className={tokenList('empty-state', size === 'section' && 'empty-state--section')}>
      <p className="empty-state__title">{title}</p>
      {hasText ? <p className="empty-state__text">{text}</p> : null}
      {action ?? null}
    </div>
  );
}
