import type { ReactNode } from 'react';

import './FieldError.css';

export interface FieldErrorProps {
  /** Referenced by the control's `aria-describedby`. */
  id?: string;
  /** The message; nothing is rendered while it is empty, so the alert fires when an error appears. */
  children?: ReactNode;
}

/**
 * An error message in ink with a 2px error rule on the inline-start side (maw-design-system §4): colour is never the
 * only signal. `role="alert"` announces it as soon as it appears. Used under a field and for form-level errors from
 * a problem+json response (F-31, F-53).
 */
export function FieldError({ id, children }: FieldErrorProps) {
  if (children === undefined || children === null || children === false || children === '') {
    return null;
  }

  return (
    <p id={id} className="field-error" role="alert">
      {children}
    </p>
  );
}
