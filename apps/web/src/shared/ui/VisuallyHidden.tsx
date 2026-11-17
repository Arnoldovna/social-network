import type { ComponentPropsWithoutRef } from 'react';

export type VisuallyHiddenProps = Omit<ComponentPropsWithoutRef<'span'>, 'className'> & {
  /** `div` when it wraps block content, e.g. an `aria-live` region with several sentences. */
  as?: 'span' | 'div';
};

/**
 * Text for assistive technology only: extra context for a control ("for Ada Brennan") or a live-region
 * announcement. Styled by `.visually-hidden` in styles/utilities.css (its only owner, ADR-0015). Every other prop
 * (`id`, `role`, `aria-live`) goes to the element.
 */
export function VisuallyHidden({ as: Element = 'span', ...props }: VisuallyHiddenProps) {
  return <Element {...props} className="visually-hidden" />;
}
